/**
 * Studio-owned subagent defaults.
 *
 * The durable runtime reads these values for the next child conversation.
 * A project value overrides the matching user-level field; unset fields
 * continue to inherit the parent conversation.
 */

const path = require('node:path');
const { getStudioDatabase } = require('../../core/studio-db.cjs');
const {
  getSubagentConfig,
  setSubagentConfig,
} = require('../../core/app-settings.cjs');
const { availableModels, modelInfo } = require('../../services/models.cjs');
const { extensionHostSnapshot } = require('../../services/studio-extensions.cjs');
const { listManagedWorktrees } = require('./worktrees.cjs');
const { createProtocol, emptyRegistry } = require('./protocol.cjs');
const { evaluateSubagentBudget } = require('../../core/subagent-budget.cjs');
const { subagentUsage } = require('./usage.cjs');

const { THINKING_LEVELS, SUBAGENT_TOOL_NAMES, normalizeConfig } = require('../../core/subagent-config.cjs');

function hasAvailableSubagentExtension(extensions) {
  return Array.isArray(extensions) && extensions.some((row) => (
    row.manifest?.id === 'studio-subagents'
    && row.scope === 'builtin'
    && row.enabled
    && row.available
  ));
}

/**
 * Persist only workspace fields that intentionally differ from the user
 * defaults. This keeps future user-level changes inherited by workspaces the
 * user has not customized.
 */
function projectOverrides(config, userConfig) {
  return Object.fromEntries(Object.entries(config).filter(([key, value]) => (
    JSON.stringify(value) !== JSON.stringify(userConfig[key])
  )));
}

function durableSubagentsInstalled() {
  return hasAvailableSubagentExtension(extensionHostSnapshot().extensions);
}

async function subagentSettings(cwd = process.cwd()) {
  const [models, current, worktrees] = await Promise.all([
    availableModels(cwd),
    modelInfo(cwd),
    listManagedWorktrees({ workspace: cwd }),
  ]);
  const user = normalizeConfig(getSubagentConfig('user'));
  const projectOverridesValue = getSubagentConfig('project', cwd);
  return {
    installed: durableSubagentsInstalled(),
    userPath: 'SQLite · studio.subagents.user',
    projectPath: 'SQLite · studio.subagents.projects[workspace]',
    projectRoot: cwd ? path.resolve(cwd) : '',
    projectRootExists: Boolean(cwd),
    user,
    project: normalizeConfig({ ...user, ...projectOverridesValue }),
    models: models.models.map((model) => ({
      modelRef: model.id,
      provider: model.provider,
      label: `${model.providerName} · ${model.name}`,
      reasoning: model.reasoning,
      thinkingLevels: model.thinkingLevels || [],
    })),
    currentModel: current.modelRef,
    thinkingLevels: THINKING_LEVELS,
    worktrees,
  };
}

async function subagentBudgetSnapshot(parentConversationId) {
  const row = getStudioDatabase().getConversation(String(parentConversationId || ''));
  const numericId = Number(row?.id);
  if (!Number.isSafeInteger(numericId) || numericId <= 0) {
    throw new Error('父会话标识无效');
  }
  const {
    getDurableRuntime,
  } = require('../../runtime/durable-runtime.cjs');
  const runtime = await getDurableRuntime();
  const protocol = createProtocol(runtime.durable);
  const registry = await runtime.harness.snapshot(
    protocol.Subagents,
    numericId,
    runtime.context,
  ) || emptyRegistry();
  const user = normalizeConfig(getSubagentConfig('user'));
  const merged = normalizeConfig({
    ...user,
    ...getSubagentConfig('project', row.workspace),
  });
  return {
    parentConversationId: row.publicId,
    ...evaluateSubagentBudget(merged, subagentUsage(registry)),
  };
}

function saveSubagentSettings(cwd, scope, input) {
  if (!['user', 'project'].includes(scope)) throw new Error('设置范围无效');
  if (scope === 'project' && (typeof cwd !== 'string' || !path.isAbsolute(cwd))) {
    throw new Error('当前工作区无效');
  }
  const next = normalizeConfig(input);
  if (scope === 'project') {
    const user = normalizeConfig(getSubagentConfig('user'));
    setSubagentConfig(scope, cwd, projectOverrides(next, user));
  } else {
    setSubagentConfig(scope, cwd, next);
  }
  return subagentSettings(cwd);
}

module.exports = {
  SUBAGENT_TOOL_NAMES,
  THINKING_LEVELS,
  durableSubagentsInstalled,
  hasAvailableSubagentExtension,
  normalizeConfig,
  projectOverrides,
  saveSubagentSettings,
  subagentBudgetSnapshot,
  subagentSettings,
};
