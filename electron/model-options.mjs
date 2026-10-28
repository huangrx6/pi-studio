import { clampThinkingLevel, getSupportedThinkingLevels } from '@earendil-works/pi-ai/compat';

export function reasoningOptions(model, preference = 'default', settings = {}) {
  const levels = model ? getSupportedThinkingLevels(model) : ['off'];
  const supported = model?.reasoning ? levels : [];
  const thinkingLevel = supported.includes(preference) ? preference : 'default';
  const modelRef = model ? `${model.provider}/${model.id}` : '';
  const fallback = settings.modelThinkingLevels?.[modelRef] ?? settings.defaultThinkingLevel ?? 'medium';
  return {
    thinkingLevel,
    thinkingLevels: ['default', ...supported],
    defaultThinkingLevel: model ? clampThinkingLevel(model, fallback) : 'off',
    effectiveThinkingLevel: model ? clampThinkingLevel(model, thinkingLevel === 'default' ? fallback : thinkingLevel) : 'off',
  };
}

export function validateThinkingLevel(model, level) {
  if (!reasoningOptions(model).thinkingLevels.includes(level)) throw new Error('当前模型不支持这个推理等级');
  return level;
}
