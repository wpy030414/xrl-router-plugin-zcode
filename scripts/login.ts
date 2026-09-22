#!/usr/bin/env tsx
/**
 * scripts/login.ts — `pnpm login`：走 Z.AI 的 OAuth 把 ZCode Coding Plan 的
 * JWT 拿到手并写进 `.env` 的 `ZCODE_KEYS`。
 *
 * 流程（对齐社区 zcode2api 的 ZaiAuthFlow）：
 *   1. POST {oauthBase}/oauth/cli/init      → 拿到 flow_id 与 authorize_url
 *   2. 打开浏览器完成授权
 *   3. GET  {oauthBase}/oauth/cli/poll/{id} → 轮询至 status=ready
 *   4. 写回 .env（合并进已有密钥列表，不覆盖别的变量）
 *
 * 注意：**不做** api.z.ai 的 API Key 兑换——本项目聚焦免费额度的反代，
 * 付费 API Key 那条链路见 AGENTS.md 的 Non Goals。
 */

import { exec } from 'node:child_process';
import { randomBytes } from 'node:crypto';

import { KEYS_ENV_KEY } from '../src/config';
import { classifySecret } from '../src/zcode/auth';
import { maskSecret, mergeKeyList, readEnvFileValue, upsertEnvValue } from './envFile';

const OAUTH_BASE = process.env.ZCODE_OAUTH_BASE || 'https://zcode.z.ai/api/v1';
const POLL_INTERVAL_MS = 2000;
const POLL_MAX_ATTEMPTS = 100; // ≈ 200s

const ok = (s: string): void => console.log(`✅ ${s}`);
const warn = (s: string): void => console.warn(`⚠️  ${s}`);
const fail = (s: string): void => console.error(`\n❌ ${s}`);

interface InitResult {
  flowId: string;
  authorizeUrl: string;
}

async function initFlow(pollToken: string): Promise<InitResult> {
  const resp = await fetch(`${OAUTH_BASE}/oauth/cli/init`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${pollToken}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ provider: 'zai' }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!resp.ok) throw new Error(`init 失败 HTTP ${resp.status}: ${(await resp.text()).slice(0, 200)}`);

  const data = (await resp.json())?.data ?? {};
  const flowId = data.flow_id;
  const authorizeUrl = data.authorize_url;
  if (!flowId || !authorizeUrl) throw new Error('init 返回的流程数据不完整');
  return { flowId, authorizeUrl };
}

async function pollOnce(pollToken: string, flowId: string): Promise<any> {
  const resp = await fetch(`${OAUTH_BASE}/oauth/cli/poll/${encodeURIComponent(flowId)}`, {
    headers: { authorization: `Bearer ${pollToken}` },
    signal: AbortSignal.timeout(30_000),
  });
  if (!resp.ok) throw new Error(`poll 失败 HTTP ${resp.status}`);
  return (await resp.json())?.data ?? {};
}

/** 尽力用系统默认浏览器打开（失败不阻断——URL 已经打印出来了） */
function openBrowser(url: string): void {
  const cmd =
    process.platform === 'win32'
      ? `start "" "${url}"`
      : process.platform === 'darwin'
        ? `open "${url}"`
        : `xdg-open "${url}"`;
  exec(cmd, () => undefined);
}

async function main(): Promise<void> {
  console.log('🔑 xrl-router-plugin · zcode 登录（OAuth → Coding Plan JWT）\n');

  const pollToken = randomBytes(32).toString('hex');

  let flow: InitResult;
  try {
    flow = await initFlow(pollToken);
  } catch (err) {
    fail(`OAuth 初始化失败：${(err as Error).message}`);
    return;
  }

  ok('OAuth 初始化成功，请在浏览器中完成授权：');
  console.log(`\n   ${flow.authorizeUrl}\n`);
  openBrowser(flow.authorizeUrl);
  console.log('   正在等待授权…（最多 200 秒）\n');

  for (let attempt = 1; attempt <= POLL_MAX_ATTEMPTS; attempt++) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));

    let data: any;
    try {
      data = await pollOnce(pollToken, flow.flowId);
    } catch {
      continue; // 网络抖动忽略，继续轮询
    }

    const status = data?.status;
    if (status === 'failed') {
      fail('授权失败或被拒绝。');
      return;
    }
    if (status !== 'ready') continue;

    const jwt: string | undefined = data?.token;
    if (!jwt) {
      fail('授权已完成，但响应里没有 Coding Plan 凭证（token 字段缺失）。');
      return;
    }
    if (classifySecret(jwt) !== 'jwt') {
      warn('拿到的凭证不是三段点分 JWT，已按原样保存——请留意上游是否接受。');
    }

    const existing = readEnvFileValue(KEYS_ENV_KEY) || process.env[KEYS_ENV_KEY] || '';
    const merged = mergeKeyList(existing, jwt);

    try {
      const changed = upsertEnvValue(KEYS_ENV_KEY, merged);
      ok(`已写入 .env：${KEYS_ENV_KEY} = ${maskSecret(jwt)}`);
      if (!changed) warn('该凭证已在列表中，未重复写入。');
      console.log(`   当前密钥池共 ${merged.split(',').filter(Boolean).length} 项。`);
      console.log('\n   下一步：pnpm capture-key 校验凭据并查看剩余额度');
    } catch (err) {
      fail((err as Error).message);
      console.log(`\n   手动写入也行：${KEYS_ENV_KEY}=<你的 JWT>`);
    }
    return;
  }

  fail('登录超时，请重新执行 pnpm login。');
}

main().catch((err) => {
  fail(`未预期的错误：${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
