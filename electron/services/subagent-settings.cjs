/**
 * Studio-owned subagent defaults.
 *
 * The durable runtime reads these values for the next child conversation.
 * A project value overrides the matching user-level field; unset fields
 * continue to inherit the parent conversation.
 */

const path = require('node:path');
const {
  getSubagentConfig,
  setSubagentConfig,
} = require('../core/app-settings.cjs');
const { availableModels, modelInfo } = require('./models.cjs');
const { extensionHostSnapshot } = require('./studio-extensions.cjs');

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

function normalizeThinking(value) {
  return THINKING_LEVELS.includes(value) ? value : '';
}

function normalizeModel(value) {
  return typeof value === 'string' && MODEL_REF.test(value.trim()) ? value.trim() : '';
}

function boundedInteger(value, fallback, minimum, maximum) {
  if (value === undefined || value === null || value === '') return fallback;
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < minimum || number > maximum) {
    throw new Error(`数值必须是 ${minimum} 到 ${maximum} 之间的整数`);
  }
  return number;
}

function normalizeConfig(raw) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const defaultModel = normalizeModel(source.defaultModel);
  const defaultThinking = normalizeThinking(source.defaultThinking);
  const maxThinking = normalizeThinking(source.maxThinking);
  const backgroundEnabled = source.backgroundEnabled !== false;
  const requestedMode = source.defaultMode === 'background' ? 'background' : 'foreground';
  const defaultMode = backgroundEnabled ? requestedMode : 'foreground';
  const supervisorEnabled = backgroundEnabled && source.supervisorEnabled !== false;
  if (
    defaultThinking
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
    ),
    maxSpawns: boundedInteger(
      source.maxSpawns,
      DEFAULT_MAX_SPAWNS,
      1,
      100,
    ),
    waitTimeoutMs: boundedInteger(
      source.waitTimeoutMs,
      DEFAULT_WAIT_TIMEOUT_MS,
      1_000,
      600_000,
    ),
  };
}

function hasAvailableSubagentExtension(extensions) {
  return Array.isArray(extensions) && extensions.some((row) => (
    row.manifest?.id === 'studio-subagents'
    && row.scope === 'builtin'
    && row.enabled
    && row.available
  ));
}

function durableSubagentsInstalled() {
  return hasAvailableSubagentExtension(extensionHostSnapshot().extensions);
}

async function subagentSettings(cwd = process.cwd()) {
  const models = await availableModels(cwd);
  const current = await modelInfo(cwd);
  return {
    installed: durableSubagentsInstalled(),
    userPath: 'SQLite · studio.subagents.user',
    projectPath: 'SQLite · studio.subagents.projects[workspace]',
    projectRoot: cwd ? path.resolve(cwd) : '',
    projectRootExists: Boolean(cwd),
    user: normalizeConfig(getSubagentConfig('user')),
    project: normalizeConfig(getSubagentConfig('project', cwd)),
    models: models.models.map((model) => ({
      modelRef: model.id,
      provider: model.provider,
      label: `${model.providerName} · ${model.name}`,
      reasoning: model.reasoning,
      thinkingLevels: model.thinkingLevels || [],
    })),
    currentModel: current.modelRef,
    thinkingLevels: THINKING_LEVELS,
  };
}

function saveSubagentSettings(cwd, scope, input) {
  if (!['user', 'project'].includes(scope)) throw new Error('设置范围无效');
  if (scope === 'project' && (typeof cwd !== 'string' || !path.isAbsolute(cwd))) {
    throw new Error('当前工作区无效');
  }
  const next = normalizeConfig(input);
  setSubagentConfig(scope, cwd, next);
  return subagentSettings(cwd);
}

module.exports = {
  SUBAGENT_TOOL_NAMES,
  THINKING_LEVELS,
  durableSubagentsInstalled,
  hasAvailableSubagentExtension,
  normalizeConfig,
  saveSubagentSettings,
  subagentSettings,
};
