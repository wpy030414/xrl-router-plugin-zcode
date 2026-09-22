# xrl-router-plugin-zcode

把 ZCode（`zcode.z.ai`）的额度包装成 xrl-router 里一个普通可路由的供应商。

## 这是什么？

- **定位**：xrl-router 的**委托供应商插件**（WebSocket 注册，见 xrl-router `docs/specs/module-plugin-system.md`）。
- **解决的核心问题**：ZCode 的额度只能在其官方客户端里花掉——上游是私有 Anthropic Messages 端点，且要求阿里云「无痕验证」参数。本插件把这层私有性抹平，让 Claude Code / CCSwitch / 任意 OpenAI 兼容客户端都能用上这份额度。

```
客户端 → xrl-router → 本插件（:19065）→ zcode.z.ai
         ↑ 协议转换、       ↑ 仅供「装上游业务头 + 供无痕验证参数」
           密钥轮换、重试、
           用量统计
```

## 为什么存在？

密钥管理、失败重试、密钥轮换、用量统计、协议转换——这些 xrl-router 都已经有了。社区项目 `zcode2api` 证明了**怎么访问** ZCode 上游（端点、业务头、无痕验证），但它把自己实现成了带后台 UI 与 SQLite 账号池的独立网关，与 xrl-router 的密钥池职责重叠。本插件只保留其中无法被 router 替代的那一层。

## 如何安装和运行？

**前置要求**：Node.js ≥ 20、pnpm、一个运行中的 xrl-router（默认 `http://localhost:19068`）。

```bash
pnpm install

# 1. 拿凭证（走 Z.AI OAuth，浏览器授权）
pnpm login

# 2. 体检：确认凭证可用并查看剩余额度
pnpm capture-key

# 3. 启动（默认端口 19065）
pnpm serve
```

启动后在 xrl-router 界面确认插件上线 → 添加供应商 → 用注册的模型别名调用。

模型清单**默认自动发现**（从上游 `/api/v1/client/configs` 的 `builtinModels`），不写 `ZCODE_MODELS` 也能用。
想自定义别名再在 `.env` 里写。

```bash
curl http://localhost:19065/health
```

## ⚠️ 已知阻塞：Coding Plan 路径暂时不可用

**如果你打算用 Coding Plan（JWT）凭证，请先读这一节。**

ZCode 的 Coding Plan 端点要求一个由阿里云「无痕验证」签发的请求头。本插件用 Node + jsdom
跑阿里云官方 SDK 来求这个参数，链路本身是通的（SDK 加载 → 设备指纹请求 → 拿到 `certifyId`），
但阿里云风控当前判定为 **`verifyCode: F001`（疑似攻击请求，风险策略不通过）**。

已尝试且**均无效**：伪装 Chrome UA、`navigator.webdriver=false`、补齐 `chrome`/`screen`/canvas/WebGL
指纹、把 region 从过期的 `sgp` 改成上游公布的 `cn`。

| 路径 | 状态 |
|------|------|
| Coding Plan（JWT，需无痕验证） | ❌ 被风控拒绝，拿不到 verifyParam |
| API Key 回退通道（`api.z.ai`，无需验证码） | ✅ 正常 |

结论：**本插件当前实质上只有 API Key 通道可用**。详见
[docs/reverse/ZCODE_REVERSE.md](./docs/reverse/ZCODE_REVERSE.md) 第 6.5 节与
[docs/DECISIONS.md](./docs/DECISIONS.md) D-9（含备选出路：换真实无头浏览器、
或验证 `builtin:zai-coding-plan` 那条「套餐凭证走 api.z.ai」的免验证码路线）。

## 当前状态

- **阶段**：开发中。转发 / 聚合 / 错误映射 / 验证码缓存与刷新 / 注册载荷 / 模型自动发现
  由 `pnpm e2e` 的 47 条离线断言覆盖并全绿。
- **已知限制**：
  - **Coding Plan 路径被阿里云风控拒绝（F001），见上一节**
  - 无痕验证依赖阿里云混淆 SDK 的浏览器指纹行为；上游更新指纹逻辑时桩件需同步
  - 额度 / 计费字段结构基于社区观测，不同套餐可能有差异
  - 无真实账号时的端到端验证需使用者自行完成

## 核心技术

Node.js 20+ · TypeScript 5 · Express 4 · ws · jsdom（跑阿里云无痕 SDK 求 `verifyParam`）· pnpm

## 延伸阅读

- [AGENTS.md](./AGENTS.md) — 项目边界与 Non Goals
- [docs/PRD.md](./docs/PRD.md) — 功能需求与存在的意义
- [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md) — 架构、模块、数据流
- [docs/DECISIONS.md](./docs/DECISIONS.md) — 设计决策背后的历史原因
- [docs/reverse/ZCODE_REVERSE.md](./docs/reverse/ZCODE_REVERSE.md) — ZCode 上游逆向成果与致谢
- [docs/specs/](./docs/specs/) — 各模块规格
