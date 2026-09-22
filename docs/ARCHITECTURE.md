# ARCHITECTURE — xrl-router-plugin-zcode

## 系统概述

本插件是 xrl-router 的**委托供应商**：一个独立进程，对内暴露一个本地 HTTP 端点，对外通过 WebSocket 把自己登记进 router。

```
客户端（Claude Code / CCSwitch / 任意 OpenAI 兼容客户端）
   │  /v1/messages · /v1/chat/completions · /v1/responses
   ▼
xrl-router :19068
   │  ├─ IR 协议层：客户端协议 ↔ Anthropic Messages 双向转换
   │  ├─ 密钥池：选 key、按状态码判活、轮换
   │  └─ 用量统计 / 故障转移 / 组合
   │  HTTP POST http://localhost:19065/v1/messages
   │        头：x-api-key: <该 provider 池里的一把 key>
   ▼
xrl-router-plugin-zcode :19065
   │  ├─ 判定凭证形态（三段点分 JWT / 其他）
   │  ├─ JWT → 取无痕验证参数（jsdom 子进程求解，TTL 缓存）
   │  ├─ 装 ZCode 业务头
   │  └─ 流式透传 / 非流式聚合
   │  HTTPS POST
   ▼
zcode.z.ai/api/v1/zcode-plan/anthropic/v1/messages   （JWT，需验证码）
api.z.ai/api/anthropic/v1/messages                    （API Key 回退）
   ▲
   └─ WebSocket /ws/plugin：register / heartbeat / keys_update
```

## 核心模块

| 模块 | 文件 | 职责 |
|------|------|------|
| 入口 | `src/index.ts` | Express 应用、路由、启动横幅、优雅退出；导出 `createApp()` 供测试 |
| 配置 | `src/config.ts` | Settings 单例；所有环境变量只在这里读一次 |
| 端口 | `src/port.ts` | 启动前释放被占端口（netstat/lsof + taskkill/kill，排除自身 PID） |
| 插件客户端 | `src/pluginClient.ts` | WebSocket 注册 / 心跳 / 密钥同步 / 指数退避重连 |
| 转发 | `src/zcode/client.ts` | 转发主流程：凭证分流、验证码获取、错误映射、透传或聚合 |
| 凭证与请求构造 | `src/zcode/auth.ts` | 纯函数：`classifySecret` / `extractSecret` / `buildUpstreamRequest` / `isCaptchaRejection` |
| 验证码管理 | `src/zcode/captcha.ts` | 场景配置拉取（带回退）、TTL 缓存、并发去重、重试、`invalidate()` |
| 求解器调用 | `src/zcode/solver.ts` | 子进程调用 `captcha/solver.cjs`，超时强杀，解析 `VERIFY_PARAM=` |
| 求解器 | `captcha/solver.cjs` | jsdom 中加载阿里云 SDK，跑 `startTracelessVerification` |
| SSE 聚合 | `src/zcode/aggregate.ts` | Anthropic SSE 事件流 → 单条 message JSON |
| 模型清单 | `src/zcode/models.ts` | `ZCODE_MODELS` 解析（`模型ID=展示名`）、名称归一化 |

## 模块关系

- `index.ts` 只做装配：`createApp()` 建 Express，路由把 `POST /v1/messages` 交给 `client.ts`
- `client.ts` 依赖 `auth.ts`（纯函数）、`captcha.ts`（有状态单例）、`aggregate.ts`
- `captcha.ts` → `solver.ts` → 子进程 `solver.cjs`：**单向、无回调**
- `pluginClient.ts` 与转发链路**完全解耦**——WS 断开不影响本地转发能力，反之亦然
- `config.ts` 被所有模块读、不被任何模块写；`models.ts` 的解析结果在 `config.ts` 里完成

## 数据流

### 一次流式请求（主路径）

```
1. router 选 key → POST /v1/messages  +  x-api-key: <secret>
2. extractSecret → classifySecret
3. 若 JWT：captchaManager.getVerifyParam()   ← 命中缓存则零成本
4. buildUpstreamRequest → fetch（signal 绑定客户端连接）
5. 上游 2xx → pipeStream：逐块 read → write，写不动就等 drain
6. 上游非 2xx → 见下表
```

### 错误映射（决定了 router 是否会轮换密钥）

| 上游响应 | 插件行为 | router 反应 |
|----------|----------|-------------|
| 2xx | 透传 / 聚合 | 成功，密钥标绿 |
| 401 / 403（非验证码） | 原样透传 | 密钥标红，换下一把 |
| 402 / 429 | 原样透传 | 密钥标黄，换下一把 |
| 403 / 400 + captcha 关键字 | 刷新验证码重试；连续 `MAX_CAPTCHA_REFRESH`(3) 次仍失败 → **502** | 5xx 不动密钥池 |
| 5xx | 原样透传 | 不动密钥池（可能触发 provider 级 failover） |

### 无痕验证求解

```
captchaManager.getVerifyParam()
  ├─ 缓存命中（TTL 45s）→ 直接返回
  └─ 未命中 → inflight 去重 → fetchSceneConfig()
                                ├─ 成功 → 缓存 600s
                                └─ 失败 → 回退 env/内置默认值，负缓存 60s
                              → spawn node captcha/solver.cjs <scene> <region> <prefix>
                                ├─ jsdom + 浏览器 API 桩（matchMedia/canvas/WebGL/Worker/OffscreenCanvas）
                                ├─ 加载 o.alicdn.com 的 AliyunCaptcha.js
                                └─ initAliyunCaptcha → success 回调 → stdout: VERIFY_PARAM=...
                              → 写缓存
```

## 外部系统

| 系统 | 用途 | 失败时的行为 |
|------|------|-------------|
| xrl-router `/ws/plugin` | 注册、心跳、密钥同步 | 指数退避重连（1s → 最大 60s）；本地转发不受影响 |
| `zcode.z.ai` 推理端点 | JWT 形态的主上游 | 按上表映射 |
| `zcode.z.ai/api/v1/client/configs` | 拉验证码场景参数 | 回退内置默认值并负缓存 |
| `zcode.z.ai/api/v1/zcode-plan/*` | 额度 / 套餐 / 用量查询 | 仅 `pnpm capture-key` 使用，失败只影响体检输出 |
| `api.z.ai` 推理端点 | API Key 形态的回退上游 | 按上表映射 |
| `o.alicdn.com` | 阿里云无痕 SDK | 求解失败 → 重试 → 502 |

## 重要技术边界

1. **插件不做协议转换。** 注册 `kind: "messages"` 是刻意的：router 的 IR 层已经把三种客户端协议与 Messages 互转，插件再做一次是重复且易错。见 `DECISIONS.md` D-1。
2. **插件不做密钥轮换。** 它没有密钥列表（除了注册时推给 router 的那一份），看不见 router 用哪把 key，也不该看见。轮换靠「如实透传状态码」这一件事驱动，见 D-2。
3. **验证码求解在子进程。** jsdom 需要 `runScripts: 'dangerously'` 跑混淆 SDK，隔离出去才能超时强杀、崩溃不污染主进程，见 D-3。
4. **上游一律按流式请求。** 非流式客户端由插件聚合，避免依赖上游的非流式行为是否可用，见 D-5。
