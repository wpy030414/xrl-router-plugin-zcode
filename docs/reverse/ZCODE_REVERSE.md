# 逆向成果 — ZCode（zcode.z.ai）

> 本文件记录本插件所依赖的 ZCode 上游事实。
>
> 来源分两类，**分别标注**：
> - **【转述】** 来自社区项目 [zcode2api](https://github.com/liu5269/zcode2api)（AGPL-3.0）的公开逆向结论
> - **【实测】** 本仓库 2026-09-22 对公开接口的直接观测（无需凭证即可复现）
>
> 凭证属于个人资产，请只使用自己登录的账号。以下内容仅作技术记录。

---

## 1. 上游端点

| 用途 | 端点 | 凭证形态 | 无痕验证 |
|------|------|----------|----------|
| 推理（主） | `https://zcode.z.ai/api/v1/zcode-plan/anthropic/v1/messages` | Coding Plan JWT | **需要** |
| 推理（回退） | `https://api.z.ai/api/anthropic/v1/messages` | Z.AI API Key | 不需要 |
| 计费 / 套餐 | `https://zcode.z.ai/api/v1/zcode-plan/billing/current` | JWT | 不需要 |
| 额度 | `https://zcode.z.ai/api/v1/zcode-plan/billing/balance` | JWT | 不需要 |
| 用量 | `https://zcode.z.ai/api/v1/zcode-plan/usage` | JWT | 不需要 |
| **客户端配置** | `https://zcode.z.ai/api/v1/client/configs` | **无需凭证** | — |
| OAuth 初始化 | `https://zcode.z.ai/api/v1/oauth/cli/init` | 临时 poll token | — |
| OAuth 轮询 | `https://zcode.z.ai/api/v1/oauth/cli/poll/{flow_id}` | 临时 poll token | — |

三者（主/回退/计费）在本插件里分别由 `ZCODE_BASE_URL` / `ZAI_FALLBACK_URL` / `ZCODE_BILLING_BASE` 覆盖。

**【实测】`/api/v1/client/configs` 不能带任何查询参数。**
带 `?app_version=…&platform=…` 会返回 `{"code":3001,"msg":"parameter error"}`；
不带参数才返回完整配置。（zcode2api 用的是带参形式，已失效。）

无凭证直接打推理端点会得到 `401`，说明鉴权在验证码之前生效。

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
  并补齐 SDK 依赖的浏览器 API 桩。实现见 `captcha/solver.cjs`。

**【实测】场景参数**（来自 `client/configs`）：

```json
{ "enabled": true, "prefix": "no8xfe", "region": "cn", "sceneId": "11xygtvd" }
```

⚠️ `region` 是 **`cn`**；社区旧文档里的 `sgp` 已过期。

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

## 5. 模型清单

**【实测】** `client/configs` 返回三组模型信息：

| 字段 | 内容 | 用途 |
|------|------|------|
| `builtinModels` | `GLM-5.3`、`GLM-5.3-Flash`（1M 上下文 / 128k 输出） | 上游针对当前套餐的**推荐清单** |
| `builtinProviders[]` | `builtin:bigmodel` / `builtin:zai-coding-plan` / `builtin:zai` / `team-plan:builtin`，`defaultModel: GLM-5.3` | 套餐 / 通道定义 |
| `providers[]` | `bigmodel`、`z-ai`（各含 anthropic 与 openai:chat 两种 schema），models 为 `GLM-5.2`、`GLM-5-Turbo` | **自带 API Key** 通道 |

本插件只取 `builtinModels`——`providers[]` 属于「自带 Key」通道，混进来会注册出套餐里用不了的模型。

上游模型名**大小写敏感**。真实清单会变（社区文档记录的 `GLM-5.2`/`GLM-5-Turbo` 已被 `builtinModels`
取代），因此本插件**不硬编码**：`ZCODE_MODELS` 优先，未配置则启动时从 `builtinModels` 自动发现，
再不行才用内置默认值。详见 `docs/DECISIONS.md` D-8。

## 6. 错误语义（对插件行为起决定作用）

| 上游表现 | 含义 | 本插件 |
|----------|------|--------|
| 401（无/坏凭证） | 鉴权失败 | 原样透传 → router 标红 |
| 403 + 含 `captcha` / `verify token` / `verify failed` / `人机` | 无痕验证失效 | 刷新验证码重试；连续失败后返回 502 |
| 402 或错误体含 `quota` / `insufficient` / `balance` / `额度` / `余额不足` | 额度耗尽 | 原样透传 402 → router 标黄并换密钥 |
| 429 | 限流 | 原样透传 |
| 401 / 403（非验证码） | 凭证失效 | 原样透传 |

> 额度字段与耗尽判定是启发式的，zcode2api 的作者也明确表示**未在付费账号上充分实测**。
> 若真实行为与此不符，以真实上游为准。

## 6.5 【实测】无痕验证当前被风控拒绝（F001）⚠️

**这是本插件目前最大的未决问题。**

用 `captcha/solver.cjs` 在 2026-09-22 实跑，链路本身是通的：

```
[debug] initAliyunCaptcha 已就绪
[jsdom xhr] POST https://no8xfe.captcha-open.aliyuncs.com/
[jsdom xhr] POST https://cloudauth-device-dualstack.cn-shanghai.aliyuncs.com
[debug] getInstance，开始无痕验证
[debug] SDK fail 回调 {"success":true,"verifyResult":false,"verifyCode":"F001","certifyId":"S2cJzuyWmg"}
```

- SDK 加载成功、走到 `getInstance`、向阿里云发起了设备指纹与验证请求、**拿到了 `certifyId`**
- 但服务端风险判定为 `verifyResult: false, verifyCode: "F001"`

`F001` 的官方含义是「**疑似攻击请求，风险策略不通过**」（阿里云验证码 2.0 客户端返回码说明）。
它不是「虚拟设备」那个码（那是 `F009`），说明风控没有直接认出 jsdom，而是综合信号判定为高风险。

试过的缓解手段（**均未改变结果**）：

| 手段 | 结果 |
|------|------|
| jsdom 默认 UA（含 `jsdom` 字样）→ 换成真实 Chrome UA | 仍 F001 |
| `navigator.webdriver = false` / 补 `languages` / `platform` / `hardwareConcurrency` | 仍 F001 |
| `window.chrome` 桩、`screen` 尺寸补全 | 仍 F001 |
| `region` 由 `sgp` 改为上游公布的 `cn` | 仍 F001 |
| 补 canvas / WebGL / Worker / OffscreenCanvas 指纹桩 | 仍 F001 |

**这意味着 Coding Plan（JWT）路径在本项目当前的实现下无法取到合法的 verifyParam。**
API Key 路径不受影响（`api.z.ai` 回退端点不需要验证码）。

可能的出路见 `README.md` 的「已知限制」一节。

## 7. 未验证 / 存疑事项

- `billing/current`、`billing/balance`、`usage` 的字段结构（`total_units` / `used_units` /
  `remaining_units` / `expires_at` 等）来自转述，不同套餐可能不一致
- 额度耗尽的判定关键词为启发式
- `builtinProviders` 里 `builtin:zai-coding-plan` 的 `baseUrl` 是 `https://api.z.ai/api/anthropic`
  ——**可能存在一条「用套餐凭证打 api.z.ai、无需验证码」的通道**，但社区未见此路线的公开结论，
  本仓库无账号可验证。若成立，将完全绕开第 6.5 节的阻塞
- 无痕验证 SDK 的指纹逻辑（feilin / cloudauth-device）会持续更新，jsdom 桩件需要同步

## 8. 致谢与许可

- 上游协议结论、无痕验证方案、`captcha/solver.cjs` 的原型均来自
  [liu5269/zcode2api](https://github.com/liu5269/zcode2api)（AGPL-3.0）。
  本仓库的 `captcha/solver.cjs` 是该项目的移植版，保留同样的许可约束。
- 阿里云验证码返回码含义参考
  [阿里云验证码 2.0 客户端返回数据说明](https://help.aliyun.com/zh/captcha/captcha2-0/user-guide/description-of-data-returned-by-the-client)
- 社区讨论：[linux.do](https://linux.do)
