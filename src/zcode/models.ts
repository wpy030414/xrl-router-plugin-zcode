/**
 * zcode/models.ts — 模型清单的解析与归一化。
 *
 * `ZCODE_MODELS` 支持两种写法（逗号分隔）：
 *   GLM-5.2                       → model_id=GLM-5.2  display_name=GLM-5.2
 *   GLM-5.2=glm-5.2               → model_id=GLM-5.2  display_name=glm-5.2
 *
 * 为什么要分两个字段：xrl-router 用 `display_name` 匹配客户端请求的别名，
 * 用 `model_id` 填进上游请求体的 `model`（见 router `api/proxy/stream.rs`
 * 的 `obj.insert("model", json!(cand.real_model_id))`）。ZCode 上游的模型名
 * **大小写敏感**，所以上游名必须原样保留，展示名则可以取一个客户端好写的别名。
 */

export interface ModelSpec {
  /** 发往上游的真实模型 ID（大小写敏感，原样透传） */
  modelId: string;
  /** 注册给 xrl-router 的展示名 / 别名（客户端用这个名字调用） */
  displayName: string;
}

/** 未配置 `ZCODE_MODELS` 时的内置回退清单（仅供可运行，不代表上游真实可用集） */
export const DEFAULT_MODELS = 'GLM-5.2,GLM-5-Turbo';

/**
 * 解析 `ZCODE_MODELS` 字符串。
 * 空串 → 返回空数组（由调用方决定是否回退到 `DEFAULT_MODELS`）。
 */
export function parseModelsConfig(raw: string): ModelSpec[] {
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((entry) => {
      const eq = entry.indexOf('=');
      if (eq < 0) return { modelId: entry, displayName: entry };
      const modelId = entry.slice(0, eq).trim();
      const displayName = entry.slice(eq + 1).trim() || modelId;
      return { modelId, displayName };
    })
    .filter((m) => m.modelId.length > 0);
}

/**
 * 把客户端传来的模型名归一化成上游接受的规范名。
 *
 * 命中规则（依次）：
 *  1. 精确匹配 modelId
 *  2. 忽略大小写匹配 modelId
 *  3. 忽略大小写匹配 displayName（直连本插件时客户端可能用别名调）
 *  4. 剥掉 `provider/` 前缀后重试 1-3（兼容 `zai/GLM-5.2` 这类写法）
 *  5. 兜底：原样返回
 */
export function canonicalModelId(name: string, specs: ModelSpec[]): string {
  const raw = (name || '').trim();
  if (!raw) return raw;

  const candidates = [raw];
  const slash = raw.indexOf('/');
  if (slash >= 0 && slash + 1 < raw.length) candidates.push(raw.slice(slash + 1).trim());

  for (const candidate of candidates) {
    const exact = specs.find((m) => m.modelId === candidate);
    if (exact) return exact.modelId;
  }
  for (const candidate of candidates) {
    const lower = candidate.toLowerCase();
    const byId = specs.find((m) => m.modelId.toLowerCase() === lower);
    if (byId) return byId.modelId;
    const byDisplay = specs.find((m) => m.displayName.toLowerCase() === lower);
    if (byDisplay) return byDisplay.modelId;
  }
  // 未知模型：原样透传，让上游去报错（比插件静默改写更容易排查）
  return candidates[candidates.length - 1];
}
