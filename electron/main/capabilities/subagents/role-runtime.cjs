const { getSubagentConfig } = require('../../core/app-settings.cjs');
const { evaluateSubagentBudget } = require('../../core/subagent-budget.cjs');
const { getStudioDatabase } = require('../../core/studio-db.cjs');
const { roleHarness } = require('./profiles.cjs');
const { THINKING_LEVELS, isFileToolPreset, resolveRoleDefaults, SUBAGENT_TOOL_NAMES } = require('../../core/subagent-config.cjs');
const { subagentUsage } = require('./usage.cjs');

function runDefaults(cwd, profile) {
  return resolveRoleDefaults(getSubagentConfig('user'), getSubagentConfig('project', cwd || ''), profile?.runtimeOverrides);
}

function assertSpawnAvailable(defaults, state, profile) {
  const scoped = profile?.runtimeOverrides?.maxSpawns !== undefined;
  const children = Object.values(state.agents).filter(child => !scoped || child.profileId === profile.id);
  if (children.length >= defaults.maxSpawns) {
    throw new Error(`当前会话最多创建 ${defaults.maxSpawns} 个${scoped ? '「' + profile.name + '」' : '子智能体'}`);
  }
}

function assertBudgetAvailable(parentConversationId, defaults, state, profile) {
  const scoped = profile && ['budgetTokens', 'budgetCostUsd', 'budgetAction'].some(key => Object.hasOwn(profile.runtimeOverrides, key));
  const usage = { ...subagentUsage(state, undefined, scoped ? profile.id : undefined), parentConversationId };
  const budget = evaluateSubagentBudget(defaults, usage);
  if (!budget.exceeded) return usage;
  const warning = `${scoped ? '「' + profile.name + '」' : '子智能体'}预算已用尽（${budget.tokens.toLocaleString()} tokens，$${budget.costUsd.toFixed(4)}）`;
  if (budget.budgetAction === 'stop') throw new Error(warning + '，请调整运行预算后再试');
  return { ...usage, warning };
}

function modelRef(value) {
  if (typeof value !== 'string') return undefined;
  const slash = value.indexOf('/');
  if (slash <= 0 || slash === value.length - 1) return undefined;
  return { provider: value.slice(0, slash), modelId: value.slice(slash + 1) };
}

function thinkingRank(level) {
  return THINKING_LEVELS.indexOf(level);
}

function roleModelSettings(args, profile, defaults, models, piAi, agent) {
  const selectedModel = profile?.model || args.model || defaults.defaultModel;
  const requestedModel = profile?.model === 'parent' ? undefined : modelRef(selectedModel);
  if (args.model && !profile?.model && !requestedModel) {
    throw new Error('子智能体模型必须使用 provider/modelId 格式');
  }
  if (profile?.model && requestedModel) {
    const db = getStudioDatabase();
    if (!db.getProvider(requestedModel.provider)?.enabled || !db.getModel(requestedModel.provider, requestedModel.modelId)?.enabled) {
      throw new Error(`「${profile.name}」的模型已停用或移除，请重新选择。`);
    }
  }
  let requestedThinking = args.thinkingLevel || defaults.defaultThinking || undefined;
  // An inherited level also obeys an explicit ceiling. A conflicting call argument is rejected.
  if (!args.thinkingLevel && defaults.maxThinking && thinkingRank(requestedThinking || agent.thinkingLevel) > thinkingRank(defaults.maxThinking)) {
    requestedThinking = defaults.maxThinking;
  }
  if (requestedThinking && !THINKING_LEVELS.includes(requestedThinking)) {
    throw new Error(`子智能体 thinking 强度无效：${requestedThinking}`);
  }
  if (
    requestedThinking
    && defaults.maxThinking
    && thinkingRank(requestedThinking) > thinkingRank(defaults.maxThinking)
  ) {
    throw new Error(`子智能体 thinking 强度不能高于 ${defaults.maxThinking}`);
  }
  const childModel = requestedModel
    ? models.getModel(requestedModel.provider, requestedModel.modelId)
    : undefined;
  if (requestedModel && !childModel) {
    throw new Error(`子智能体模型不存在或尚未启用：${requestedModel.provider}/${requestedModel.modelId}`);
  }
  const effectiveModel = childModel || (requestedThinking && agent.model && models?.getModel(agent.model.provider, agent.model.modelId));
  if (effectiveModel && requestedThinking) {
    const levels = piAi.getSupportedThinkingLevels(effectiveModel);
    if (!levels.includes(requestedThinking)) {
      if (!profile?.model || args.thinkingLevel || profile.runtimeOverrides.defaultThinking) {
        throw new Error(`模型 ${effectiveModel.provider}/${effectiveModel.id} 不支持 thinking=${requestedThinking}`);
      }
      requestedThinking = levels.filter(level => thinkingRank(level) <= thinkingRank(requestedThinking)).at(-1);
      if (!requestedThinking) throw new Error('角色模型没有符合当前思考强度上限的选项');
    }
  }
  return { requestedModel, requestedThinking };
}

function childExtensionsFor(agent, profile, channel, managerName = 'studio-subagents') {
  const fileOnly = isFileToolPreset(profile?.runtimeOverrides?.allowedTools);
  const selected = (agent.extensions || []).filter(extension => {
    if (extension.name === managerName || extension.name === channel.name) return false;
    if (extension.name === 'studio-mcp-catalog' && fileOnly) return false;
    if (!extension.name.startsWith('studio-mcp:')) return true;
    return !fileOnly && (!profile?.mcpServers || profile.mcpServers.includes(extension.name.slice('studio-mcp:'.length)));
  });
  return [...selected, channel];
}

function childInstructions(name, parentId, supervisor, roleInstruction, taskInstruction) {
  const directions = [
    `You are Studio subagent "${name}" (parent conversation ${parentId}).`,
    'Work only within the tools and workspace granted to this child conversation.',
    'Never claim to have created another subagent. Child conversations cannot spawn children.',
    ...(supervisor ? ['Use contact_supervisor only when parent approval or missing context blocks safe progress. The request is asynchronous; continue with independent work while awaiting a reply.'] : []),
  ];
  return [roleInstruction, taskInstruction, directions.join('\n')].filter(Boolean).join('\n\n');
}

function childToolsFor(agent, defaults, childSupervisorTool, profile) {
  const access = profile?.runtimeOverrides?.allowedTools;
  const mcpServers = profile?.mcpServers;
  const allowed = defaults.allowedTools.length > 0 || Array.isArray(access)
    ? new Set(defaults.allowedTools)
    : undefined;
  const modelTools = [];
  const enabledTools = [];
  const enabledNames = new Set();
  // Durable resolves duplicate tool names in extension order. File presets only trust
  // the registered coding/filesystem implementations, including their permission wraps.
  const owners = new Map();
  for (const extension of agent.extensions || []) {
    for (const tool of extension.tools || []) owners.set(tool.name, extension.name);
  }
  const fileOnly = isFileToolPreset(access);
  const mcpAllowed = name => {
    if (!name.startsWith('mcp__') || (!mcpServers && access === undefined)) return true;
    const owner = owners.get(name);
    return owner?.startsWith('studio-mcp:') && (!mcpServers || mcpServers.includes(owner.slice('studio-mcp:'.length)));
  };
  const canExpose = (tool) => (
    tool?.name
    && !SUBAGENT_TOOL_NAMES.has(tool.name)
    && mcpAllowed(tool.name)
    && (!fileOnly || owners.get(tool.name) === (['ls', 'find', 'grep'].includes(tool.name) ? 'studio-filesystem-tools' : 'coding-tools'))
    && (!allowed || allowed.has(tool.name) || (Array.isArray(access) && tool.name.startsWith('mcp__')))
  );
  const add = (target, names, tool) => {
    if (!canExpose(tool) || names.has(tool.name)) return;
    names.add(tool.name);
    target.push(tool);
  };
  const modelNames = new Set();
  for (const tool of Array.isArray(agent.tools) ? agent.tools : []) {
    add(enabledTools, enabledNames, tool);
    add(modelTools, modelNames, tool);
  }
  // agent.callable contains tools available to nested/codemode calls even when
  // the model is not offered them directly. It is an expansion of `tools`, not
  // a replacement for the model-facing filter.
  for (const tool of Array.isArray(agent.callable) ? agent.callable : []) {
    add(enabledTools, enabledNames, tool);
  }
  for (const tool of agent.deferred || []) add(enabledTools, enabledNames, tool);
  if (Array.isArray(access) && enabledTools.some(tool => tool.deferred) && !modelNames.has('tool_search')) {
    const search = agent.tools?.find(tool => tool.name === 'tool_search');
    if (search && owners.get('tool_search') === 'tool-search') {
      if (!enabledNames.has(search.name)) enabledTools.push(search);
      modelTools.push(search);
    }
  }
  if (access === undefined && defaults.allowedTools.length > 0 && enabledTools.length === 0) {
    throw new Error(
      `子智能体的工具白名单与父智能体当前工具没有交集：${defaults.allowedTools.join(', ')}`,
    );
  }
  if (defaults.supervisorEnabled && childSupervisorTool) {
    const addSupervisorTool = (target, names) => {
      if (names.has(childSupervisorTool.name)) return;
      names.add(childSupervisorTool.name);
      target.push(childSupervisorTool);
    };
    addSupervisorTool(enabledTools, enabledNames);
    addSupervisorTool(modelTools, modelNames);
  }
  return { enabledTools, modelTools };
}

// A named background child can receive new input long after it was created.
// Reconcile the role before delivering that input, retaining its existing worktree and history.
async function refreshBackgroundRole(durable, runtime, child, parent, defaults, profile, ChildContext, context) {
  if (!defaults.backgroundEnabled) throw new Error('此角色已关闭后台运行');
  const channel = runtime.registry.extension('studio-subagent-channel');
  if (!channel) throw new Error('无法确认子智能体运行上下文');
  const childState = await runtime.snapshot(ChildContext, child.id, context);
  if (!childState) throw new Error('无法读取子智能体运行上下文');
  const { enabledTools, modelTools } = childToolsFor(parent, defaults, channel.tools.find(tool => tool.name === 'contact_supervisor'), profile);
  const { requestedModel, requestedThinking } = roleModelSettings(childState?.modelArguments || {}, profile, defaults, runtime.models,
    await import('@earendil-works/pi-ai'), parent);
  const rolePrompt = { harness: roleHarness(profile, parent.cwd), skills: profile.skills, workspace: parent.cwd || '' };
  await runtime.commit(async tx => {
    await durable.configure(tx, child.id, {
      extensions: childExtensionsFor(parent, profile, channel), tools: enabledTools, modelTools,
      model: requestedModel || parent.model, thinkingLevel: requestedThinking || parent.thinkingLevel,
      // Older children only store the compiled instructions. Preserve their caller's text.
      ...(typeof childState.taskInstruction === 'string' ? { instructions: childInstructions(childState.name,
        childState.parentConversationId, defaults.supervisorEnabled, profile.instructions, childState.taskInstruction) } : {}),
    });
    const stored = await tx.doc(ChildContext, child.id);
    stored.supervisorEnabled = defaults.supervisorEnabled;
    stored.rolePrompt = rolePrompt;
  }, context);
}

module.exports = { roleModelSettings, refreshBackgroundRole, runDefaults, assertBudgetAvailable, assertSpawnAvailable, childExtensionsFor, childToolsFor, childInstructions };
