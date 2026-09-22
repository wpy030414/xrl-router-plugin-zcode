/**
 * captcha/solver.cjs — 阿里云「无痕验证」求解器（无浏览器：Node + jsdom）。
 *
 * 来源：移植自社区项目 zcode2api 的 captcha_node/solver.js（AGPL-3.0），
 *       见 docs/reverse/ZCODE_REVERSE.md 的致谢章节。改动包括：注释、退出码常量、
 *       以及去掉多余日志。
 *
 * 原理：在 jsdom 里加载阿里云官方的 AliyunCaptcha.js，用桩件补齐 SDK 依赖的
 *       浏览器 API（matchMedia / canvas / WebGL / Worker / OffscreenCanvas），
 *       调用 startTracelessVerification 后由 SDK 回调吐出 verifyParam。
 *
 * 用法：  node captcha/solver.cjs <sceneId> <region> <prefix>
 * 成功：  stdout 打印一行 `VERIFY_PARAM=<param>`，退出码 0
 * 失败：  退出码非 0（3=异常 4=SDK fail 5=SDK onError 2=超时）
 *
 * 注意：jsdom 需要 `runScripts: 'dangerously'` 才能跑混淆后的 SDK，
 *       所以本脚本始终以**子进程**方式被调用，崩溃不波及插件主进程。
 */

const { JSDOM, VirtualConsole } = require('jsdom');

const SCENE = process.argv[2] || '11xygtvd';
const REGION = process.argv[3] || 'sgp';
const PREFIX = process.argv[4] || 'no8xfe';

const EXIT = {
  OK: 0,
  EXCEPTION: 3,
  SDK_FAIL: 4,
  SDK_ERROR: 5,
  TIMEOUT: 2,
};

const OVERALL_TIMEOUT_MS = 25_000;
const LOAD_TIMEOUT_MS = 12_000;

const virtualConsole = new VirtualConsole(); // 静默 jsdom 噪声

const html = `<!DOCTYPE html><html><head></head><body>
<div id="cap"></div><button id="btn"></button>
<script src="https://o.alicdn.com/captcha-frontend/aliyunCaptcha/AliyunCaptcha.js"></script>
</body></html>`;

const dom = new JSDOM(html, {
  url: 'https://zcode.z.ai/',
  runScripts: 'dangerously',
  resources: 'usable',
  pretendToBeVisual: true,
  virtualConsole,
  beforeParse(window) {
    // matchMedia 桩
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

    // canvas / WebGL 指纹桩：返回稳定值即可（SDK 只做指纹采集，不做渲染）
    const proto = window.HTMLCanvasElement.prototype;
    proto.getContext = function (type) {
      if (/webgl/i.test(type)) {
        return {
          canvas: this,
          getParameter: () => 'Intel',
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

    // Worker 桩
    window.Worker = class {
      postMessage() {}
      terminate() {}
      addEventListener() {}
      removeEventListener() {}
      onmessage = null;
      onerror = null;
    };

    // OffscreenCanvas 桩
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

function waitFor(cond, timeoutMs) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      let ok = false;
      try {
        ok = cond();
      } catch {
        /* 条件本身抛错视为未就绪 */
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
        /* SDK 内部异常由下面的超时兜底 */
      }
    },
    success: (param) => {
      console.log('VERIFY_PARAM=' + param);
      process.exit(EXIT.OK);
    },
    fail: () => process.exit(EXIT.SDK_FAIL),
    onError: () => process.exit(EXIT.SDK_ERROR),
  });

  setTimeout(() => process.exit(EXIT.TIMEOUT), OVERALL_TIMEOUT_MS);
})().catch(() => process.exit(EXIT.EXCEPTION));
