#!/usr/bin/env tsx
/**
 * scripts/e2e.ts — 离线端到端自测（不需要任何真实凭证）。
 *
 * 做法：起两个 mock——一个假 ZCode 上游（HTTP），一个假 xrl-router（WS）——
 * 然后把插件指向它们，逐条验证对外行为契约。这样能在没有 Coding Plan 账号的
 * 情况下覆盖全部关键路径：协议透传、聚合、模型归一化、凭证分流、错误码映射、
 * 验证码缓存与刷新、注册载荷与心跳。
 *
 *   pnpm e2e
 *
 * 退出码 0 = 全绿；非 0 = 有断言失败。
 */

import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { WebSocketServer } from 'ws';

// ── 断言工具 ────────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function check(name: string, cond: boolean, detail = ''): void {
  if (cond) {
    passed++;
    console.log(`  ✅ ${name}`);
  } else {
    failed++;
    console.error(`  ❌ ${name}${detail ? `\n       ${detail}` : ''}`);
  }
}

function section(title: string): void {
  console.log(`\n── ${title} ${'─'.repeat(Math.max(0, 60 - title.length))}`);
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// ── Mock ZCode 上游 ─────────────────────────────────────────────────────────

interface RecordedRequest {
  url: string;
  headers: http.IncomingHttpHeaders;
  body: any;
}

/** 每个 SSE 帧之间插入的延迟，用来模拟真实流式 */
const FRAME_DELAY_MS = 8;

function buildSseFrames(model: string): string[] {
  return [
    `event: message_start\ndata: ${JSON.stringify({
      type: 'message_start',
      message: {
        id: 'msg_mock',
        type: 'message',
        role: 'assistant',
        model,
        content: [],
        usage: { input_tokens: 7, output_tokens: 0 },
      },
    })}\n\n`,
    `event: content_block_start\ndata: ${JSON.stringify({
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'text', text: '' },
    })}\n\n`,
    `event: content_block_delta\ndata: ${JSON.stringify({
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text: '你好' },
    })}\n\n`,
    `event: content_block_delta\ndata: ${JSON.stringify({
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text: '，前辈' },
    })}\n\n`,
    `event: content_block_stop\ndata: ${JSON.stringify({ type: 'content_block_stop', index: 0 })}\n\n`,
    `event: message_delta\ndata: ${JSON.stringify({
      type: 'message_delta',
      delta: { stop_reason: 'end_turn', stop_sequence: null },
      usage: { output_tokens: 5 },
    })}\n\n`,
    `event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}\n\n`,
  ];
}

interface MockUpstream {
  port: number;
  records: RecordedRequest[];
  /** 上游 configs 接口被请求过的原始 URL（用于断言「不能带查询参数」） */
  configUrls: string[];
  /** 只对第一个 captcha 场景返回 403，用于验证「刷新后重试成功」 */
  resetCaptchaOnce: () => void;
  close: () => Promise<void>;
}

async function startMockUpstream(): Promise<MockUpstream> {
  const records: RecordedRequest[] = [];
  const configUrls: string[] = [];
  let captchaOnceLeft = 0;

  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => {
      raw += c;
    });
    req.on('end', () => {
      const url = req.url || '';

      // 验证码场景配置接口 + 模型清单自动发现接口（同一个端点）
      if (url.startsWith('/configs')) {
        configUrls.push(url);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            code: 0,
            data: {
              configs: {
                captcha: { sceneId: 'mock-scene', region: 'mock-region', prefix: 'mock-prefix' },
              },
              builtinModels: [
                { modelId: 'GLM-5.3', name: 'GLM-5.3' },
                { modelId: 'GLM-5.3-Flash', name: 'GLM-5.3-Flash' },
                { modelId: 'GLM-5.3', name: 'GLM-5.3（重复项，用于验证去重）' },
              ],
              providers: [
                {
                  id: 'z-ai',
                  schema: 'anthropic',
                  models: [{ modelId: 'GLM-5.3' }, { modelId: 'GLM-5.2' }],
                },
              ],
            },
          }),
        );
        return;
      }

      let body: any = {};
      try {
        body = JSON.parse(raw);
      } catch {
        /* 允许空体 */
      }
      records.push({ url, headers: req.headers, body });

      const scenario = String(body.mock_scenario || '');
      const fail = (status: number, message: string): void => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ type: 'error', error: { type: 'mock_error', message } }));
      };

      if (scenario === '402') return fail(402, 'insufficient quota');
      if (scenario === '429') return fail(429, 'rate limit exceeded');
      if (scenario === '401') return fail(401, 'invalid api key');
      if (scenario === 'captcha403') return fail(403, 'captcha verify failed');
      if (scenario === 'captcha403once') {
        if (captchaOnceLeft > 0) {
          captchaOnceLeft--;
          return fail(403, 'captcha verify failed');
        }
      }

      // 默认：按 Anthropic SSE 逐帧吐
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      const frames = buildSseFrames(body.model || 'unknown');
      let i = 0;
      const timer = setInterval(() => {
        if (i >= frames.length) {
          clearInterval(timer);
          res.end();
          return;
        }
        res.write(frames[i++]);
      }, FRAME_DELAY_MS);
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;

  return {
    port,
    records,
    configUrls,
    resetCaptchaOnce: () => {
      captchaOnceLeft = 1;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

// ── Mock xrl-router（只收 WS 消息）───────────────────────────────────────────

interface MockRouter {
  port: number;
  messages: any[];
  waitFor: (type: string, timeoutMs?: number) => Promise<any | null>;
  close: () => Promise<void>;
}

async function startMockRouter(): Promise<MockRouter> {
  const messages: any[] = [];
  const waiters: Array<{ type: string; resolve: (m: any | null) => void }> = [];

  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });

  wss.on('connection', (socket) => {
    socket.on('message', (data) => {
      let msg: any;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }
      messages.push(msg);
      for (let i = waiters.length - 1; i >= 0; i--) {
        if (waiters[i].type === msg.type) {
          waiters[i].resolve(msg);
          waiters.splice(i, 1);
        }
      }
    });
  });

  await new Promise<void>((resolve) => wss.once('listening', resolve));
  const port = (wss.address() as { port: number }).port;

  return {
    port,
    messages,
    waitFor: (type, timeoutMs = 3000) =>
      new Promise((resolve) => {
        const existing = messages.find((m) => m.type === type);
        if (existing) return resolve(existing);
        const waiter = { type, resolve };
        waiters.push(waiter);
        setTimeout(() => {
          const idx = waiters.indexOf(waiter);
          if (idx >= 0) {
            waiters.splice(idx, 1);
            resolve(null);
          }
        }, timeoutMs);
      }),
    close: () =>
      new Promise<void>((resolve) => {
        for (const client of wss.clients) client.terminate();
        wss.close(() => resolve());
      }),
  };
}

// ── 主流程 ──────────────────────────────────────────────────────────────────

const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJtb2NrIn0.signature';
const API_KEY = 'sk-mock-zai-api-key';
const PLUGIN_PORT = 19165;

async function main(): Promise<void> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zcode-e2e-'));
  const counterFile = path.join(tmpDir, 'solver-count.txt');
  fs.writeFileSync(counterFile, '');

  const upstream = await startMockUpstream();
  const router = await startMockRouter();

  // ⚠ 必须在 require 插件模块之前设好——settings 在 import 时求值
  process.env.ZCODE_PORT = String(PLUGIN_PORT);
  process.env.ZCODE_BASE_URL = `http://127.0.0.1:${upstream.port}/zcode-messages`;
  process.env.ZAI_FALLBACK_URL = `http://127.0.0.1:${upstream.port}/fallback-messages`;
  process.env.ZCODE_CAPTCHA_CONFIG_URL = `http://127.0.0.1:${upstream.port}/configs`;
  process.env.ZCODE_SOLVER_PATH = path.join(__dirname, 'mock-solver.cjs');
  process.env.ZCODE_CAPTCHA_RETRIES = '1';
  process.env.ZCODE_CAPTCHA_CACHE_TTL = '60000';
  process.env.ZCODE_MODELS = 'GLM-5.2=glm-5.2,GLM-5-Turbo';
  process.env.ZCODE_KEYS = `${JWT},${API_KEY}`;
  process.env.XRL_ROUTER_URL = `http://127.0.0.1:${router.port}`;
  process.env.ZCODE_HEARTBEAT_INTERVAL_MS = '300';
  process.env.ZCODE_ENV_POLL_INTERVAL_MS = '300';
  process.env.MOCK_SOLVER_COUNTER = counterFile;

  // 延迟加载：此刻 settings 才读到上面的值
  /* eslint-disable @typescript-eslint/no-var-requires */
  const { createApp } = require('../src/index') as typeof import('../src/index');
  const { PluginClient } = require('../src/pluginClient') as typeof import('../src/pluginClient');
  const { fetchClientConfigs } = require('../src/zcode/configs') as typeof import('../src/zcode/configs');

  const app = createApp();
  const server = await new Promise<http.Server>((resolve) => {
    const s = app.listen(PLUGIN_PORT, '127.0.0.1', () => resolve(s));
  });

  const pluginClient = new PluginClient({ cwd: tmpDir });
  const base = `http://127.0.0.1:${PLUGIN_PORT}`;

  const post = (body: any, headers: Record<string, string> = {}): Promise<Response> =>
    fetch(`${base}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': JWT, ...headers },
      body: JSON.stringify(body),
    });

  const solverCalls = (): number =>
    fs
      .readFileSync(counterFile, 'utf8')
      .split('\n')
      .filter(Boolean).length;

  try {
    // ── 1. 元信息端点 ──────────────────────────────────────────────────────
    section('1. 元信息端点');

    const health = await (await fetch(`${base}/health`)).json();
    check('GET /health 报 healthy + provider_kind=messages',
      health.status === 'healthy' && health.provider_kind === 'messages', JSON.stringify(health));
    check('GET /health 的 api_path 是 /v1/messages', health.api_path === '/v1/messages');

    const root = await (await fetch(`${base}/`)).json();
    check('GET / 暴露模型清单', Array.isArray(root.models) && root.models.length === 2,
      JSON.stringify(root.models));

    const notFound = await fetch(`${base}/v1/models`);
    check('未实现的端点返回 404', notFound.status === 404);

    const noSecret = await fetch(`${base}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    check('无凭证时返回 401', noSecret.status === 401);

    // ── 2. 流式透传 ────────────────────────────────────────────────────────
    section('2. 流式透传（字节级）');

    const expectedSse = buildSseFrames('GLM-5.2').join('');
    const streamRes = await post({
      model: 'GLM-5.2',
      max_tokens: 64,
      stream: true,
      messages: [{ role: 'user', content: '你好' }],
    });
    const streamText = await streamRes.text();
    check('流式响应 200', streamRes.status === 200, `HTTP ${streamRes.status}`);
    check(
      'Content-Type 透传为 text/event-stream',
      (streamRes.headers.get('content-type') || '').includes('text/event-stream'),
      streamRes.headers.get('content-type') || '',
    );
    check('SSE 字节与上游逐帧一致（无损透传）', streamText === expectedSse,
      `\n       期望 ${expectedSse.length} 字节 / 实收 ${streamText.length} 字节`);

    const lastRecord = upstream.records[upstream.records.length - 1];
    check('上游收到的 stream 被强制为 true', lastRecord.body.stream === true);

    // ── 3. 非流式聚合 ──────────────────────────────────────────────────────
    section('3. 非流式聚合');

    const nonStreamRes = await post({
      model: 'GLM-5.2',
      max_tokens: 64,
      stream: false,
      messages: [{ role: 'user', content: '你好' }],
    });
    const aggregated = await nonStreamRes.json();
    check('非流式响应 200 且为单条 message', nonStreamRes.status === 200 && aggregated.type === 'message',
      JSON.stringify(aggregated).slice(0, 200));
    check('聚合出的文本正确', aggregated.content?.[0]?.text === '你好，前辈',
      JSON.stringify(aggregated.content));
    check('聚合出的 stop_reason 正确', aggregated.stop_reason === 'end_turn');
    check('聚合出的 usage 合并了 message_delta', aggregated.usage?.output_tokens === 5,
      JSON.stringify(aggregated.usage));

    // ── 4. 模型名归一化 ────────────────────────────────────────────────────
    section('4. 模型名归一化');

    upstream.records.length = 0;
    await post({ model: 'glm-5.2', stream: false, max_tokens: 8, messages: [] });
    check('小写别名 glm-5.2 → 上游收到 GLM-5.2',
      upstream.records[0]?.body.model === 'GLM-5.2', upstream.records[0]?.body.model);

    upstream.records.length = 0;
    await post({ model: 'zai/GLM-5-Turbo', stream: false, max_tokens: 8, messages: [] });
    check('带前缀 zai/GLM-5-Turbo → 上游收到 GLM-5-Turbo',
      upstream.records[0]?.body.model === 'GLM-5-Turbo', upstream.records[0]?.body.model);

    upstream.records.length = 0;
    await post({ model: 'glm-5-turbo', stream: false, max_tokens: 8, messages: [] });
    check('按展示名匹配 glm-5-turbo → 上游收到 GLM-5-Turbo',
      upstream.records[0]?.body.model === 'GLM-5-Turbo', upstream.records[0]?.body.model);

    // ── 5. 凭证分流 ────────────────────────────────────────────────────────
    section('5. 凭证分流（JWT vs API Key）');

    upstream.records.length = 0;
    await post({ model: 'GLM-5.2', stream: false, max_tokens: 8, messages: [] });
    const jwtRec = upstream.records[0];
    check('JWT 走 Coding Plan 端点', jwtRec.url === '/zcode-messages', jwtRec.url);
    check('JWT 用 Authorization: Bearer', jwtRec.headers.authorization === `Bearer ${JWT}`,
      String(jwtRec.headers.authorization));
    check('JWT 带上无痕验证头', typeof jwtRec.headers['x-aliyun-captcha-verify-param'] === 'string',
      String(jwtRec.headers['x-aliyun-captcha-verify-param']));
    check('无痕验证头内容来自场景配置（透传到求解器）',
      String(jwtRec.headers['x-aliyun-captcha-verify-param']).includes('mock-scene'),
      String(jwtRec.headers['x-aliyun-captcha-verify-param']));
    check('带上 anthropic-version', jwtRec.headers['anthropic-version'] === '2023-06-01');
    check('带上 ZCode 业务头', typeof jwtRec.headers['x-zcode-agent'] === 'string');

    upstream.records.length = 0;
    const apiKeyRes = await post(
      { model: 'GLM-5.2', stream: false, max_tokens: 8, messages: [] },
      { 'x-api-key': API_KEY },
    );
    const apiRec = upstream.records[0];
    check('API Key 走回退端点', apiRec.url === '/fallback-messages', apiRec.url);
    check('API Key 用 x-api-key 头', apiRec.headers['x-api-key'] === API_KEY);
    check('API Key 不带无痕验证头', apiRec.headers['x-aliyun-captcha-verify-param'] === undefined);
    check('API Key 请求成功', apiKeyRes.status === 200);

    // ── 6. 验证码缓存 ──────────────────────────────────────────────────────
    section('6. 验证码缓存');

    // 第 2-5 节共发起了 6 个 JWT 请求（含流式/非流式/多种模型名），
    // 缓存正确的话求解器全程只该被 spawn 一次。
    check(
      '多个 JWT 请求合计只求解 1 次（verifyParam 缓存命中）',
      solverCalls() === 1,
      `实际求解 ${solverCalls()} 次`,
    );

    for (let i = 0; i < 3; i++) {
      await post({ model: 'GLM-5.2', stream: false, max_tokens: 8, messages: [] });
    }
    check('TTL 内再连发 3 个请求仍不新增求解', solverCalls() === 1,
      `实际求解 ${solverCalls()} 次`);

    // ── 7. 错误码映射 ──────────────────────────────────────────────────────
    section('7. 错误码映射（决定 router 是否轮换密钥）');

    for (const [scenario, expected] of [
      ['402', 402],
      ['429', 429],
      ['401', 401],
    ] as const) {
      const res = await post({ model: 'GLM-5.2', mock_scenario: scenario, messages: [] });
      check(`上游 ${scenario} → 插件原样透传 ${expected}`, res.status === expected, `实际 ${res.status}`);
    }

    const captchaAlways = await post({ model: 'GLM-5.2', mock_scenario: 'captcha403' });
    check('验证码持续失效 → 返回 502（而非 403，避免误标红密钥）',
      captchaAlways.status === 502, `实际 ${captchaAlways.status}`);

    upstream.resetCaptchaOnce();
    const captchaOnce = await post({ model: 'GLM-5.2', mock_scenario: 'captcha403once' });
    check('验证码失效一次 → 刷新后重试成功（200）', captchaOnce.status === 200,
      `实际 ${captchaOnce.status}`);

    // ── 8. 注册载荷与心跳 ──────────────────────────────────────────────────
    section('8. 注册载荷与心跳');

    const register = await router.waitFor('register');
    check('已向 xrl-router 发送 register', register !== null);
    check('plugin_id 正确', register?.plugin_id === 'xrl-router-plugin-zcode', String(register?.plugin_id));
    check('provider.kind = messages', register?.provider?.kind === 'messages', String(register?.provider?.kind));
    check('provider.api_path = /v1/messages', register?.provider?.api_path === '/v1/messages');
    check('base_url 指向插件自身端口',
      register?.provider?.base_url === `http://localhost:${PLUGIN_PORT}`,
      String(register?.provider?.base_url));
    check('models 数量与 ZCODE_MODELS 一致', register?.models?.length === 2,
      JSON.stringify(register?.models));
    check('models 保留上游大小写 + 自定义展示名',
      register?.models?.[0]?.model_id === 'GLM-5.2' && register?.models?.[0]?.display_name === 'glm-5.2',
      JSON.stringify(register?.models?.[0]));
    check('keys 与 ZCODE_KEYS 一致',
      JSON.stringify(register?.keys) === JSON.stringify([JWT, API_KEY]),
      JSON.stringify(register?.keys));

    const hbBefore = router.messages.filter((m) => m.type === 'heartbeat').length;
    await sleep(1000);
    const hbAfter = router.messages.filter((m) => m.type === 'heartbeat').length;
    check('心跳按周期持续发送（1s 内 ≥2 次）', hbAfter - hbBefore >= 2,
      `实际 ${hbAfter - hbBefore} 次`);

    // ── 9. 上游配置接口（验证码场景 + 模型自动发现）──────────────────────────
    section('9. 上游 configs 接口');

    check('请求 configs 接口时不携带任何查询参数',
      upstream.configUrls.length > 0 && upstream.configUrls.every((u) => !u.includes('?')),
      JSON.stringify(upstream.configUrls));

    const configs = await fetchClientConfigs();
    check('自动发现取到上游模型清单',
      JSON.stringify(configs?.models.map((m) => m.modelId)) ===
        JSON.stringify(['GLM-5.3', 'GLM-5.3-Flash']),
      JSON.stringify(configs?.models));
    check('builtinModels 优先、去重保序，且不混入 providers 的清单',
      configs?.models.length === 2 && configs?.models[0]?.modelId === 'GLM-5.3',
      JSON.stringify(configs?.models));
    check('同一接口也提供验证码场景参数',
      configs?.captcha?.sceneId === 'mock-scene' && configs?.captcha?.region === 'mock-region',
      JSON.stringify(configs?.captcha));
    check('configs 结果被缓存（不重复请求上游）',
      upstream.configUrls.length === 1, `实际请求 ${upstream.configUrls.length} 次`);

    pluginClient.close();
  } finally {
    await new Promise<void>((resolve) => {
      server.closeAllConnections?.();
      server.close(() => resolve());
    });
    await upstream.close();
    await router.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  console.log(`\n${'═'.repeat(64)}`);
  console.log(`  通过 ${passed} / 共 ${passed + failed}`);
  console.log(`${'═'.repeat(64)}\n`);

  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('\n💥 e2e 运行异常：', err);
  process.exit(1);
});
