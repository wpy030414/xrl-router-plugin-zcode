/**
 * captcha/solver.cjs — 阿里云「无痕验证」求解器（无浏览器：Node + jsdom）。
 *
 * 来源：移植自社区项目 zcode2api（AGPL-3.0），并综合 SQMY-dor/zcode2api 的硬化
 *       指纹补丁与 TriDefender/zcode-api 的 cookie priming 经验。
 *       见 docs/reverse/ZCODE_REVERSE.md 第 3、6.5、6.7 节。
 *
 * 原理：在 jsdom 里加载阿里云官方 AliyunCaptcha.js，用桩件补齐 SDK 依赖的浏览器
 *       API，调用 startTracelessVerification 后由 SDK 回调吐出 verifyParam。
 *
 * 用法：  node captcha/solver.cjs <sceneId> <region> <prefix> [--cookie <jar.json>]
 * 成功：  stdout 打印一行 `VERIFY_PARAM=<param>`，退出码 0
 * 失败：  退出码非 0（3=异常 4=SDK fail 5=SDK onError 2=超时）
 *
 * 关键工程经验（都来自实测，缺一就可能 F001）：
 *   1. **确定性指纹**：所有 navigator/screen/WebGL 值必须固定、绝不逐次随机——
 *      阿里云风控会跨请求关联指纹稳定性，随机化本身即触发 F001。
 *   2. **navigator 指纹组是必要条件**：UA/appVersion/vendor/deviceMemory/
 *      maxTouchPoints/plugins/mimeTypes 缺一都可能被识别为 jsdom。
 *   3. **cookie priming**：先 fetch zcode.z.ai 拿 acw_tc/cdn_sec_tc 等边缘 cookie
 *      注入 jsdom 会话（由调用方通过 --cookie 传入，见 captcha.ts）。
 *   4. **fail 回调兜底**：SDK 的 fail 回调也可能携带可用 captchaVerifyParam，
 *      不能只认 success。
 *   5. jsdom 需 runScripts:'dangerously' 跑混淆 SDK，故始终以子进程运行。
 */

const { JSDOM, VirtualConsole } = require('jsdom');

const argv = process.argv.slice(2);
const SCENE = argv[0] || '11xygtvd';
const REGION = argv[1] || 'cn'; // 上游 configs 公布值；社区旧文档的 sgp 已过期
const PREFIX = argv[2] || 'no8xfe';

// --cookie <path>：cookie priming 用的 cookieJar 快照（JSON，tough-cookie 序列化格式）
let cookieJarPath = null;
const cookieIdx = argv.indexOf('--cookie');
if (cookieIdx >= 0 && argv[cookieIdx + 1]) cookieJarPath = argv[cookieIdx + 1];

const EXIT = { OK: 0, EXCEPTION: 3, SDK_FAIL: 4, SDK_ERROR: 5, TIMEOUT: 2 };
const OVERALL_TIMEOUT_MS = 25_000;
const LOAD_TIMEOUT_MS = 12_000;

const virtualConsole = new VirtualConsole(); // 静默 jsdom 噪声

const html = `<!DOCTYPE html><html><head></head><body>
<div id="cap"></div><button id="btn"></button>
<script src="https://o.alicdn.com/captcha-frontend/aliyunCaptcha/AliyunCaptcha.js"></script>
</body></html>`;

// ── 确定性真机指纹（固定值，绝不随机；见文件头经验 1）─────────────────────────
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const WEBGL_VENDOR = 'Google Inc. (Intel)';
const WEBGL_RENDERER =
  'ANGLE (Intel, Intel(R) UHD Graphics 630 Direct3D11 vs_5_0 ps_5_0, D3D11)';

const dom = new JSDOM(html, {
  url: 'https://zcode.z.ai/',
  runScripts: 'dangerously',
  resources: 'usable',
  pretendToBeVisual: true,
  virtualConsole,
  // 真实 Chrome UA（jsdom 默认 UA 带 "jsdom" 字样，风控一眼识别）
  userAgent: UA,
  cookieJar: undefined, // 下面按需注入
  beforeParse(window) {
    // ── navigator 指纹组（经验 2：必要条件）──
    const nav = window.navigator;
    const def = (obj, prop, value) => {
      try {
        Object.defineProperty(obj, prop, { get: () => value, configurable: true });
      } catch {
        /* 某些属性不可覆盖，忽略 */
      }
    };
    def(nav, 'userAgent', UA);
    def(nav, 'appVersion', UA.replace('Mozilla/', ''));
    def(nav, 'platform', 'Win32');
    def(nav, 'vendor', 'Google Inc.');
    def(nav, 'webdriver', false);
    def(nav, 'languages', ['zh-CN', 'zh', 'en']);
    def(nav, 'language', 'zh-CN');
    def(nav, 'hardwareConcurrency', 8);
    def(nav, 'deviceMemory', 8);
    def(nav, 'maxTouchPoints', 0);
    try {
      nav.plugins = [1, 2, 3, 4, 5];
      nav.mimeTypes = [1, 2];
    } catch {
      /* 只读则忽略 */
    }

    // ── window 组 ──
    window.chrome = { runtime: {}, app: { isInstalled: false }, csi: () => {}, loadTimes: () => {} };
    def(window, 'devicePixelRatio', 1);
    window.requestIdleCallback =
      window.requestIdleCallback ||
      ((cb) => setTimeout(() => cb({ didTimeout: false, timeRemaining: () => 50 }), 1));
    def(window.screen, 'width', 1920);
    def(window.screen, 'height', 1080);
    def(window.screen, 'availWidth', 1920);
    def(window.screen, 'availHeight', 1040);
    def(window.screen, 'colorDepth', 24);
    def(window.screen, 'pixelDepth', 24);

    window.matchMedia = () => ({
      matches: false,
      media: '',
      onchange: null,
      addListener() {},
      removeListener() {},
      addEventListener() {},
      removeEventListener() {},
      dispatchEvent() {
        return false;
      },
    });

    // ── canvas / WebGL 指纹桩（确定性 ANGLE 串）──
    const proto = window.HTMLCanvasElement.prototype;
    proto.getContext = function (type) {
      if (/webgl/i.test(type)) {
        return {
          canvas: this,
          getParameter: (p) =>
            ({ 0x1f00: WEBGL_VENDOR, 0x1f01: WEBGL_RENDERER }[p] || 'Intel'),
          getExtension: () => null,
          getSupportedExtensions: () => ['WEBGL_debug_renderer_info'],
          getContextAttributes: () => ({}),
          getShaderPrecisionFormat: () => ({ precision: 23, rangeMin: 127, rangeMax: 127 }),
        };
      }
      return {
        canvas: this,
        fillRect() {}, clearRect() {}, putImageData() {}, setTransform() {},
        transform() {}, drawImage() {}, save() {}, restore() {}, beginPath() {},
        moveTo() {}, lineTo() {}, bezierCurveTo() {}, quadraticCurveTo() {},
        closePath() {}, clip() {}, stroke() {}, fill() {}, arc() {}, rect() {},
        ellipse() {}, translate() {}, scale() {}, rotate() {}, fillText() {},
        strokeText() {},
        getImageData: (x, y, w = 1, h = 1) => ({ data: new Uint8ClampedArray(w * h * 4) }),
        createImageData: (w = 1, h = 1) => ({ data: new Uint8ClampedArray(w * h * 4) }),
        measureText: (t) => ({ width: ('' + t).length * 8 }),
        createLinearGradient: () => ({ addColorStop() {} }),
        createRadialGradient: () => ({ addColorStop() {} }),
        createPattern: () => ({}),
        isPointInPath: () => false,
        font: '10px sans-serif',
        textBaseline: 'alphabetic',
        textAlign: 'start',
        fillStyle: '#000',
        strokeStyle: '#000',
        globalAlpha: 1,
        lineWidth: 1,
        shadowBlur: 0,
        shadowColor: '',
      };
    };
    proto.toDataURL = () =>
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    proto.toBlob = (cb) => cb && cb(null);

    // ── Worker / OffscreenCanvas 桩 ──
    window.Worker = class {
      postMessage() {}
      terminate() {}
      addEventListener() {}
      removeEventListener() {}
      onmessage = null;
      onerror = null;
    };
    window.OffscreenCanvas =
      window.OffscreenCanvas ||
      class {
        constructor(w, h) {
          this.width = w;
          this.height = h;
        }
        getContext() {
          return proto.getContext.call(this);
        }
      };
  },
});

const { window } = dom;

// ── cookie priming（经验 3）：把预取的边缘 cookie 注入 jsdom 会话 ──
if (cookieJarPath) {
  try {
    const fs = require('node:fs');
    const snapshot = JSON.parse(fs.readFileSync(cookieJarPath, 'utf8'));
    const { CookieJar } = require('tough-cookie');
    const jar = CookieJar.fromJSON(snapshot);
    // jsdom 内部用 tough-cookie 的 jar；替换后需让后续请求带上
    dom._cookieJar = jar;
  } catch {
    /* priming 失败不阻断，退化为无 cookie 求解 */
  }
}

function waitFor(cond, timeoutMs) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      let ok = false;
      try {
        ok = cond();
      } catch {
        /* 条件抛错视为未就绪 */
      }
      if (ok) {
        clearInterval(timer);
        resolve();
      } else if (Date.now() - started > timeoutMs) {
        clearInterval(timer);
        reject(new Error('timeout'));
      }
    }, 80);
  });
}

/** 从 SDK 回调对象里尽力提取 verifyParam（经验 4：fail 回调也可能带） */
function extractParam(x) {
  if (typeof x === 'string' && x) return x;
  if (x && typeof x === 'object') {
    const p = x.captchaVerifyParam || x.CaptchaVerifyParam || x.verifyParam;
    if (typeof p === 'string' && p) return p;
  }
  return null;
}

(async () => {
  await waitFor(() => typeof window.initAliyunCaptcha === 'function', LOAD_TIMEOUT_MS);

  window.initAliyunCaptcha({
    SceneId: SCENE,
    mode: 'popup',
    region: REGION,
    prefix: PREFIX,
    element: '#cap',
    button: '#btn',
    captchaLogoImg: '',
    showErrorTip: false,
    getInstance: (instance) => {
      try {
        (instance.startTracelessVerification || instance.show).call(instance);
      } catch {
        /* SDK 内部异常由超时兜底 */
      }
    },
    success: (param) => {
      const p = extractParam(param);
      if (p) {
        console.log('VERIFY_PARAM=' + p);
        process.exit(EXIT.OK);
      }
      process.exit(EXIT.SDK_FAIL);
    },
    // fail 回调也可能携带可用 param（verifyResult:false 但 param 仍可被上游接受）
    fail: (e) => {
      const p = extractParam(e);
      if (p) {
        console.log('VERIFY_PARAM=' + p);
        process.exit(EXIT.OK);
      }
      // 把 verifyCode 打到 stderr 供上层诊断（F001 等）
      try {
        console.error('SOLVER_FAIL=' + JSON.stringify(e));
      } catch {
        /* ignore */
      }
      process.exit(EXIT.SDK_FAIL);
    },
    onError: () => process.exit(EXIT.SDK_ERROR),
  });

  setTimeout(() => process.exit(EXIT.TIMEOUT), OVERALL_TIMEOUT_MS);
})().catch(() => process.exit(EXIT.EXCEPTION));
