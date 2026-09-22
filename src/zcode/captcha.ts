/**
 * zcode/captcha.ts — 无痕验证管理器。
 *
 * 职责：为 Coding Plan（JWT）请求提供 `X-Aliyun-Captcha-Verify-Param`。
 *
 *  1. **场景配置**：来自 `configs.ts`（远端 client/configs → 环境变量 → 内置默认值）
 *  2. **缓存**：求得的 verifyParam 在 TTL 内复用（默认 45s），避免每个请求都起子进程
 *  3. **并发去重**：同一时刻只跑一个求解进程，其余调用共享同一个 Promise
 *  4. **重试**：单次求解偶发失败时自动重试（ZCODE_CAPTCHA_RETRIES）
 *
 * 上游返回「验证码失效」时由调用方调 `invalidate()` 让下一次请求重新求解。
 */

import { settings } from '../config';
import { fetchClientConfigs } from './configs';
import { solveVerifyParam, type SolverParams } from './solver';

/** 远端配置拿不到时的兜底场景参数 */
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

  /** 标记当前缓存失效，下一次请求重新求解（场景配置缓存不受影响） */
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
    const params = await this.resolveSceneParams();

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

  /** 场景参数：远端配置优先，拿不到就用环境变量 / 内置默认值 */
  private async resolveSceneParams(): Promise<SolverParams> {
    const configs = await fetchClientConfigs();
    if (configs?.captcha) return configs.captcha;
    return envDefaultParams();
  }
}

export const captchaManager = new CaptchaManager();
