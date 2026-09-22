/**
 * index.ts — 插件入口：Express HTTP 服务 + xrl-router 注册。
 *
 * 对外只暴露一个业务端点：`POST /v1/messages`（Anthropic Messages 协议）。
 * 之所以是 Messages 而不是 Chat Completions：见 src/zcode/client.ts 顶部注释。
 *
 * 启动流程：启动前释放端口 → 监听 → 连 xrl-router 注册 → 打印配置摘要。
 */

import type { Server } from 'node:http';

import cors from 'cors';
import express, { type Express, type Request, type Response } from 'express';

import { PLUGIN_ID, PROVIDER_API_PATH, PROVIDER_KIND, settings } from './config';
import { PluginClient, readKeysFromEnv } from './pluginClient';
import { killPortProcess } from './port';
import { MAX_CAPTCHA_REFRESH } from './zcode/client';
import { forwardMessages } from './zcode/client';
import { classifySecret } from './zcode/auth';

export interface RunningServer {
  server: Server;
  pluginClient: PluginClient;
  port: number;
  /** 关闭 HTTP 服务与 WS 客户端 */
  close: () => Promise<void>;
}

export function createApp(): Express {
  const app = express();

  app.use(cors());
  app.use(express.json({ limit: '50mb' }));

  // 元信息（探针 / 人肉排障用）
  app.get('/', (_req: Request, res: Response) => {
    res.json({
      version: '0.1.0',
      service: PLUGIN_ID,
      status: 'running',
      mode: 'plugin',
      upstream: settings.zcodeBaseUrl,
      endpoints: { messages: PROVIDER_API_PATH, health: '/health' },
      models: settings.models.map((m) => ({
        model_id: m.modelId,
        display_name: m.displayName,
      })),
    });
  });

  app.get('/health', (_req: Request, res: Response) => {
    res.json({
      status: 'healthy',
      mode: 'plugin',
      provider_kind: PROVIDER_KIND,
      api_path: PROVIDER_API_PATH,
      base_url: `http://localhost:${settings.port}`,
      upstream: settings.zcodeBaseUrl,
      models: settings.models.length,
      keys_configured: readKeysFromEnv().length,
    });
  });

  app.post(PROVIDER_API_PATH, async (req: Request, res: Response) => {
    await forwardMessages(req, res);
  });

  app.use((_req: Request, res: Response) => {
    res.status(404).json({
      type: 'error',
      error: { type: 'not_found', message: `本插件仅提供 POST ${PROVIDER_API_PATH}` },
    });
  });

  return app;
}

/** 打印启动配置摘要 + 提醒配置缺口 */
function printBanner(): void {
  const keys = readKeysFromEnv();
  const jwtCount = keys.filter((k) => classifySecret(k) === 'jwt').length;

  console.log('');
  console.log(`  ${PLUGIN_ID}`);
  console.log(`  监听      http://localhost:${settings.port}${PROVIDER_API_PATH}`);
  console.log(`  注册      注册为 ${PROVIDER_KIND} 供应商 → ${settings.xrlRouterUrl}`);
  console.log(`  上游      ${settings.zcodeBaseUrl}`);
  console.log(`  模型      ${settings.models.map((m) => `${m.modelId}(→${m.displayName})`).join(', ')}`);
  console.log(`  密钥      ${keys.length} 项（JWT ${jwtCount} / 其他 ${keys.length - jwtCount}）`);
  console.log('');

  if (!settings.modelsExplicit) {
    console.warn('  ⚠ 未配置 ZCODE_MODELS，已回退内置默认值。');
    console.warn('    ZCode 上游的模型名【大小写敏感】，请确认后写进 .env。');
  }
  if (keys.length === 0) {
    console.warn(`  ⚠ ZCODE_KEYS 为空，尚无密钥可注册给 xrl-router。先跑 pnpm login。`);
  }
}

export async function startServer(options: { port?: number } = {}): Promise<RunningServer> {
  const port = options.port ?? settings.port;
  const app = createApp();

  await killPortProcess(port);

  const server = await new Promise<Server>((resolve, reject) => {
    const s = app.listen(port, '0.0.0.0', () => resolve(s));
    s.on('error', reject);
  });

  printBanner();

  const pluginClient = new PluginClient();

  const close = async (): Promise<void> => {
    pluginClient.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };

  return { server, pluginClient, port, close };
}

/* istanbul ignore next — 仅在作为入口脚本运行时启动 */
if (require.main === module) {
  startServer()
    .then(({ close }) => {
      const shutdown = (signal: string): void => {
        console.log(`\n[plugin] 收到 ${signal}，正在退出…`);
        close()
          .catch(() => undefined)
          .finally(() => process.exit(0));
      };
      process.on('SIGTERM', () => shutdown('SIGTERM'));
      process.on('SIGINT', () => shutdown('SIGINT'));
    })
    .catch((err) => {
      console.error(`[plugin] 启动失败：${err instanceof Error ? err.message : err}`);
      process.exit(1);
    });
}

export { MAX_CAPTCHA_REFRESH };
