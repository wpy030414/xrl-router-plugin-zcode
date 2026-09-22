/**
 * scripts/envFile.ts — `.env` 读写与密钥安全闸。
 *
 * 所有会**写** `.env` 的脚本都必须先过 `assertEnvIgnored()`：`.env` 里是
 * 明文凭证，一旦进了 git 就是不可逆的泄露。
 */

import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export const REPO_ROOT = path.resolve(__dirname, '..');
export const ENV_PATH = path.join(REPO_ROOT, '.env');

/** `.env` 是否被 git 忽略（`git check-ignore` 返回 0 表示被忽略） */
export function isEnvIgnored(): boolean {
  try {
    execSync(`git check-ignore .env`, { cwd: REPO_ROOT, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/** 写 `.env` 前的强校验；未忽略就抛错中止 */
export function assertEnvIgnored(): void {
  if (!isEnvIgnored()) {
    throw new Error(
      '.env 未被 git 忽略！为防止明文凭证泄露已中止。请先把 .env 写进 .gitignore。',
    );
  }
}

/** 读 `.env` 文件里的单个变量（不含进程环境兜底——那是调用方的事） */
export function readEnvFileValue(key: string): string {
  if (!fs.existsSync(ENV_PATH)) return '';
  const line = fs
    .readFileSync(ENV_PATH, 'utf8')
    .split(/\r?\n/)
    .find((l) => l.startsWith(`${key}=`));
  return line ? line.slice(key.length + 1).trim() : '';
}

/**
 * 把值写进 `.env` 的某个变量（存在则覆盖，不存在则追加）。
 * 只在值确实变化时落盘，其余变量原样保留。
 */
export function upsertEnvValue(key: string, value: string): boolean {
  assertEnvIgnored();

  const exists = fs.existsSync(ENV_PATH);
  const lines = exists ? fs.readFileSync(ENV_PATH, 'utf8').split(/\r?\n/) : [];
  const idx = lines.findIndex((l) => l.startsWith(`${key}=`));

  if (idx >= 0) {
    if (lines[idx] === `${key}=${value}`) return false;
    lines[idx] = `${key}=${value}`;
  } else {
    // 追加在末尾，去掉多余的尾部空行
    while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop();
    lines.push(`${key}=${value}`);
  }

  fs.writeFileSync(ENV_PATH, lines.join('\n') + '\n', { mode: 0o600 });
  try {
    fs.chmodSync(ENV_PATH, 0o600);
  } catch {
    /* Windows 上 chmod 语义有限，忽略 */
  }
  return true;
}

/** 把新密钥并入以逗号分隔的密钥列表（去重、保序、新的在后） */
export function mergeKeyList(existing: string, addition: string): string {
  const list = existing
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (addition && !list.includes(addition)) list.push(addition);
  return list.join(',');
}

/** 脱敏展示 */
export function maskSecret(secret: string): string {
  if (!secret) return '(空)';
  return secret.length <= 20 ? `${secret.slice(0, 4)}…` : `${secret.slice(0, 8)}…${secret.slice(-6)}`;
}
