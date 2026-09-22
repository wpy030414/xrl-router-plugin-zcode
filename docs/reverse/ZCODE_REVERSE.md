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

> 本节大量结论来自 **【本机逆向】**：`%LOCALAPPDATA%/Programs/ZCode/resources/glm/zcode.cjs`
> （ZCode 桌面端 3.5.3 的 14MB 打包 bundle）。关键函数名一并给出，便于复核。

- **Coding Plan 凭证** = OAuth 产出的 JWT，三段点分（`a.b.c`）。本插件以此作为形态判据。
- **官方对 Coding Plan 额度的真实用法不是打 zcode-plan 端点**，而是把 OAuth `access_token`
  兑换成一个长期 API Key，再打 api.z.ai（免无痕验证）。见下。

### 4.1 OAuth 登录流程（`createZaiCliOAuthClient` / `Xun`）

```
本地生成 pollToken = randomBytes(32).hex
POST {oauthBase}/oauth/cli/init   Authorization: Bearer <pollToken>   {"provider":"zai"}
     → data: { flow_id, authorize_url, poll_token, expires_at, poll_interval_sec }
浏览器完成授权
GET  {oauthBase}/oauth/cli/poll/{flow_id}   Authorization: Bearer <pollToken>
     → status: pending | failed | ready
     ready 时 data = { token: <CodingPlan JWT>, zai: { access_token }, user: {...} }
```

- `oauthBase` 默认 `https://zcode.z.ai/api/v1`（bundle 里 `J5s`）
- 轮询用的临时 `pollToken` 由本地随机生成，与最终凭证无关
- 轮询间隔取 `max(Fqa, poll_interval_sec*1000)`，超时取 `min(now+timeout, expires_at*1000)`

### 4.2 ★ 兑换链：access_token → api.z.ai API Key（`createCodingPlanApiKeyResolver` / `ZJr`）

**这是绕开无痕验证 F001 的关键路线**，官方客户端 `resolveCodingPlanApiKey`（`nWo`）实际调用：

```
输入：OAuth ready 里的 zai.access_token（注意：不是 JWT！family="zai"）

1. resolveZaiBizToken (V5s)：
   POST https://api.z.ai/api/auth/z/login   {token: access_token}
     → data.access_token（业务 token，下称 bizToken）

2. resolveBizApiKey (GJr)：authorization = `Bearer ${bizToken}`，host = https://api.z.ai
   GET  /api/biz/customer/getCustomerInfo
     → pickOrgAndProject (H5s)：机构里挑名字含「默认机构」的（否则第一个），
       项目里挑名字含「默认项目」的（否则第一个）
   GET  /api/biz/v1/organization/{orgId}/projects/{projId}/api_keys
     → 找 name === "zcode-api-key" 的项；没有则 POST 同 URL {name:"zcode-api-key"} 创建
     → 取 apiKeyId = item.apiKey
   GET  /api/biz/v1/organization/{orgId}/projects/{projId}/api_keys/copy/{apiKeyId}
     → data.secretKey
   ⇒ 返回 `${apiKeyId}.${secretKey}`
```

- 上游业务信封：`{code, msg, data}`，`code` 为 `null/0/200/"0"/"200"` 视为成功（`isSuccessfulRemoteCode` / `G5s`）
- 关键常量（bundle）：`JJr="https://api.z.ai"`、`HJr="zcode-api-key"`、`q5s="默认机构"`、`W5s="默认项目"`
- **【实测】** 兑换链 4 端点用假 token 探活全部存活：
  - `POST /api/auth/z/login {token:fake}` → HTTP 200 `{code:500,msg:"Z.ai user information is invalid"}`
  - `GET /api/biz/customer/getCustomerInfo`（无 auth）→ `{code:1001,msg:"Authentication parameter not received"}`
  - 同端点（假 biz token）→ `{code:401,msg:"token expired or incorrect"}`

### 4.3 兑换出的 key 如何推理

- 兑换结果 `apiKeyId.secretKey` 只有 **1 个点** → 本插件 `classifySecret` 判为 `apiKey`
  → 自动走 `ZAI_FALLBACK_URL`（`https://api.z.ai/api/anthropic/v1/messages`），**免无痕验证**
- 佐证：`builtinProviders` 里 `builtin:zai-coding-plan` 的 `baseUrl` 正是 `https://api.z.ai/api/anthropic`
- **【实测】** 该端点用假 key 返回 `401 {message:"token expired or incorrect"}`，把值当 token 解析，不要求验证码头

### 4.4 zcode2api 的对应实现

zcode2api 的 `app/oauth.py::exchange_api_key` 是同一条链（`z/login → getCustomerInfo →
api_keys → copy`）。本插件的 `src/zcode/exchange.ts` 与之等价，但**默认启用**（zcode2api 里是可选步骤）。

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

- **【头号】兑换 key 的计费归属未端到端确证**：逆向证明官方把 Coding Plan 的 access_token
  兑换成 `zcode-api-key` 打 api.z.ai，但**无法证明这把 key 消耗的是订阅额度还是另计的 API 余额**。
  需要一个真实订阅账号端到端跑通（`pnpm login` → `pnpm serve` → 发一条请求 → 查
  `billing/balance` 是否扣减）才能确认。这是路线 A 成立与否的最后一环。
- `billing/current`、`billing/balance`、`usage` 的字段结构（`total_units` / `used_units` /
  `remaining_units` / `expires_at` 等）来自转述，不同套餐可能不一致
- 额度耗尽的判定关键词为启发式
- `builtinProviders` 里 `builtin:zai-coding-plan`（`baseUrl: https://api.z.ai/api/anthropic`）
  已被本机逆向证实为官方 Coding Plan 路线（见第 4.2 节），不再是存疑项
- 无痕验证 SDK 的指纹逻辑（feilin / cloudauth-device）会持续更新，jsdom 桩件需要同步
  （但只要路线 A 可用，求解器就是兜底而非主路径）
- OAuth ready 载荷里 `zai.access_token` 的有效期未测——若它比 JWT 短很多，兑换需更频繁；
  但兑换出的是**长期** API Key，正常只需兑换一次

## 8. 致谢与许可

- 上游协议结论、无痕验证方案、`captcha/solver.cjs` 的原型均来自
  [liu5269/zcode2api](https://github.com/liu5269/zcode2api)（AGPL-3.0）。
  本仓库的 `captcha/solver.cjs` 是该项目的移植版，保留同样的许可约束。
- 阿里云验证码返回码含义参考
  [阿里云验证码 2.0 客户端返回数据说明](https://help.aliyun.com/zh/captcha/captcha2-0/user-guide/description-of-data-returned-by-the-client)
- 社区讨论：[linux.do](https://linux.do)
