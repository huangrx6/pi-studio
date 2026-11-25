/** Shared subagent defaults and validation, independent of Electron and Durable. */
const path = require('node:path');
const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
const MODEL_REF = /^[A-Za-z0-9][A-Za-z0-9._-]*\/.+$/;
const TOOL_NAME = /^[A-Za-z0-9_.:-]{1,120}$/;
const SUBAGENT_TOOL_NAMES = new Set([
  'subagent',
  'subagent_stop',
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
  const parent = typeof source.worktreeParent === 'string' ? source.worktreeParent.trim() : '';
  if (parent && !path.isAbsolute(parent) && strict) throw new Error('工作树位置必须是绝对路径');
  return {
    worktreeParent: parent && path.isAbsolute(parent) ? path.resolve(parent) : '',
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

const FILE_READ_TOOLS = ['read', 'ls', 'find', 'grep'];
const FILE_TOOL_PRESETS = { 'read-only': FILE_READ_TOOLS, 'read-write': [...FILE_READ_TOOLS, 'edit', 'write'] };
function isFileToolPreset(access) {
  return typeof access === 'string' && Object.hasOwn(FILE_TOOL_PRESETS, access);
}

// Sparse role records distinguish inheritance (absent) from false, zero and an empty selection.
function normalizeRoleOverrides(raw = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('角色运行设置无效');
  const enums = {
    defaultThinking: ['', ...THINKING_LEVELS], maxThinking: ['', ...THINKING_LEVELS],
    defaultMode: ['foreground', 'background'], worktreeIsolation: ['off', 'background', 'always'],
    budgetAction: ['warn', 'stop'],
  };
  const defaults = normalizeConfig({});
  const result = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!Object.hasOwn(defaults, key) || key === 'defaultProvider' || key === 'defaultModel') throw new Error('未知的角色运行设置');
    if (key === 'allowedTools') {
      if (value === 'parent' || isFileToolPreset(value)) result[key] = value;
      else if (Array.isArray(value) && value.length <= 256 && value.every(name =>
        typeof name === 'string' && TOOL_NAME.test(name) && !SUBAGENT_TOOL_NAMES.has(name) && !name.startsWith('mcp__'))) {
        result[key] = [...new Set(value)];
      } else throw new Error('角色工具选择无效');
    } else {
      if (typeof value !== typeof defaults[key] || (Object.hasOwn(enums, key) && !enums[key].includes(value))) {
        throw new Error('角色运行设置值无效');
      }
      result[key] = key === 'worktreeParent' ? value.trim() : value;
    }
  }
  normalizeConfig(result); // Apply the same numeric bounds, path and thinking checks as shared defaults.
  return result;
}

function resolveRoleDefaults(user, project, overrides = {}) {
  const source = { ...user, ...project, ...overrides };
  if (source.allowedTools === 'parent') source.allowedTools = [];
  else if (isFileToolPreset(source.allowedTools)) source.allowedTools = FILE_TOOL_PRESETS[source.allowedTools];
  return normalizeConfig(source, { strict: false });
}

module.exports = { THINKING_LEVELS, SUBAGENT_TOOL_NAMES, isFileToolPreset, normalizeConfig, normalizeRoleOverrides, resolveRoleDefaults };
