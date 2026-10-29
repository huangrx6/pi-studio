/**
 * Studio's canonical thinking-level capability model.
 *
 * Pi keeps the public UI vocabulary stable and maps each level to provider
 * specific request fields through Model.thinkingLevelMap. Studio only stores
 * which public levels a model exposes; provider wire values stay owned by the
 * matching Pi API adapter.
 */

const THINKING_LEVELS = Object.freeze([
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
]);

const DEFAULT_REASONING_LEVELS = Object.freeze([
  'off',
  'minimal',
  'low',
  'medium',
  'high',
]);

const LEVEL_ALIASES = Object.freeze({
  none: 'off',
  disabled: 'off',
  false: 'off',
  minimum: 'minimal',
  min: 'minimal',
  mid: 'medium',
  normal: 'medium',
  extrahigh: 'xhigh',
  'extra-high': 'xhigh',
  extra_high: 'xhigh',
  'x-high': 'xhigh',
  veryhigh: 'xhigh',
  'very-high': 'xhigh',
  very_high: 'xhigh',
  maximum: 'max',
});

function levelList(value) {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') return value.split(/[\s,|/]+/);
  if (value && typeof value === 'object') {
    return value.levels || value.supported || value.supported_levels || value.values || value.enum;
  }
  return [];
}

function normalizeThinkingLevels(value, reasoning = true) {
  if (!reasoning) return [];
  const selected = new Set();
  for (const raw of levelList(value)) {
    const key = String(raw ?? '').trim().toLowerCase().replace(/\s+/g, '');
    if (!key) continue;
    const level = LEVEL_ALIASES[key] || key;
    if (THINKING_LEVELS.includes(level)) selected.add(level);
  }
  return THINKING_LEVELS.filter((level) => selected.has(level));
}

function defaultThinkingLevels(reasoning = true) {
  return reasoning ? [...DEFAULT_REASONING_LEVELS] : [];
}

function effectiveThinkingLevels(value, reasoning = true) {
  if (!reasoning) return [];
  const normalized = normalizeThinkingLevels(value, true);
  return normalized.length > 0 ? normalized : defaultThinkingLevels(true);
}

/**
 * Build a Pi-compatible map from Studio's selected public levels.
 *
 * For standard levels (`off` through `high`) an absent map entry keeps Pi's
 * provider default. XHigh/Max are opt-in in Pi, so those selected levels need
 * an explicit non-null entry. Unselected levels are disabled with null.
 */
function thinkingLevelMapForLevels(value, baseMap) {
  const selected = new Set(effectiveThinkingLevels(value, true));
  const map = {};
  for (const level of THINKING_LEVELS) {
    if (!selected.has(level)) {
      map[level] = null;
      continue;
    }
    const mapped = baseMap?.[level];
    if (typeof mapped === 'string') map[level] = mapped;
    else if (level === 'xhigh' || level === 'max') map[level] = level;
  }
  return map;
}

/** Mirrors pi-ai getSupportedThinkingLevels() for capability-only projections. */
function thinkingLevelsFromMap(map) {
  return THINKING_LEVELS.filter((level) => {
    const mapped = map?.[level];
    if (mapped === null) return false;
    if (level === 'xhigh' || level === 'max') return mapped !== undefined;
    return true;
  });
}

module.exports = {
  DEFAULT_REASONING_LEVELS,
  THINKING_LEVELS,
  defaultThinkingLevels,
  effectiveThinkingLevels,
  normalizeThinkingLevels,
  thinkingLevelMapForLevels,
  thinkingLevelsFromMap,
};
