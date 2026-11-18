/**
 * 上下文窗口策略：百分比阈值与 Durable 的 token 阈值之间的唯一换算点。
 *
 * 用户配置的是“用到上下文的百分之多少开始压缩”，而 Durable 的压缩策略以
 * `reserveTokens`（给回答预留的空间）表达阈值：达到 `contextWindow - reserveTokens`
 * 时触发。这里把百分比换算成每个模型自己的 reserve，运行时的压缩策略与界面上的
 * 百分比读数都读同一份换算，不会出现两套口径。
 *
 * 纯函数模块：不依赖 Electron、存储或渲染进程。
 */

const DEFAULT_AUTO_COMPACT_PERCENT = 85;
/** 低于 50% 会让每次请求都触发压缩；高于 95% 已经没有给回答留出空间。 */
const MIN_AUTO_COMPACT_PERCENT = 50;
const MAX_AUTO_COMPACT_PERCENT = 95;
/** 再小的窗口也要给回答留一点空间。 */
const MIN_RESERVE_TOKENS = 2_048;

/** 0 表示关闭按比例压缩；未填写回落到默认值，其余数夹到 [50, 95]。 */
function normalizeAutoCompactPercent(value) {
  if (value === undefined || value === null || (typeof value === 'string' && !value.trim())) {
    return DEFAULT_AUTO_COMPACT_PERCENT;
  }
  const number = Number(value);
  if (!Number.isFinite(number)) return DEFAULT_AUTO_COMPACT_PERCENT;
  if (number === 0) return 0;
  return Math.max(MIN_AUTO_COMPACT_PERCENT, Math.min(MAX_AUTO_COMPACT_PERCENT, Math.trunc(number)));
}

/** 模型在 `percent` 处触发压缩时需要的 reserve；窗口未知或阈值关闭时为 undefined。 */
function autoCompactReserveTokens(contextWindow, percent) {
  const window = Math.trunc(Number(contextWindow) || 0);
  const ratio = normalizeAutoCompactPercent(percent);
  if (window <= 0 || ratio <= 0) return undefined;
  const reserve = Math.round((window * (100 - ratio)) / 100);
  return Math.max(MIN_RESERVE_TOKENS, Math.min(window - MIN_RESERVE_TOKENS, reserve));
}

/**
 * Durable 的 `compaction.modelOverrides`：按 `provider/modelId` 给每个已知窗口的模型
 * 单独指定 reserve，未列出或窗口未知的模型继续使用 Harness 的 token 阈值。
 */
function autoCompactOverrides(models, percent) {
  const overrides = {};
  for (const model of Array.isArray(models) ? models : []) {
    const providerId = typeof model?.providerId === 'string' ? model.providerId : '';
    const modelId = typeof model?.modelId === 'string' ? model.modelId : '';
    if (!providerId || !modelId) continue;
    const reserveTokens = autoCompactReserveTokens(model.contextWindow, percent);
    if (!reserveTokens) continue;
    overrides[`${providerId}/${modelId}`] = { reserveTokens };
  }
  return overrides;
}

module.exports = {
  DEFAULT_AUTO_COMPACT_PERCENT,
  MAX_AUTO_COMPACT_PERCENT,
  MIN_AUTO_COMPACT_PERCENT,
  autoCompactOverrides,
  autoCompactReserveTokens,
  normalizeAutoCompactPercent,
};
