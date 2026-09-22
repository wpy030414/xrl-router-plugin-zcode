/**
 * zcode/configs.ts — ZCode 客户端配置接口（`/api/v1/client/configs`）的读取与解析。
 *
 * 这一个接口同时提供两样东西：
 *   1. **无痕验证场景参数**（`data.configs.captcha`）—— captcha.ts 用它
 *   2. **上游权威模型清单**（`data.builtinModels` / `data.providers[].models`）—— 启动时自动发现
 *
 * ⚠️ 实测要点：**该接口不能带任何查询参数**。带 `?app_version=…&platform=…` 时
 * 上游返回 `{"code":3001,"msg":"parameter error"}`；不带参数才返回完整配置。
 * （社区项目 zcode2api 用的是带参形式，已失效。）
 *
 * 结果缓存 `ZCODE_CAPTCHA_CONFIG_CACHE_TTL`（默认 600s）；失败做 60s 负缓存，
 * 避免每个请求都陪一次超时。
 */

import { settings } from '../config';
import { type ModelSpec } from './models';

const FETCH_TIMEOUT_MS = 5_000;
const FAILURE_TTL_MS = 60_000;

export interface CaptchaScene {
  sceneId: string;
  region: string;
  prefix: string;
}

export interface ClientConfigs {
  /** 无痕验证场景参数；接口没给则为 null（调用方回退环境变量默认值） */
  captcha: CaptchaScene | null;
  /** 上游公布的模型清单（去重保序）；拿不到则为空数组 */
  models: ModelSpec[];
}

let cached: ClientConfigs | null = null;
let cachedAt = 0;
let cachedTtl = 0;
let inflight: Promise<ClientConfigs | null> | null = null;

/**
 * 抽出模型清单。
 *
 * 优先只用 `builtinModels`——它是上游针对**当前套餐**公布的推荐清单；
 * `providers[].models` 是「自带 API Key」通道的清单，混进来会注册出
 * 套餐里其实用不了的模型。仅当 `builtinModels` 缺失时才回退到 providers。
 */
function extractModels(data: any): ModelSpec[] {
  const seen = new Set<string>();
  const out: ModelSpec[] = [];

  const push = (id: unknown): void => {
    const modelId = typeof id === 'string' ? id.trim() : '';
    if (!modelId || seen.has(modelId)) return;
    seen.add(modelId);
    out.push({ modelId, displayName: modelId });
  };

  if (Array.isArray(data?.builtinModels)) {
    for (const m of data.builtinModels) push(m?.modelId);
  }
  if (out.length > 0) return out;

  if (Array.isArray(data?.providers)) {
    for (const p of data.providers) {
      if (!Array.isArray(p?.models)) continue;
      for (const m of p.models) push(m?.modelId);
    }
  }
  return out;
}

function parseCaptcha(data: any): CaptchaScene | null {
  const captcha = data?.configs?.captcha;
  const sceneId = captcha?.sceneId;
  const region = captcha?.region;
  const prefix = captcha?.prefix;
  if (!sceneId || !region || !prefix) return null;
  return { sceneId: String(sceneId), region: String(region), prefix: String(prefix) };
}

/**
 * 拉取客户端配置（带缓存与并发去重）。失败返回 null。
 */
export async function fetchClientConfigs(): Promise<ClientConfigs | null> {
  const now = Date.now();
  if (cached && now - cachedAt < cachedTtl) return cached;
  if (inflight) return inflight;

  if (process.env.ZCODE_CAPTCHA_REMOTE === '0') {
    // 显式禁用远端配置：只保留环境变量默认值，不再请求
    cacheResult({ captcha: null, models: [] }, settings.captcha.configCacheTtlMs);
    return cached;
  }

  inflight = (async () => {
    try {
      const resp = await fetch(settings.captchaConfigUrl, {
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);

      const payload = (await resp.json()) as any;
      const data = payload?.data;
      if (!data) throw new Error('响应缺少 data 字段');

      const result: ClientConfigs = {
        captcha: parseCaptcha(data),
        models: extractModels(data),
      };
      cacheResult(result, settings.captcha.configCacheTtlMs);
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`[configs] 拉取客户端配置失败（${message}），将回退内置默认值`);
      cacheResult({ captcha: null, models: [] }, FAILURE_TTL_MS);
      return cached;
    } finally {
      inflight = null;
    }
  })();

  return inflight;
}

function cacheResult(result: ClientConfigs, ttlMs: number): void {
  cached = result;
  cachedAt = Date.now();
  cachedTtl = ttlMs;
}

/** 仅测试用：清空缓存 */
export function resetClientConfigsCache(): void {
  cached = null;
  cachedAt = 0;
  cachedTtl = 0;
}
