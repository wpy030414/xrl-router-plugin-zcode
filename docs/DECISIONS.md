# DECISIONS

> 本文件记录关键设计决策背后的**历史原因**，防止架构漂移。
> 每条决策回答的是「为什么」而非「怎么做」。

---

## D-1: 为什么注册 `kind: "messages"` 而不是 `chat_completions`？

**背景**：qwenwork 插件注册的是 `kind: "openai"`（router 归一为 `ChatCompletions`），并在插件里做「解包外层 SSE envelope → 重组 tool_calls 分片」的转换工作。照抄那条路似乎是默认选择。

**观察**：ZCode 上游**本身就是 Anthropic Messages 端点**。同时 router 已实现完整 IR 协议层（`api/proxy/ir/`）：

- 请求方向：客户端三种协议 → IR → 按 `provider_kind` 渲染成上游格式（`stream.rs:288`）
- 响应方向：上游 SSE → 按 `provider_kind` 解析 → IR → 渲染回客户端格式（`forward.rs:175`）
- `provider_kind == "messages"` 时 router 注入 `x-api-key` + `anthropic-version: 2023-06-01`（`stream.rs:308`）

**决策**：注册 `kind: "messages"`、`api_path: "/v1/messages"`，插件**原样透传字节流**。

**收益**：

- 插件零协议转换代码——整个 `zcode/client.ts` 的转发部分是纯 I/O
- 不会出现「router 转了、插件又转一遍」的双重转换 bug
- 客户端可以用 Anthropic / OpenAI / Responses 任意协议调用，转换责任单一归属 router

**为什么不选 `chat_completions`**：那等于让插件把上游的 Messages SSE 反解成 Chat Completions，再由 router 转回客户端格式——一次无谓的往返，且 tool_calls 分片重组在 qwenwork 里已被证明容易出错（见其 `client.ts` 的 `seenToolCallIndex` 逻辑）。

**何时重新审视**：若将来需要暴露非 Messages 的上游语义（例如 ZCode 上线了独立的 Chat Completions 端点且行为不同）。

---

## D-2: 为什么错误码如实透传，唯独验证码失败要转 502？

**背景**：插件需要把上游错误上报给 router，而 router 会据此改变密钥池状态。

**证据**：`src-tauri/src/api/proxy/key_rotation.rs`：

```rust
401 | 403 => { pool.mark_key_invalid(provider_id, key); }   // 标红
402 | 429 => { pool.mark_key_low_quota(provider_id, key); } // 标黄
// 5xx 与其余 4xx 不触碰密钥池
```

**决策**：分两类处理。

1. **凭据级错误如实透传**（401 / 402 / 403 非验证码 / 429）——这正是 router 用来轮换密钥的信号。插件不做任何「聪明」的改写，否则账号轮换（比如第二个账号还有额度）就不会发生。
2. **验证码失败转 502**——上游对无痕验证问题返回 `403 + captcha 关键字`。若原样透传，router 会把一把完全有效的 JWT 标红；而实际故障在插件侧的求解链路。因此插件先内部刷新重试（`MAX_CAPTCHA_REFRESH = 3`），仍失败则返回 **502**——5xx 不触碰密钥池，语义正确。

**代价**：若某个上游真的用「403 + 含 verify 字样」表达凭证失效，会被我们误判为验证码问题，重试 3 次后返回 502，router 不标红而只是重试。这个方向上我们**刻意偏向「不误伤好密钥」**。

**何时重新审视**：若观测到 ZCode 的凭证失效错误体里确实带 captcha/verify 字样。

---

## D-3: 为什么验证码求解器是子进程，而不是 in-process？

**背景**：求解器需要在 jsdom 里以 `runScripts: 'dangerously'` 加载阿里云官方混淆 SDK（53 行，移植自 zcode2api）。

**考虑过的方案**：

- **in-process `new JSDOM()`**——省一次进程 spawn，但混淆 SDK 崩溃会带走插件主进程，且无法用超时强杀
- **子进程 `spawn('node', ['captcha/solver.cjs', ...])`**——每次求解一次进程启动开销（~百毫秒级）

**决策**：子进程。

**原因**：求解天然是「可能失败、可能挂死」的操作，而它处在请求主路径上。隔离换来的性质更值钱：

- 单次求解可以被 `ZCODE_CAPTCHA_TIMEOUT`（默认 40s）强杀
- SDK 崩溃只丢一次求解，不丢整个插件
- 求解器可以用一个假脚本整体替换（`ZCODE_SOLVER_PATH`），这正是 `pnpm e2e` 能做到离线全绿的前提

**代价**：每次求解多一次进程启动。但求解有 45s TTL 缓存 + 并发去重，频率是「每分钟约一次」而非「每请求一次」，开销可忽略。

---

## D-4: 为什么模型清单要分 `model_id` 与 `display_name`？

**背景**：ZCode 上游的模型名**大小写敏感**（社区文档记录为 `GLM-5.2` / `GLM-5-Turbo`），而客户端喜欢写 `glm-5.2`。

**证据**：router 用 `display_name` 匹配客户端请求，然后把 `model_id` 填进上游请求体：

```rust
// api/proxy/stream.rs
obj.insert("model".to_string(), json!(cand.real_model_id));
```

**决策**：`ZCODE_MODELS` 支持 `模型ID=展示名` 语法。

```
ZCODE_MODELS=GLM-5.2=glm-5.2,GLM-5-Turbo
```

- `model_id` = 上游接受的形式（原样透传，不做大小写改写）
- `display_name` = 客户端调用的别名（省略则等于 `model_id`）

同时 `canonicalModelId()` 在插件侧做归一化：精确匹配 → 忽略大小写匹配 modelId → 忽略大小写匹配 displayName → 剥离 `provider/` 前缀后重试。这样直连插件（绕过 router）的调用也能用任意写法。

**为什么不统一成小写**：上游大小写敏感，改写上游名等于制造 404。保留原样才是安全的默认。

---

## D-5: 为什么上游一律按 `stream: true` 请求？

**背景**：`xrl-router` 无论客户端是否流式，都强制 `stream: true` 发上游（`stream.rs` 与 `non_stream.rs` 都是 `obj.insert("stream", json!(true))`），再自己聚合。

**决策**：插件沿用同一策略——**无条件向上游要流式**，客户端要非流式时由 `aggregate.ts` 聚合 SSE。

**原因**：

- 与 router 的行为一致，避免「router 要流式、插件却发了非流式」的错配
- 上游的非流式行为未被充分验证，流式是社区已验证的路径（zcode2api 全程流式）
- 少一条依赖上游行为的代码分支

**代价**：非流式请求要多走一次 SSE 聚合。但 router 发来的请求永远是 `stream: true`，这条路径只对直连调用有意义。

---

## D-6: 为什么不做 zcode2api 那套后台 UI / 账号池？

**背景**：社区项目 `zcode2api` 是独立网关，带 SQLite 账号池、round-robin 轮询、额度监控、后台管理 UI、Docker 部署。看起来「功能更全」。

**决策**：不照搬。插件只做 xrl-router 缺的那一层。

**原因**：那些能力在 xrl-router 里**已经存在且更成熟**：

| zcode2api 的能力 | xrl-router 的对应物 |
|------------------|---------------------|
| 多账号 round-robin | 密钥池轮换（`api/proxy/key_rotation.rs`） |
| 额度用完自动换号 | 402/429 → 标记 → 换下一把 key |
| 限流冷却后恢复 | `api/proxy/failover.rs` 的 provider cooling |
| 用量监控 | `usage_log` 表 + 用量统计模块 |
| 后台鉴权 / 管理 UI | router 的密钥管理界面 |

把账号池放进插件会制造**两份互相不同步的密钥池**——这正是 qwenwork 项目在 D-1 里踩过的坑（旧架构自带 key pool，与 router 重复，同步困难，最终整体删掉）。

**边界**：`ZCODE_KEYS` 支持多个逗号分隔凭证，但插件**只是把它们推给 router**，自己从不选择用哪一把。

---

## D-7: 为什么密钥的权威来源是 `.env` 文件，而不是进程环境变量？

**背景**：插件用 5s 轮询 `.env` 发现密钥变化，再 `keys_update` 推给 router。

**决策**：以 `.env` 文件为权威来源；文件里没写时才回退 `process.env`。

**原因**：

- **可热更新**：进程环境变量在启动后无法改变，改密钥必须重启插件。`.env` 轮询让 `pnpm login` 写完就能立刻生效
- **与环境变量不冲突**：回退分支保证容器 / CI 里直接注入 `ZCODE_KEYS` 也能工作

**没选 `fs.watch`**：跨平台行为不一致（inotify vs FSEvents vs ReadDirectoryChangesW），且需要额外处理编辑器写文件的中间态。5s 轮询的开销是「每 5 秒读一个 <1KB 文件」，与 qwenwork 的项目决策一致。
