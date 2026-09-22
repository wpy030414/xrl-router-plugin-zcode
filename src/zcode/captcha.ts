/**
 * zcode/captcha.ts — 无痕验证管理器。
 *
 * 职责：为 Coding Plan（JWT）请求提供 `X-Aliyun-Captcha-Verify-Param`。
 *
 *  1. **场景配置**：优先问 `zcode.z.ai/api/v1/client/configs` 要 sceneId/region/prefix，
 *     失败则回退环境变量 / 内置默认值（远端接口不保证可用，必须能降级）。
 *  2. **缓存**：求得的 verifyParam 在 TTL 内复用（默认 45s），避免每个请求都起子进程。
 *  3. **并发去重**：同一时刻只跑一个求解进程，其余调用共享同一个 Promise。
 *  4. **重试**：单次求解偶发失败时自动重试（ZCODE_CAPTCHA_RETRIES）。
 *
 * 上游返回「验证码失效」时由调用方调 `invalidate()` 让下一次请求重新求解。
 */

import { settings } from '../config';
import { solveVerifyParam, type SolverParams } from './solver';

const CONFIG_TIMEOUT_MS = 5_000;
/** 远端配置拉取失败后的负缓存时长，避免每个请求都等一次超时 */
const CONFIG_FAILURE_TTL_MS = 60_000;

function envDefaultParams(): SolverParams {
  return {
    sceneId: settings.captcha.sceneId,
    region: settings.captcha.region,
    prefix: settings.captcha.prefix,
  };
}

class CaptchaManager {
  private cachedParam: string | null = null;
  private cachedAt = 0;

  /** 进行中的求解（并发去重：后来者直接复用） */
  private inflight: Promise<string> | null = null;

  private cachedConfig: SolverParams | null = null;
  private cachedConfigAt = 0;
  private cachedConfigTtl = 0;

  /**
   * 取一个可用的 verifyParam。失败抛错（调用方负责映射成 502）。
   */
  async getVerifyParam(): Promise<string> {
    const now = Date.now();
    if (this.cachedParam && now - this.cachedAt < settings.captcha.cacheTtlMs) {
      return this.cachedParam;
    }
    if (this.inflight) return this.inflight;

    this.inflight = this.solve()
      .then((param) => {
        this.cachedParam = param;
        this.cachedAt = Date.now();
        return param;
      })
      .finally(() => {
        this.inflight = null;
      });

    return this.inflight;
  }

  /** 标记当前缓存失效，下一次请求重新求解 */
  invalidate(): void {
    this.cachedParam = null;
    this.cachedAt = 0;
  }

  /** 仅供测试 / 诊断 */
  snapshot(): { hasCachedParam: boolean; ageMs: number; inflight: boolean } {
    return {
      hasCachedParam: this.cachedParam !== null,
      ageMs: this.cachedParam ? Date.now() - this.cachedAt : -1,
      inflight: this.inflight !== null,
    };
  }

  private async solve(): Promise<string> {
    const params = await this.fetchSceneConfig();

    let lastError = '';
    for (let attempt = 1; attempt <= settings.captcha.retries; attempt++) {
      try {
        const param = await solveVerifyParam(params);
        if (param) return param;
        lastError = '求解器未返回 VERIFY_PARAM';
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
      }
      console.warn(
        `[captcha] 第 ${attempt}/${settings.captcha.retries} 次求解未果：${lastError}`,
      );
    }

    throw new Error(`无痕验证求解失败（已重试 ${settings.captcha.retries} 次）：${lastError}`);
  }

  /**
   * 拉取验证码场景配置，失败回退内置默认值。
   * 成功与失败都写缓存——远端接口不可用时不该让每个请求都陪一次 5s 超时。
   */
  private async fetchSceneConfig(): Promise<SolverParams> {
    const now = Date.now();
    if (this.cachedConfig && now - this.cachedConfigAt < this.cachedConfigTtl) {
      return this.cachedConfig;
    }

    if (process.env.ZCODE_CAPTCHA_REMOTE === '0') {
      const params = envDefaultParams();
      this.cacheConfig(params, settings.captcha.configCacheTtlMs);
      return params;
    }

    try {
      const url = `${settings.captchaConfigUrl}?app_version=${encodeURIComponent(
        settings.upstream.appVersion,
      )}&platform=${encodeURIComponent(process.platform)}`;
      const resp = await fetch(url, { signal: AbortSignal.timeout(CONFIG_TIMEOUT_MS) });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);

      const payload = (await resp.json()) as any;
      const captcha = payload?.data?.configs?.captcha;
      const sceneId = captcha?.sceneId;
      const region = captcha?.region;
      const prefix = captcha?.prefix;

      if (!sceneId || !region || !prefix) throw new Error('响应中缺少 captcha 场景字段');

      const params: SolverParams = {
        sceneId: String(sceneId),
        region: String(region),
        prefix: String(prefix),
      };
      this.cacheConfig(params, settings.captcha.configCacheTtlMs);
      return params;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`[captcha] 拉取场景配置失败（${message}），回退内置默认值`);
      const fallback = envDefaultParams();
      this.cacheConfig(fallback, CONFIG_FAILURE_TTL_MS);
      return fallback;
    }
  }

  private cacheConfig(params: SolverParams, ttlMs: number): void {
    this.cachedConfig = params;
    this.cachedConfigAt = Date.now();
    this.cachedConfigTtl = ttlMs;
  }
}

export const captchaManager = new CaptchaManager();
