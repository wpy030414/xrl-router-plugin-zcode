#!/usr/bin/env node
/**
 * scripts/_diag3012-full.cjs
 *
 * 决定性诊断:用完全仿真的浏览器会话(cookie priming + visitor_id + 节奏控制)
 * 重放真实 JWT + 真 param,看 3012 是 IP 维度还是账号维度。
 *
 * 实验变量:
 *   A. 直接 POST(对照基线)
 *   B. 先 GET zcode.z.ai 拿 cookie priming,再 POST
 *   C. 带 visitor_id(从 priming 响应取)+ acw_tc/cdn_sec_tc cookie,再 POST
 *   D. 换 off-peak 端点(免费额度专属,无签名/captcha 要求)
 */
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

let jwt = null;
for (const line of fs.readFileSync('.env', 'utf8').split('\n')) {
  if (line.startsWith('ZCODE_KEYS=')) {
    for (const p of line.slice(11).split(',').map((s) => s.trim()).filter(Boolean)) {
      if (p.split('.').length === 3) { jwt = p; break; }
    }
  }
}
if (!jwt) { console.error('无 JWT'); process.exit(1); }
console.log(`JWT mask=${jwt.slice(0, 6)}…${jwt.slice(-4)}`);

function sleep(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }

function solveParam() {
  console.log('  [等 20s 节奏冷却 + 求解...]');
  sleep(20_000);
  const r = spawnSync('node', ['captcha/solver.cjs', '11xygtvd', 'cn', 'no8xfe'], { encoding: 'utf8' });
  for (const line of (r.stdout || '').split('\n')) {
    if (line.startsWith('VERIFY_PARAM=')) return line.slice(13).trim();
  }
  throw new Error(`solver exit ${r.status}: ${(r.stderr || '').slice(0, 120)}`);
}

function curl(args, env = process.env) {
  const r = spawnSync('curl', args, { encoding: 'utf8', env, timeout: 30_000 });
  return { stdout: r.stdout || '', stderr: r.stderr || '', status: r.status };
}

// === 实验 A:基线(无 cookie,无 visitor_id) ===
console.log('\n═══════════ 实验 A:基线(对照)═══════════');
try {
  const param = solveParam();
  console.log(`param OK len=${param.length}`);
  const r = curl([
    '-sS', '-m', '20', '-X', 'POST',
    'https://zcode.z.ai/api/v1/zcode-plan/anthropic/v1/messages',
    '-H', 'content-type: application/json',
    '-H', 'anthropic-version: 2023-06-01',
    '-H', `authorization: Bearer ${jwt}`,
    '-H', `x-aliyun-captcha-verify-param: ${param}`,
    '-H', 'x-aliyun-captcha-verify-region: cn',
    '-H', 'x-zcode-app-version: 3.5.3',
    '-H', 'x-zcode-agent: glm',
    '-H', 'http-referer: https://zcode.z.ai/',
    '-H', 'user-agent: ZCode/3.5.3',
    '-w', '\\nHTTP %{http_code}\\n',
    '-d', '{"model":"GLM-5.3","max_tokens":1,"messages":[{"role":"user","content":"hi"}]}',
  ]);
  const m = /HTTP (\d+)/.exec(r.stdout);
  console.log(`  → HTTP ${m?.[1] ?? '?'}  body: ${(r.stdout.split('\n')[0] || '').slice(0, 200)}`);
} catch (e) { console.log(`  ✗ ${e.message}`); }

// === 实验 B:cookie priming ===
console.log('\n═══════════ 实验 B:cookie priming ═══════════');
const cookieJar = path.join(process.cwd(), '.tmp-cookies.txt');
try {
  // 1. 先 GET zcode.z.ai 拿 acw_tc/cdn_sec_tc/visitor_id
  console.log('  [priming: GET zcode.z.ai/]');
  curl([
    '-sS', '-m', '10', '-c', cookieJar,
    'https://zcode.z.ai/',
    '-H', 'user-agent: ZCode/3.5.3',
  ]);
  console.log('  cookies:', fs.existsSync(cookieJar) ? fs.readFileSync(cookieJar, 'utf8').split('\n').filter(l => l && !l.startsWith('#')).map(l => l.split('\t').pop()).join(', ') : '(none)');

  // 2. 求解
  const param = solveParam();
  console.log(`param OK`);

  // 3. POST 带 cookie
  const r = curl([
    '-sS', '-m', '20', '-X', 'POST',
    '-b', cookieJar,
    'https://zcode.z.ai/api/v1/zcode-plan/anthropic/v1/messages',
    '-H', 'content-type: application/json',
    '-H', 'anthropic-version: 2023-06-01',
    '-H', `authorization: Bearer ${jwt}`,
    '-H', `x-aliyun-captcha-verify-param: ${param}`,
    '-H', 'x-aliyun-captcha-verify-region: cn',
    '-H', 'x-zcode-app-version: 3.5.3',
    '-H', 'x-zcode-agent: glm',
    '-H', 'http-referer: https://zcode.z.ai/',
    '-H', 'user-agent: ZCode/3.5.3',
    '-w', '\\nHTTP %{http_code}\\n',
    '-d', '{"model":"GLM-5.3","max_tokens":1,"messages":[{"role":"user","content":"hi"}]}',
  ]);
  const m = /HTTP (\d+)/.exec(r.stdout);
  console.log(`  → HTTP ${m?.[1] ?? '?'}  body: ${(r.stdout.split('\n')[0] || '').slice(0, 200)}`);
} catch (e) { console.log(`  ✗ ${e.message}`); }

// === 实验 C:带 visitor_id header + cookie priming ===
console.log('\n═══════════ 实验 C:visitor_id + priming ═══════════');
try {
  const param = solveParam();
  console.log(`param OK`);
  // visitor_id 用一个固定 UUID(模拟浏览器 session)
  const visitorId = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
  const r = curl([
    '-sS', '-m', '20', '-X', 'POST',
    '-b', cookieJar,
    'https://zcode.z.ai/api/v1/zcode-plan/anthropic/v1/messages',
    '-H', 'content-type: application/json',
    '-H', 'anthropic-version: 2023-06-01',
    '-H', `authorization: Bearer ${jwt}`,
    '-H', `x-aliyun-captcha-verify-param: ${param}`,
    '-H', 'x-aliyun-captcha-verify-region: cn',
    '-H', `cookie: visitor_id=${visitorId}`,
    '-H', 'x-zcode-app-version: 3.5.3',
    '-H', 'x-zcode-agent: glm',
    '-H', 'x-platform: win32-x64',
    '-H', 'x-client-language: zh-CN',
    '-H', 'x-client-timezone: Asia/Shanghai',
    '-H', 'x-os-category: windows',
    '-H', 'http-referer: https://zcode.z.ai/',
    '-H', 'user-agent: ZCode/3.5.3',
    '-w', '\\nHTTP %{http_code}\\n',
    '-d', '{"model":"GLM-5.3","max_tokens":1,"messages":[{"role":"user","content":"hi"}]}',
  ]);
  const m = /HTTP (\d+)/.exec(r.stdout);
  console.log(`  → HTTP ${m?.[1] ?? '?'}  body: ${(r.stdout.split('\n')[0] || '').slice(0, 200)}`);
} catch (e) { console.log(`  ✗ ${e.message}`); }

// === 实验 D:off-peak 端点(免费额度专属,无 captcha/签名) ===
console.log('\n═══════════ 实验 D:off-peak 端点 ═══════════');
try {
  const r = curl([
    '-sS', '-m', '20', '-X', 'POST',
    'https://zcode.z.ai/api/v1/off-peak/anthropic/v1/messages',
    '-H', 'content-type: application/json',
    '-H', 'anthropic-version: 2023-06-01',
    '-H', `authorization: Bearer ${jwt}`,
    '-H', 'x-zcode-app-version: 3.5.3',
    '-H', 'x-zcode-agent: glm',
    '-H', 'http-referer: https://zcode.z.ai/',
    '-H', 'user-agent: ZCode/3.5.3',
    '-w', '\\nHTTP %{http_code}\\n',
    '-d', '{"model":"GLM-5.3","max_tokens":1,"messages":[{"role":"user","content":"hi"}]}',
  ]);
  const m = /HTTP (\d+)/.exec(r.stdout);
  console.log(`  → HTTP ${m?.[1] ?? '?'}  body: ${(r.stdout.split('\n')[0] || '').slice(0, 200)}`);
} catch (e) { console.log(`  ✗ ${e.message}`); }

try { fs.unlinkSync(cookieJar); } catch {}
console.log('\n═══════════ 完成 ═══════════');
