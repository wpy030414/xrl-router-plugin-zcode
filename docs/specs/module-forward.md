# Spec — 转发（module-forward）

## 要构建什么

`POST /v1/messages` 的处理链路：从入站请求取凭证 → 判定形态 → 装上游头 → 转发 → 按客户端期望返回流式或聚合结果，并把上游错误如实映射成 router 能读懂的信号。

实现：`src/zcode/client.ts`（主流程）、`src/zcode/auth.ts`（纯函数）、`src/zcode/aggregate.ts`（聚合）。

## 行为

### 凭证提取

1. 优先 `x-api-key`（xrl-router 对 `kind=messages` 供应商注入此头）
2. 其次 `Authorization: Bearer <token>`
3. 都没有 → `401` + Anthropic 形态错误体

### 形态判定

凭证含两个 `.` 且各段非空 → `jwt`；否则 `apiKey`。

### 上游选择与请求头

| 形态 | 端点 | 凭证头 | 无痕验证头 |
|------|------|--------|-----------|
| `jwt` | `ZCODE_BASE_URL` | `Authorization: Bearer` | 带上 |
| `apiKey` | `ZAI_FALLBACK_URL` | `x-api-key` | 不带 |

两种形态都带：`content-type`、`anthropic-version: 2023-06-01`、`user-agent`、`x-zcode-app-version`、`x-zcode-agent`、`http-referer`。

### 请求体

- `model` 归一化为上游接受的形式（规则与理由见 `docs/DECISIONS.md` D-4，实现见 `src/zcode/models.ts`）
- `stream` **强制为 `true`**
- 其余字段原样透传

### 响应

| 客户端 `stream` | 行为 |
|-----------------|------|
| `true` | 上游 SSE 字节流**原样透传**（含 Content-Type），逐块读写并处理背压 |
| `false` | 上游仍是 SSE，由 `aggregateAnthropicStream` 聚合成单条 message JSON |

### 错误映射

| 上游响应 | 插件行为 |
|----------|----------|
| 2xx | 成功路径 |
| 401 / 402 / 403（非验证码）/ 429 | 原样透传状态码与响应体 |
| 403 / 400 且命中验证码关键词（`captcha` / `verify token` / `verify failed` / `verify_param` / `无痕` / `人机`） | `captchaManager.invalidate()` → 重试；连续 `MAX_CAPTCHA_REFRESH`(3) 次仍失败 → **502** |
| 其他非 2xx | 原样透传 |
| 网络失败 / 超时 | `502` |
| 无痕验证求解失败（拿不到参数） | `502` |

### 连接生命周期

- 客户端断开（`res` 的 `close` 且未 `writableEnded`）→ `AbortController.abort()` 取消上游请求
- 上游流读取中断 → 关闭响应，不抛穿

## 输入 / 输出

- **输入**：Anthropic Messages 请求体 + 凭证头
- **输出**：`text/event-stream` 字节流（透传），或 `application/json` 单条 message（聚合），或 Anthropic 形态错误体

## 约束

- 不做任何协议转换（router 的 IR 层负责）
- 不改写凭证级错误的状态码（那会破坏 router 的密钥轮换）
- 不在插件内选择用哪一把密钥（router 的职责）

## 边界条件

- 空 body / 非对象 body → 按 `{}` 处理，`model` 为空则原样透传，让上游报错
- 上游返回 2xx 但内容不是 SSE → 聚合器回退为「整个响应体当 JSON 解析」
- `content_block_stop` 时 `partial_json` 拼不成合法 JSON → 原样保留字符串而不吞掉
- 上游 `body` 为空（如 204）→ 聚合路径返回 502，透传路径直接结束响应

## 验收标准

- [x] `pnpm e2e` 第 1 节：`/`、`/health` 结构、404、无凭证 401
- [x] `pnpm e2e` 第 2 节：SSE 字节与上游逐帧一致；`stream` 被强制为 `true`
- [x] `pnpm e2e` 第 3 节：非流式聚合出正确文本 / `stop_reason` / `usage`
- [x] `pnpm e2e` 第 4 节：`glm-5.2` / `zai/GLM-5-Turbo` / `glm-5-turbo` 三种写法都归一化正确
- [x] `pnpm e2e` 第 5 节：JWT 与 API Key 各自走对端点、带对头
- [x] `pnpm e2e` 第 7 节：402 / 429 / 401 原样透传；验证码持续失败返回 502；失效一次能自愈

## 完成定义

`pnpm e2e` 全绿且 `pnpm typecheck` 无错，并且上面每条验收都能在 `scripts/e2e.ts` 里指出对应的断言。
