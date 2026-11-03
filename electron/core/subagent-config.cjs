/** Shared subagent defaults and validation, independent of Electron and Durable. */
const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
const MODEL_REF = /^[A-Za-z0-9][A-Za-z0-9._-]*\/.+$/;
const TOOL_NAME = /^[A-Za-z0-9_.:-]{1,120}$/;
const SUBAGENT_TOOL_NAMES = new Set([
  'subagent',
  'bg_wait',
  'subagent_supervisor',
  'contact_supervisor',
]);
const DEFAULT_MAX_CONCURRENT = 4;
const DEFAULT_MAX_SPAWNS = 32;
const DEFAULT_WAIT_TIMEOUT_MS = 30_000;
const DEFAULT_WORKTREE_LIMIT = 8;

function normalizeThinking(value) {
  return THINKING_LEVELS.includes(value) ? value : '';
}

function normalizeModel(value) {
  return typeof value === 'string' && MODEL_REF.test(value.trim()) ? value.trim() : '';
}

function boundedInteger(value, fallback, minimum, maximum, strict) {
  if (value === undefined || value === null || value === '') return fallback;
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < minimum || number > maximum) {
    if (!strict) return fallback;
    throw new Error(`数值必须是 ${minimum} 到 ${maximum} 之间的整数`);
  }
  return number;
}

function boundedNumber(value, fallback, minimum, maximum, strict) {
  if (value === undefined || value === null || value === '') return fallback;
  const number = Number(value);
  if (!Number.isFinite(number) || number < minimum || number > maximum) {
    if (!strict) return fallback;
    throw new Error(`数值必须是 ${minimum} 到 ${maximum} 之间的数`);
  }
  return number;
}

function normalizeConfig(raw, { strict = true } = {}) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const defaultModel = normalizeModel(source.defaultModel);
  const defaultThinking = normalizeThinking(source.defaultThinking);
  const maxThinking = normalizeThinking(source.maxThinking);
  const backgroundEnabled = source.backgroundEnabled !== false;
  const requestedMode = source.defaultMode === 'background' ? 'background' : 'foreground';
  const defaultMode = backgroundEnabled ? requestedMode : 'foreground';
  const supervisorEnabled = backgroundEnabled && source.supervisorEnabled !== false;
  if (
    strict
    && defaultThinking
    && maxThinking
    && THINKING_LEVELS.indexOf(defaultThinking) > THINKING_LEVELS.indexOf(maxThinking)
  ) {
    throw new Error('默认 thinking 不能高于 thinking 上限');
  }
  const allowedTools = Array.isArray(source.allowedTools)
    ? [...new Set(source.allowedTools
      .filter((name) => typeof name === 'string')
      .map((name) => name.trim())
      .filter((name) => TOOL_NAME.test(name)))]
      .slice(0, 256)
    : [];
  const worktreeIsolation = ['off', 'background', 'always'].includes(source.worktreeIsolation)
    ? source.worktreeIsolation
    : 'background';
  return {
    defaultModel,
    defaultProvider: defaultModel.split('/')[0] || '',
    defaultThinking,
    maxThinking,
    allowedTools,
    backgroundEnabled,
    defaultMode,
    supervisorEnabled,
    maxConcurrent: boundedInteger(
      source.maxConcurrent,
      DEFAULT_MAX_CONCURRENT,
      1,
      16,
      strict,
    ),
    maxSpawns: boundedInteger(
      source.maxSpawns,
      DEFAULT_MAX_SPAWNS,
      1,
      100,
      strict,
    ),
    waitTimeoutMs: boundedInteger(
      source.waitTimeoutMs,
      DEFAULT_WAIT_TIMEOUT_MS,
      1_000,
      600_000,
      strict,
    ),
    worktreeIsolation,
    worktreeLimit: boundedInteger(
      source.worktreeLimit,
      DEFAULT_WORKTREE_LIMIT,
      1,
      50,
      strict,
    ),
    budgetTokens: boundedInteger(source.budgetTokens, 0, 0, 100_000_000, strict),
    budgetCostUsd: boundedNumber(source.budgetCostUsd, 0, 0, 100_000, strict),
    budgetAction: source.budgetAction === 'stop' ? 'stop' : 'warn',
  };
}

module.exports = { THINKING_LEVELS, SUBAGENT_TOOL_NAMES, normalizeConfig };
