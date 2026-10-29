/**
 * 从 Pi transcript 还原一条历史会话自己的模型状态。
 *
 * transcript 可以记录多次 model_change；会话恢复必须采用最后一条记录。
 * 如果记录的模型已经从当前运行时移除，保留原 modelRef 并标记 unavailable，
 * 不能偷偷换成新对话默认模型。
 */
function latestEntry(entries, type) {
  return [...entries].reverse().find((entry) => entry?.type === type);
}

function resolveSessionModel(entries, { fallbackModel, resolveModel, describe }) {
  const change = latestEntry(entries, 'model_change');
  const thinking = latestEntry(entries, 'thinking_level_change')?.thinkingLevel;

  if (!change) {
    return { ...describe(fallbackModel, thinking), source: 'default' };
  }

  const requestedRef = `${change.provider}/${change.modelId}`;
  const stored = resolveModel(change.provider, change.modelId);
  if (stored) {
    return { ...describe(stored, thinking), source: 'session' };
  }

  return {
    ...describe(fallbackModel),
    modelRef: requestedRef,
    label: change.modelId || requestedRef,
    thinkingLevel: 'default',
    thinkingLevels: ['default'],
    effectiveThinkingLevel: 'off',
    defaultThinkingLevel: 'off',
    source: 'session',
    unavailable: true,
    unavailableReason: `会话原模型 ${requestedRef} 当前不可用，请重新选择模型后再发送。`,
  };
}

module.exports = { latestEntry, resolveSessionModel };
