/**
 * zcode/client.ts — 转发 Anthropic Messages 请求到 ZCode 上游。
 *
 * 为什么本模块不做任何协议转换：xrl-router 注册供应商时我们报的 `kind` 是
 * `messages`，router 的 IR 层（`api/proxy/ir/`）已经把客户端三种协议
 * （messages / chat_completions / responses）统一转成 Anthropic Messages 再发过来，
 * 返回的 SSE 也由 router 按 messages 格式反解。所以这里**原样透传字节流**即可。
 *
 * 错误码契约（重要）：router 的密钥池按状态码判活
 * （`api/proxy/key_rotation.rs`：401/403 → 标红；402/429 → 标黄；5xx → 不动），
 * 因此：
 *  - 上游的 401/402/403/429 → **原样透传**，让 router 去轮换下一把密钥
 *  - 无痕验证失效 → 内部刷新重试，仍失败返回 **502**（插件侧故障，不该污染密钥健康度）
 */

import type { Request as ExpressRequest, Response as ExpressResponse } from 'express';

import { settings } from '../config';
import { aggregateAnthropicStream } from './aggregate';
import {
  anthropicErrorBody,
  buildUpstreamRequest,
  classifySecret,
  extractSecret,
  isCaptchaRejection,
  type SecretKind,
} from './auth';
import { captchaManager } from './captcha';
import { canonicalModelId } from './models';

/**
 * 同一请求内「验证码失效 → 刷新 → 重试」的次数上限。
 * 注意与 `settings.captcha.retries` 的区别：后者是单次求解内部的重试。
 */
export const MAX_CAPTCHA_REFRESH = 3;

function isAbortError(err: unknown): boolean {
  const name = (err as { name?: string } | null)?.name;
  return name === 'AbortError' || name === 'TimeoutError';
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** 等待 socket 缓冲排空；连接关闭也 resolve，避免挂死 */
function waitDrain(res: ExpressResponse): Promise<void> {
  return new Promise((resolve) => {
    const done = (): void => {
      res.removeListener('drain', done);
      res.removeListener('close', done);
      resolve();
    };
    res.once('drain', done);
    res.once('close', done);
  });
}

/** 流式透传上游字节流（不做任何解析） */
async function pipeStream(
  upstream: globalThis.Response,
  res: ExpressResponse,
): Promise<void> {
  res.status(upstream.status);
  res.setHeader('Content-Type', upstream.headers.get('content-type') || 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  if (res.socket) res.socket.setNoDelay(true);

  if (!upstream.body) {
    res.end();
    return;
  }

  const reader = upstream.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (res.writableEnded) break;
      if (!res.write(Buffer.from(value))) await waitDrain(res);
    }
  } catch (err) {
    if (!isAbortError(err)) console.error(`[zcode] 流传输中断：${errorMessage(err)}`);
  } finally {
    try {
      reader.releaseLock();
    } catch {
      /* 已经 release 过则忽略 */
    }
    if (!res.writableEnded) res.end();
  }
}

/** 非流式客户端：上游仍是 SSE，聚合后一次性返回 */
async function sendAggregated(
  upstream: globalThis.Response,
  res: ExpressResponse,
): Promise<void> {
  try {
    if (!upstream.body) {
      if (!res.headersSent) res.status(502).json(anthropicErrorBody('api_error', '上游返回空响应体'));
      return;
    }
    const message = await aggregateAnthropicStream(upstream.body);
    if (!res.headersSent) res.json(message);
  } catch (err) {
    const msg = errorMessage(err);
    console.error(`[zcode] 非流式聚合失败：${msg}`);
    if (!res.headersSent) res.status(502).json(anthropicErrorBody('api_error', `聚合上游响应失败：${msg}`));
  } finally {
    if (!res.writableEnded) res.end();
  }
}

/**
 * 处理一次 `POST /v1/messages`。
 */
export async function forwardMessages(
  req: ExpressRequest,
  res: ExpressResponse,
): Promise<void> {
  const secret = extractSecret(req.headers as Record<string, string | string[] | undefined>);
  if (!secret) {
    res
      .status(401)
      .json(
        anthropicErrorBody(
          'authentication_error',
          '缺少凭证：请通过 x-api-key 或 Authorization: Bearer 提供 ZCode JWT / API Key',
        ),
      );
    return;
  }

  const kind: SecretKind = classifySecret(secret);
  const body: Record<string, unknown> =
    req.body && typeof req.body === 'object' && !Array.isArray(req.body)
      ? (req.body as Record<string, unknown>)
      : {};

  const model = canonicalModelId(String(body.model ?? ''), settings.models);
  const wantsStream = body.stream === true;
  // 上游一律按流式请求，非流式客户端由我们聚合（同 zcode2api / qwenwork 的做法）
  const upstreamBody = JSON.stringify({ ...body, model, stream: true });

  const abort = new AbortController();
  const onClientClose = (): void => {
    if (!res.writableEnded) abort.abort();
  };
  res.on('close', onClientClose);

  const maxAttempts = kind === 'jwt' ? MAX_CAPTCHA_REFRESH : 1;

  try {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      let verifyParam: string | null = null;
      if (kind === 'jwt') {
        try {
          verifyParam = await captchaManager.getVerifyParam();
        } catch (err) {
          const msg = errorMessage(err);
          console.error(`[zcode] 无痕验证不可用：${msg}`);
          if (!res.headersSent) {
            res.status(502).json(anthropicErrorBody('captcha_error', `无痕验证不可用：${msg}`));
          }
          return;
        }
      }

      const target = buildUpstreamRequest(secret, kind, verifyParam);

      let upstream: globalThis.Response;
      try {
        upstream = await fetch(target.url, {
          method: 'POST',
          headers: target.headers,
          body: upstreamBody,
          signal: abort.signal,
        });
      } catch (err) {
        if (isAbortError(err)) {
          if (!res.writableEnded) res.end();
          return;
        }
        const msg = errorMessage(err);
        console.error(`[zcode] 上游连接失败：${msg}`);
        if (!res.headersSent) {
          res.status(502).json(anthropicErrorBody('api_error', `无法连接上游：${msg}`));
        }
        return;
      }

      if (!upstream.ok) {
        const text = await upstream.text().catch(() => '');

        // 验证码失效：刷新后重试同一个密钥（不是密钥的问题，不该轮换）
        if (kind === 'jwt' && isCaptchaRejection(upstream.status, text)) {
          captchaManager.invalidate();
          console.warn(
            `[zcode] 无痕验证失效（HTTP ${upstream.status}），刷新后重试（第 ${attempt}/${maxAttempts} 次）`,
          );
          continue;
        }

        // 其余错误原样透传状态码，交由 xrl-router 的密钥池判定与轮换
        if (!res.headersSent) {
          res
            .status(upstream.status)
            .type('application/json')
            .send(
              text ||
                JSON.stringify(
                  anthropicErrorBody('api_error', `上游返回 HTTP ${upstream.status}`),
                ),
            );
        }
        return;
      }

      if (wantsStream) await pipeStream(upstream, res);
      else await sendAggregated(upstream, res);
      return;
    }

    // 走完所有重试仍在验证码上失败：返回 5xx（插件侧故障，不影响密钥健康度）
    if (!res.headersSent) {
      res
        .status(502)
        .json(
          anthropicErrorBody(
            'captcha_error',
            `无痕验证连续 ${maxAttempts} 次失效，已放弃。这是插件侧故障，与密钥有效性无关。`,
          ),
        );
    }
  } finally {
    res.removeListener('close', onClientClose);
  }
}
