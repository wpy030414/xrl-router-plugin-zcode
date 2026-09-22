# AGENTS.md — xrl-router-plugin-zcode

本文件为 AI Agent 划定项目边界。在本仓库工作时，必须遵守以下约束。

## 概述

`xrl-router-plugin-zcode` 是一个 **xrl-router 插件**：把 ZCode（`zcode.z.ai`）的额度包装成 OpenAI / Anthropic 兼容的本地服务，通过 WebSocket 注册为 router 的委托供应商。

注册形态：`kind: "messages"` + `api_path: "/v1/messages"`，默认端口 `19065`。

## 边界与范围

### 范围内

- 代理 `POST /v1/messages`（Anthropic Messages 协议）到 ZCode 上游
- 注入 ZCode 业务头 + 阿里云无痕验证参数
- 凭证形态判定：三段点分 JWT → Coding Plan 端点；其余 → Z.AI 回退端点
- 上游错误码如实透传（供 router 的密钥池判活）
- 向 xrl-router 注册（plugin_id / provider / models / keys）+ 心跳 + 密钥同步
- `pnpm login` 取 Coding Plan JWT、`pnpm capture-key` 做凭证体检

### 非目标（明确排除）

- **不做密钥轮换 / 重试 / 用量统计** — 这是 xrl-router 的职责（`api/proxy/key_rotation.rs`）
- **不做协议转换** — 本插件注册 `kind=messages`，router 的 IR 层（`api/proxy/ir/`）已负责客户端三种协议 ↔ Messages 的双向转换。**不要**在插件里加 OpenAI ↔ Messages 的转换代码
- **不做本地模型推理** — 纯桥接，所有请求走 ZCode 远端
- **不做多账号轮询 / 额度耗尽换号** — 交给 router 的密钥池：插件如实透传 402/429，router 自动换下一把密钥
- **不做后台管理 UI / SQLite 账号池** — 那是 zcode2api 的形态，不是插件的形态
- **不做 api.z.ai 的付费 API Key 兑换** — 本项目聚焦额度反代，`scripts/login.ts` 只取 Coding Plan JWT，不调 `exchange_api_key`
- **不实现非 Messages 端点** — `/v1/models`、`/v1/embeddings`、`/v1/chat/completions` 一律不加（模型清单经 WebSocket 注册推送）
- **不实现本地 HTTP 鉴权** — router 已用密钥池管控；插件对直连调用只做「有没有凭证」的粗检

## Agent 操作指南

### 全局规则

- **包管理器：pnpm**（不要用 npm）。依赖走中国境内镜像（`.npmrc` 已配 npmmirror）
- **执行任何改动前先跑 `pnpm e2e`**了解基线；改完必须再跑一次且全绿
- **契约优先**：`pnpm e2e` 覆盖的是对外行为契约（协议透传、错误码映射、注册载荷）。改这些行为必须同步改断言
- 提交遵循约定式提交（`feat:` / `fix:` / `docs:` / `chore:` / `test:`）

### 改代码前先看这三条设计判断

1. **为什么注册 `messages` 而不是 `chat_completions`** — 见 `src/zcode/client.ts` 顶部与 `docs/DECISIONS.md` D-1
2. **为什么错误码必须如实透传、唯独验证码失败要转 502** — 见 `src/zcode/client.ts` 顶部与 D-2
3. **为什么模型清单要分 `model_id` / `display_name`** — 见 `src/zcode/models.ts` 顶部与 D-4

## 目录速查

```
src/
├── index.ts            Express 入口：/、/health、POST /v1/messages、启动与优雅退出
├── config.ts           Settings 单例：全部环境变量只在这里读
├── port.ts             启动前释放端口（跨平台，排除自身 PID）
├── pluginClient.ts     WS：注册 / 心跳 / keys_update / 指数退避重连
└── zcode/
    ├── client.ts       转发主流程：凭证分流、错误映射、SSE 透传 / 非流式聚合
    ├── auth.ts         纯函数：凭证形态判定、上游请求构造、错误分类
    ├── configs.ts      上游 client/configs：验证码场景参数 + 模型清单自动发现（带缓存）
    ├── captcha.ts      验证码管理器：TTL 缓存 / 并发去重 / 重试
    ├── solver.ts       子进程调用求解器
    ├── aggregate.ts    Anthropic SSE → 单条 message JSON
    └── models.ts       模型清单解析与名称归一化

captcha/solver.cjs      jsdom 无痕验证求解器（移植自 zcode2api，子进程运行）

scripts/
├── login.ts            pnpm login：OAuth → Coding Plan JWT → 写入 .env
├── capture-key.ts      pnpm capture-key：只读体检 + 查额度
├── e2e.ts              pnpm e2e：离线端到端自测（mock 上游 + mock router）
├── envFile.ts          .env 读写与密钥安全闸
└── mock-solver.cjs     e2e 用的假求解器

docs/
├── PRD.md / ARCHITECTURE.md / DECISIONS.md
├── reverse/ZCODE_REVERSE.md
└── specs/module-*.md
```

## 密钥安全边界

- `.env` 永不进 git —— `git check-ignore .env` 必须通过（`scripts/envFile.ts` 里有强制闸）
- `.env.example` 必须可入库（只放占位符，不放真实凭证）
- 写 `.env` 的脚本一律先过 `assertEnvIgnored()`
- 日志与终端输出中的凭证一律脱敏（`maskSecret()`）
- 只从自己登录的账号取凭证

## 已知限制（不要尝试修复）

| 现状 | 为什么不要修 |
|------|-------------|
| **Coding Plan 路径被阿里云风控拒（F001）** | 求解链路本身没错，是服务端风险策略拒绝 jsdom 环境。出路见 `docs/DECISIONS.md` D-9——**先跟用户确认再动手**，不要在 jsdom 指纹桩上继续无边界试错 |
| 模型清单自动发现依赖上游接口 | 失败即降级到内置默认值，不阻塞；这是设计而非缺陷（D-8） |
| `client/configs` 不能带查询参数 | 上游行为，带上就 `parameter error`；已加 e2e 断言防回归 |
| 无痕验证依赖 jsdom 跑阿里云混淆 SDK | 上游更新指纹逻辑时需同步调整桩件，这是该方案的固有成本 |
| 额度字段结构未充分实测 | 无长期可用账号验证，`capture-key` 已做防御性解析 |

## 给 AI Agent 的指引

### 必须拒绝的任务

1. **「把 API Key 回退通道删掉」** → 它是 Coding Plan 被风控阻塞时唯一可用的出口
2. **「在插件里加 OpenAI ↔ Messages 协议转换」** → Non Goal，router 的 IR 层已有
3. **「在插件里加账号轮询 / 额度统计 / 后台 UI」** → router 的职责，见 D-6
4. **「把密钥池写进插件」** → 会造成两份不同步的密钥池，D-6 踩过这个坑
5. **「无限期调 jsdom 指纹桩直到绕过风控」** → 先读 D-9 的取舍，向用户确认方向

### 允许的任务方向

- 增强 e2e 断言（尤其是错误码契约与注册契约）
- 新增上游业务头 / 调整模型归一化规则
- 优化 WebSocket 重连策略
- 按 D-9 的出路换用真实无头浏览器（需用户明确同意依赖变更）
