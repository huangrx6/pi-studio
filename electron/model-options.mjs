/**
 * 推理强度（thinking level）选项。
 *
 * Pi 的不同模型支持不同的等级（off/low/medium/high…），
 * 这里统一算出「当前值 / 可选值 / 默认值 / 实际生效值」给前端用。
 */

import { clampThinkingLevel, getSupportedThinkingLevels } from '@earendil-works/pi-ai/compat';

/**
 * 计算某个模型的推理强度信息。
 * @param {object} model       Pi 模型对象
 * @param {string} preference  用户上次选择的等级（不认识就用 default）
 * @param {object} settings    { defaultThinkingLevel, modelThinkingLevels }
 */
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

/** 校验等级是否被当前模型支持，不支持时抛错。 */
export function validateThinkingLevel(model, level) {
  if (!reasoningOptions(model).thinkingLevels.includes(level)) throw new Error('当前模型不支持这个推理等级');
  return level;
}
