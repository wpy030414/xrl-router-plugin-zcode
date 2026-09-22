/**
 * config.ts — Settings 单例：集中读取环境变量。
 *
 * 约定与 qwenwork 插件一致：所有配置只在这里读一次，其余模块只用 `settings`。
 */

import path from 'node:path';
import dotenv from 'dotenv';

import { DEFAULT_MODELS, parseModelsConfig, type ModelSpec } from './zcode/models';

dotenv.config();

/** 读环境变量：空串与未定义一律视为「没配」，走 fallback */
function env(key: string, fallback: string): string {
  const v = process.env[key];
  return v !== undefined && v !== '' ? v : fallback;
}

function intEnv(key: string, fallback: number): number {
  const raw = process.env[key];
  if (raw === undefined || raw === '') return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : fallback;
}

/** 仓库根目录（本文件位于 <root>/src，编译产物位于 <root>/dist 时同样成立） */
const ROOT_DIR = path.resolve(__dirname, '..');

/** 无痕验证求解器脚本路径（可由 ZCODE_SOLVER_PATH 覆盖，便于测试注入 mock） */
function resolveSolverPath(): string {
  const override = process.env.ZCODE_SOLVER_PATH;
  if (override) return path.resolve(override);
  return path.join(ROOT_DIR, 'captcha', 'solver.cjs');
}

/**
 * 模型清单：`ZCODE_MODELS` 为权威来源；未配置时回退内置默认值，
 * 并置 `modelsExplicit = false` 让启动流程打印醒目警告。
 */
const modelsRaw = (process.env.ZCODE_MODELS || '').trim();
const modelsExplicit = modelsRaw.length > 0;
const models: ModelSpec[] = modelsExplicit
  ? parseModelsConfig(modelsRaw)
  : parseModelsConfig(DEFAULT_MODELS);

/** xrl-router 密钥池取 key 时用的 `.env` 变量名 */
export const KEYS_ENV_KEY = 'ZCODE_KEYS';

export const PLUGIN_ID = 'xrl-router-plugin-zcode';

/** 注册给 xrl-router 的供应商类型：告诉 router「本上游说的是 Anthropic Messages」 */
export const PROVIDER_KIND = 'messages';
export const PROVIDER_API_PATH = '/v1/messages';

export interface Settings {
  port: number;
  xrlRouterUrl: string;

  models: ModelSpec[];
  modelsExplicit: boolean;

  /** Coding Plan（JWT）主端点 */
  zcodeBaseUrl: string;
  /** 非 JWT 凭证的 Z.AI 回退端点（无需验证码） */
  zaiFallbackUrl: string;
  /** 额度 / 计费查询基址（capture-key 用） */
  billingBase: string;
  /** 验证码场景配置接口（远端可能不可用，故有内置回退） */
  captchaConfigUrl: string;

  /** 上游业务头（逆向所得） */
  upstream: {
    appVersion: string;
    agent: string;
    userAgent: string;
  };

  captcha: {
    sceneId: string;
    region: string;
    prefix: string;
    /** 单次求解超时（毫秒） */
    timeoutMs: number;
    /** 单次请求内验证码求解失败重试次数 */
    retries: number;
    /** verifyParam 缓存时长（毫秒） */
    cacheTtlMs: number;
    /** 场景配置缓存时长（毫秒） */
    configCacheTtlMs: number;
    nodePath: string;
    solverPath: string;
  };

  /** 插件 ↔ xrl-router 的 WebSocket 节奏（e2e 可缩短以便验证） */
  heartbeatIntervalMs: number;
  envPollIntervalMs: number;
  reconnectBaseMs: number;
  reconnectMaxMs: number;
}

export const settings: Settings = {
  port: intEnv('ZCODE_PORT', 19065),
  xrlRouterUrl: env('XRL_ROUTER_URL', 'http://localhost:19068'),

  models,
  modelsExplicit,

  zcodeBaseUrl: env(
    'ZCODE_BASE_URL',
    'https://zcode.z.ai/api/v1/zcode-plan/anthropic/v1/messages',
  ),
  zaiFallbackUrl: env('ZAI_FALLBACK_URL', 'https://api.z.ai/api/anthropic/v1/messages'),
  billingBase: env('ZCODE_BILLING_BASE', 'https://zcode.z.ai/api/v1/zcode-plan'),
  captchaConfigUrl: env('ZCODE_CAPTCHA_CONFIG_URL', 'https://zcode.z.ai/api/v1/client/configs'),

  upstream: {
    appVersion: env('ZCODE_APP_VERSION', '3.0.1'),
    agent: env('ZCODE_AGENT', 'glm'),
    userAgent: env('ZCODE_USER_AGENT', 'ZCode/3.0.1'),
  },

  captcha: {
    sceneId: env('ZCODE_CAPTCHA_SCENE', '11xygtvd'),
    region: env('ZCODE_CAPTCHA_REGION', 'sgp'),
    prefix: env('ZCODE_CAPTCHA_PREFIX', 'no8xfe'),
    timeoutMs: intEnv('ZCODE_CAPTCHA_TIMEOUT', 40) * 1000,
    retries: intEnv('ZCODE_CAPTCHA_RETRIES', 4),
    cacheTtlMs: intEnv('ZCODE_CAPTCHA_CACHE_TTL', 45_000),
    configCacheTtlMs: intEnv('ZCODE_CAPTCHA_CONFIG_CACHE_TTL', 600_000),
    nodePath: env('ZCODE_NODE_PATH', 'node'),
    solverPath: resolveSolverPath(),
  },

  heartbeatIntervalMs: intEnv('ZCODE_HEARTBEAT_INTERVAL_MS', 30_000),
  envPollIntervalMs: intEnv('ZCODE_ENV_POLL_INTERVAL_MS', 5_000),
  reconnectBaseMs: intEnv('ZCODE_RECONNECT_BASE_MS', 1_000),
  reconnectMaxMs: intEnv('ZCODE_RECONNECT_MAX_MS', 60_000),
};
