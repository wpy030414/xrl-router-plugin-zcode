# 逆向成果 — ZCode（zcode.z.ai）

> 本文件记录本插件所依赖的 ZCode 上游事实。**绝大部分来自社区项目
> [zcode2api](https://github.com/liu5269/zcode2api)（AGPL-3.0）的公开逆向结论**，
> 本仓库只做转述、最小验证与工程化，没有独立逆向。
>
> 凭证属于个人资产，请只使用自己登录的账号。以下所有内容仅作技术记录。

---

## 1. 上游端点

| 用途 | 端点 | 凭证形态 | 无痕验证 |
|------|------|----------|----------|
| 推理（主） | `https://zcode.z.ai/api/v1/zcode-plan/anthropic/v1/messages` | Coding Plan JWT | **需要** |
| 推理（回退） | `https://api.z.ai/api/anthropic/v1/messages` | Z.AI API Key | 不需要 |
| 计费 / 套餐 | `https://zcode.z.ai/api/v1/zcode-plan/billing/current` | JWT | 不需要 |
| 额度 | `https://zcode.z.ai/api/v1/zcode-plan/billing/balance` | JWT | 不需要 |
| 用量 | `https://zcode.z.ai/api/v1/zcode-plan/usage` | JWT | 不需要 |
| 验证码场景配置 | `https://zcode.z.ai/api/v1/client/configs?app_version=…&platform=…` | 无 | — |
| OAuth 初始化 | `https://zcode.z.ai/api/v1/oauth/cli/init` | 临时 poll token | — |
| OAuth 轮询 | `https://zcode.z.ai/api/v1/oauth/cli/poll/{flow_id}` | 临时 poll token | — |

三者（主/回退/计费）在本插件里分别由 `ZCODE_BASE_URL` / `ZAI_FALLBACK_URL` / `ZCODE_BILLING_BASE` 覆盖。

## 2. 请求头

主端点（JWT 形态）必须携带：

| 头 | 值 | 说明 |
|----|----|------|
| `Authorization` | `Bearer <JWT>` | Coding Plan 凭证 |
| `Anthropic-Version` | `2023-06-01` | Messages 协议版本 |
| `Content-Type` | `application/json` | |
| `X-Aliyun-Captcha-Verify-Param` | `<verifyParam>` | **无痕验证参数**，见第 3 节 |
| `X-ZCode-App-Version` | `3.0.1` | 客户端身份标识 |
| `X-ZCode-Agent` | `glm` | 客户端身份标识 |
| `HTTP-Referer` | `https://zcode.z.ai/` | |
| `User-Agent` | `ZCode/3.0.1` | |

`X-ZCode-*` 三个头是客户端身份标识，缺失或伪造容易被上游拒绝。本插件通过
`ZCODE_APP_VERSION` / `ZCODE_AGENT` / `ZCODE_USER_AGENT` 暴露为可配置项。

## 3. 无痕验证（阿里云）

Coding Plan（JWT）模式**必需**，API Key 模式不需要。

- 请求头 `X-Aliyun-Captcha-Verify-Param` 的值是
  `base64(JSON{certifyId, sceneId, isSign, securityToken})`，**由阿里云服务端签发**——
  本地无法凭空构造。
- 获取方式：在浏览器环境里加载阿里云官方 SDK（`o.alicdn.com/captcha-frontend/aliyunCaptcha/AliyunCaptcha.js`），
  调用 `initAliyunCaptcha(...)` 后在 `getInstance` 回调里执行 `startTracelessVerification()`，
  由 `success` 回调吐出该参数。
- **本项目的做法**：不启动真实浏览器，用 **Node + jsdom** 模拟浏览器环境跑同一份 SDK，
  并补齐 SDK 依赖的浏览器 API 桩（`matchMedia`、canvas / WebGL、`Worker`、`OffscreenCanvas`）。
  实现见 `captcha/solver.cjs`。
- 场景参数（`sceneId` / `region` / `prefix`）优先从 `client/configs` 接口取，失败回退内置默认值
  `11xygtvd` / `sgp` / `no8xfe`。

> ⚠️ 该参数有时效性。本插件缓存 45s（`ZCODE_CAPTCHA_CACHE_TTL`），
> 遇到上游 403 + captcha 字样时立即失效重求。

## 4. 凭证与登录

- **Coding Plan 凭证** = OAuth 产出的 JWT，三段点分（`a.b.c`）。本插件以此作为形态判据。
- **登录流程**（`pnpm login`，`scripts/login.ts`）：

  ```
  POST /oauth/cli/init   Authorization: Bearer <临时 poll token>   {"provider":"zai"}
        → { flow_id, authorize_url }
  浏览器完成授权
  GET  /oauth/cli/poll/{flow_id}   Authorization: Bearer <同一个 poll token>
        → status: pending | ready | failed
        ready 时 data.token 即 Coding Plan JWT
  ```

- 轮询用的临时 token 由本地随机生成，与最终凭证无关。
- zcode2api 在 `ready` 后还会走一条 `api.z.ai` 的兑换链把 OAuth `access_token` 换成付费 API Key。
  **本插件不做这一步**（见 `AGENTS.md` 的 Non Goals）。

## 5. 模型名

上游模型名**大小写敏感**。社区公布的可用清单是 `GLM-5.2` 与 `GLM-5-Turbo`
（另有 `GLM-5.1` / `GLM-4.7` 出现在模型名映射表里）。

本插件不硬编码上游模型集：`ZCODE_MODELS` 是权威来源，未配置时回退到
`GLM-5.2,GLM-5-Turbo` 并在启动时告警。详见 `docs/DECISIONS.md` D-4。

## 6. 错误语义（对插件行为起决定作用）

| 上游表现 | 含义 | 本插件 |
|----------|------|--------|
| 403 + 含 `captcha` / `verify token` / `verify failed` / `人机` | 无痕验证失效 | 刷新验证码重试；连续失败后返回 502 |
| 402 或错误体含 `quota` / `insufficient` / `balance` / `额度` / `余额不足` | 额度耗尽 | 原样透传 402 |
| 401 / 403（非验证码） | 凭证失效 | 原样透传 |
| 429 | 限流 | 原样透传 |

> 这套判定是启发式的，zcode2api 的作者也明确表示额度字段与耗尽信号
> **未在付费账号上充分实测**。若真实行为与此不符，以真实上游为准。

## 7. 未验证 / 存疑事项

- `billing/current`、`billing/balance`、`usage` 的字段结构（`total_units` / `used_units` /
  `remaining_units` / `expires_at` 等）来自观测，不同套餐可能不一致
- 额度耗尽的判定关键词为启发式
- `/api/v1/client/configs` 目前对带参请求返回 `{"code":3001,"msg":"parameter error"}`，
  因此**必须有内置回退场景参数**（本插件已做，并对其失败做 60s 负缓存）
- 无痕验证 SDK 的指纹逻辑（feilin / cloudauth-device）若更新，jsdom 桩件可能需要调整

## 8. 致谢与许可

- 上游协议结论、无痕验证方案、`captcha/solver.cjs` 的原型均来自
  [liu5269/zcode2api](https://github.com/liu5269/zcode2api)（AGPL-3.0）。
  本仓库的 `captcha/solver.cjs` 是该项目的移植版，保留同样的许可约束。
- UI 设计参考：[chenyme/grok2api](https://github.com/chenyme/grok2api)
- 社区讨论：[linux.do](https://linux.do)
