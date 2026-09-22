# Spec — 登录与凭证体检（module-login）

## 要构建什么

两个脚本：`pnpm login` 拿 Coding Plan 凭证，`pnpm capture-key` 校验凭证并查额度。

实现：`scripts/login.ts`、`scripts/capture-key.ts`、`scripts/envFile.ts`（共享的 `.env` 读写与安全闸）。

## 行为

### `pnpm login`

```
1. 本地生成随机 poll token（32 字节 hex）
2. POST {ZCODE_OAUTH_BASE}/oauth/cli/init
     Authorization: Bearer <poll token>
     {"provider": "zai"}
   → { flow_id, authorize_url }
3. 打印 authorize_url 并尝试用系统默认浏览器打开
4. 每 2s 轮询 GET {ZCODE_OAUTH_BASE}/oauth/cli/poll/{flow_id}（Authorization: Bearer <poll token>），最多 100 次
     status = pending → 继续
     status = failed  → 中止并提示
     status = ready   → 取 data.token（Coding Plan JWT）
5. 把 JWT 合并进 .env 的 ZCODE_KEYS（去重、保序、不覆盖其他变量）
```

- `ZCODE_OAUTH_BASE` 默认 `https://zcode.z.ai/api/v1`。`init` 与 `poll` 必须用**同一个** poll token
- 写入前必须通过 `assertEnvIgnored()`：`git check-ignore .env` 不通过就中止
- 拿到的凭证若不是三段点分 JWT，仍原样保存但给出警告
- **不做** `api.z.ai` 的 API Key 兑换（Non Goal）

### `pnpm capture-key`

**只读**，不修改任何文件。逐个凭证：

| 形态 | 行为 |
|------|------|
| JWT | `GET {ZCODE_BILLING_BASE}/billing/current`（套餐）、`/billing/balance`（各模型剩余额度）、`/usage`（用量）；三者任一失败则标记该凭证不健康 |
| API Key | 打印说明并跳过——回退端点没有轻量探活接口，**不假装验证过** |

输出一律脱敏（`maskSecret()`：保留前 8 后 6）。

## 输入 / 输出

- **输入**：`.env` 的 `ZCODE_KEYS`（缺失时回退进程环境变量）
- **输出**：终端报告；`login` 额外写 `.env`

## 约束

- 任何写 `.env` 的操作必须过 `assertEnvIgnored()`
- `.env` 写入保持 0600 权限（Windows 上尽力而为）
- 只读脚本不得写入
- 凭证在终端输出中必须脱敏

## 边界条件

- OAuth 端点不可达 → 打印明确失败原因，退出码非 0，不写 `.env`
- `ready` 但响应缺 `token` 字段 → 报错中止
- `.env` 不存在 → `login` 会创建它；`capture-key` 提示先登录
- `.env` 已被忽略但用户手动写入了密钥 → 合并而非覆盖
- 凭证在列表中已存在 → 不重复写入并提示

## 验收标准

- [x] `pnpm login` 在 OAuth 端点不可达时优雅失败（已手工验证）
- [x] `pnpm capture-key` 在无密钥时给出可执行的下一步提示（已手工验证）
- [x] `git check-ignore .env` 通过；`.env.example` 可入库
- [ ] 真实账号下 `pnpm login` 能从浏览器授权走到写入 `.env`（需使用者验证）
- [ ] 真实账号下 `pnpm capture-key` 能打印出套餐与各模型剩余额度（需使用者验证）

## 完成定义

两条命令在真实账号下跑通，且 `pnpm capture-key` 的输出足以判断「打不通」是凭证问题还是插件问题。
