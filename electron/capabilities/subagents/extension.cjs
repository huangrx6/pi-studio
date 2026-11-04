/**
 * Durable-owned foreground and background subagents.
 *
 * The parent capability owns child creation, supervision, isolation, budget,
 * and terminal-state projection. Renderer-facing transcript reads live in the
 * sibling `transcripts.cjs` module and consume this same protocol.
 */

const { getSubagentConfig } = require('../../core/app-settings.cjs');
const { getStudioDatabase } = require('../../core/studio-db.cjs');
const { evaluateSubagentBudget } = require('../../core/subagent-budget.cjs');
const {
  THINKING_LEVELS,
  normalizeConfig: normalizeSubagentDefaults,
} = require('../../core/subagent-config.cjs');
const toolSchema = require('../../runtime/tool-schema.cjs');
const {
  createProtocol,
  createReporter,
  queueSupervisorReply,
  emptyRegistry,
} = require('./protocol.cjs');
const {
  bindManagedWorktree,
  completeManagedWorktree,
  createManagedWorktree,
  discardManagedWorktree,
  isGitRepository,
} = require('./worktrees.cjs');
const { subagentUsage } = require('./usage.cjs');
const { resolveWorkspacePath } = require('../filesystem/index.cjs');

const MAX_SUBAGENT_TEXT_LENGTH = 64_000;
const MAX_SUBAGENT_INSTRUCTIONS_LENGTH = 32_000;
const MAX_SUBAGENT_SUPERVISOR_LENGTH = 16_000;

function modelRef(value) {
  if (typeof value !== 'string') return undefined;
  const slash = value.indexOf('/');
  if (slash <= 0 || slash === value.length - 1) return undefined;
  return { provider: value.slice(0, slash), modelId: value.slice(slash + 1) };
}

function normalizeSubagentConfig(user, project) {
  const defaults = normalizeSubagentDefaults({ ...(user || {}), ...(project || {}) }, { strict: false });
  return {
    ...defaults,
    modelRef: modelRef(defaults.defaultModel),
    thinkingLevel: defaults.defaultThinking || undefined,
    maxThinking: defaults.maxThinking || undefined,
  };
}

function thinkingRank(level) {
  return THINKING_LEVELS.indexOf(level);
}

function throwIfAborted(context) {
  const signal = context?.abortSignal;
  if (!signal?.aborted) return;
  if (typeof signal.throwIfAborted === 'function') signal.throwIfAborted();
  throw signal.reason instanceof Error ? signal.reason : new Error('子智能体已取消');
}

const RESERVED_SUBAGENT_NAMES = new Set(['__proto__', 'prototype', 'constructor']);
const SUBAGENT_MANAGEMENT_TOOLS = new Set([
  'subagent',
  'subagent_stop',
  'bg_wait',
  'subagent_supervisor',
  'contact_supervisor',
]);

function normalizeSubagentName(value, fallback) {
  const name = typeof value === 'string' ? value.trim() : '';
  if (!name && fallback) return fallback;
  if (!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(name) || RESERVED_SUBAGENT_NAMES.has(name)) {
    throw new Error('子智能体名称必须以字母开头，只能包含字母、数字、_、-，且最长 64 个字符');
  }
  return name;
}

function registryAgent(state, name) {
  return Object.hasOwn(state.agents, name) ? state.agents[name] : undefined;
}

function registryReporter(state, requestKey) {
  return Object.hasOwn(state.reporters, requestKey) ? state.reporters[requestKey] : undefined;
}

function backgroundOptions() {
  return {
    ownership: { kind: 'conversation' },
    background: true,
  };
}

function activeReporterCount(state) {
  return Object.values(state.reporters || {})
    .filter((reporter) => reporter?.active === true)
    .length;
}

/**
 * A foreground tool task is aborted together with the child conversation it
 * owns. The task may reject before its normal status write, so make a final
 * best-effort write without inheriting an already-aborted context. The child
 * projection also derives status from the owning Durable task, which keeps UI
 * state correct if this cleanup cannot commit while the task is abort-marked.
 */
async function writeSubagentStatus({
  api,
  protocol,
  parentConversationId,
  name,
  status,
  error,
  context,
}) {
  const commitContext = context?.abortSignal?.aborted
    ? { ...context, abortSignal: undefined }
    : context;
  await api.commit(async (tx) => {
    const registry = await tx.doc(protocol.Subagents, parentConversationId);
    const agent = registryAgent(registry, name);
    if (!agent) return;
    agent.lastStatus = status;
    agent.updatedAt = api.now();
    if (error) {
      agent.lastError = String(error).slice(0, 2_000);
    } else {
      delete agent.lastError;
    }
  }, commitContext);
}

function childToolsFor(agent, defaults, childSupervisorTool) {
  const allowed = defaults.allowedTools.length > 0
    ? new Set(defaults.allowedTools)
    : undefined;
  const modelTools = [];
  const enabledTools = [];
  const enabledNames = new Set();
  const canExpose = (tool) => (
    tool?.name
    && !SUBAGENT_MANAGEMENT_TOOLS.has(tool.name)
    && (!allowed || allowed.has(tool.name))
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
  if (defaults.allowedTools.length > 0 && enabledTools.length === 0) {
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

function childInstructions(name, parentConversationId, supervisorEnabled) {
  return [
    `You are Studio subagent "${name}" (parent conversation ${parentConversationId}).`,
    'Work only within the tools and workspace granted to this child conversation.',
    'Never claim to have created another subagent. Child conversations cannot spawn children.',
    ...(supervisorEnabled
      ? ['Use contact_supervisor only when parent approval or missing context blocks safe progress. The request is asynchronous; continue with independent work while awaiting a reply.']
      : []),
  ].join('\n');
}

function settingsWorkspace(agent) {
  return agent && typeof agent.cwd === 'string' ? agent.cwd : '';
}

function assertBudgetAvailable(parentConversationId, defaults, state) {
  const usage = { ...subagentUsage(state), parentConversationId };
  const budget = evaluateSubagentBudget(defaults, usage);
  if (budget.budgetAction === 'stop' && budget.exceeded) {
    throw new Error(
      `子智能体预算已用尽（${budget.tokens.toLocaleString()} tokens，$${budget.costUsd.toFixed(4)}）；`
      + '请在设置中提高预算，或调整预算策略为仅提醒',
    );
  }
  return usage;
}

async function resolveChildSettings(args, api, context, childSupervisorTool, piAi) {
  const agent = await api.agent(context);
  const defaults = normalizeSubagentConfig(
    getSubagentConfig('user'),
    getSubagentConfig('project', agent.cwd || ''),
  );
  const requestedModel = args.model ? modelRef(args.model) : defaults.modelRef;
  if (args.model && !requestedModel) {
    throw new Error('子智能体模型必须使用 provider/modelId 格式');
  }
  const requestedThinking = args.thinkingLevel || defaults.thinkingLevel;
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
    ? api.models.getModel(requestedModel.provider, requestedModel.modelId)
    : undefined;
  if (requestedModel && !childModel) {
    throw new Error(`子智能体模型不存在或尚未启用：${args.model || defaults.modelRef.provider + '/' + defaults.modelRef.modelId}`);
  }
  if (
    childModel
    && requestedThinking
    && !piAi.getSupportedThinkingLevels(childModel).includes(requestedThinking)
  ) {
    throw new Error(`模型 ${childModel.provider}/${childModel.id} 不支持 thinking=${requestedThinking}`);
  }
  let childCwd = agent.cwd || '';
  if (args.cwd) {
    if (!agent.cwd) throw new Error('父智能体没有工作区，不能设置子智能体工作目录');
    const resolved = await resolveWorkspacePath(agent.cwd, args.cwd);
    childCwd = resolved.target;
  }
  const { enabledTools, modelTools } = childToolsFor(
    agent,
    defaults,
    childSupervisorTool,
  );
  return {
    agent,
    defaults,
    requestedModel,
    requestedThinking,
    childCwd,
    enabledTools,
    modelTools,
  };
}

async function configureChildConversation({
  tx,
  durable,
  childId,
  parentConversationId,
  name,
  anchorTaskId,
  ownerTaskId,
  mode,
  settings,
  instructions,
  parentExtension,
  childChannelExtension,
}) {
  const protocol = createProtocol(durable);
  const childExtensions = (settings.agent.extensions || [])
    .filter((extension) => (
      extension !== parentExtension
      && extension?.name !== parentExtension.name
    ));
  if (!childExtensions.some((extension) => extension?.name === childChannelExtension.name)) {
    childExtensions.push(childChannelExtension);
  }
  await durable.configure(tx, childId, {
    extensions: childExtensions,
    tools: settings.enabledTools,
    modelTools: settings.modelTools,
    ...(settings.requestedModel ? { model: settings.requestedModel } : {}),
    ...(settings.requestedThinking ? { thinkingLevel: settings.requestedThinking } : {}),
    ...(settings.childCwd && settings.childCwd !== settings.agent.cwd
      ? { cwd: settings.childCwd }
      : {}),
    ...(instructions ? { instructions } : {}),
  });
  const childContext = await tx.doc(protocol.ChildContext, childId);
  childContext.parentConversationId = parentConversationId;
  childContext.name = name;
  childContext.anchorTaskId = anchorTaskId || 0;
  childContext.workspace = settings.childCwd || settings.agent.cwd || '';
  childContext.worktreeId = settings.worktreeId || '';
  childContext.isolation = settings.isolation || 'workspace';
  childContext.supervisorEnabled = Boolean(settings.defaults.supervisorEnabled);
  childContext.createdAt = settings.createdAt;
  const registry = await tx.doc(protocol.Subagents, parentConversationId);
  registry.agents[name] = {
    name,
    conversationId: childId,
    anchorTaskId: anchorTaskId || 0,
    ownerTaskId: ownerTaskId || 0,
    mode,
    createdAt: settings.createdAt,
    updatedAt: settings.createdAt,
    reported: [],
    lastStatus: 'running',
    worktreeId: settings.worktreeId || '',
    isolation: settings.isolation || 'workspace',
  };
}


function createSubagentChannelExtension(durable, piAi) {
  const { defineExtension, defineTool } = durable;
  const Type = toolSchema;
  const protocol = createProtocol(durable);
  return defineExtension({
    name: 'studio-subagent-channel',
    tasks: [protocol.AnswerCapture],
    hooks: [
      durable.hook(durable.GenerationTask, {
        /**
         * 子会话回答结束时，在子会话作用域内把最终正文写进 ChildContext。
         * reporter 跑在父会话，读不到子会话条目，只能靠这里落盘再回读。
         */
        async afterRun(run, api, context) {
          try {
            const child = await api.snapshot(protocol.ChildContext, api.conversationId, context);
            if (!child?.parentConversationId) return undefined;
            return {
              tasks: [durable.runEndTask(protocol.AnswerCapture, { answer: String(run.answer) })],
            };
          } catch (error) {
            console.warn('[pi-studio] subagent answer capture hook failed', error);
            return undefined;
          }
        },
      }),
    ],
    tools: [
      defineTool({
        name: 'contact_supervisor',
        description: 'Send an asynchronous question or approval request to the parent Agent that created this child. A parent reply starts a new child turn when needed.',
        parameters: Type.Object({
          question: Type.String({ description: 'The exact decision, missing context, or approval needed from the parent.' }),
        }),
        replay: 'safe',
        async execute(args, api, context) {
          const child = await api.snapshot(protocol.ChildContext, api.conversationId, context);
          if (!child?.parentConversationId) {
            throw new Error('contact_supervisor 只能在 Studio 创建的子智能体中调用');
          }
          if (!child.supervisorEnabled) {
            throw new Error('当前子智能体没有启用父级监督通道');
          }
          const question = String(args.question || '').trim();
          if (!question || question.length > MAX_SUBAGENT_SUPERVISOR_LENGTH) {
            throw new Error(`监督问题不能为空，且不能超过 ${MAX_SUBAGENT_SUPERVISOR_LENGTH} 个字符`);
          }
          const main = await api.conversation(child.parentConversationId, context);
          if (!main) throw new Error('创建此子智能体的主会话不存在');
          const requestId = `supervisor:${api.taskId}`;
          const now = api.now();
          await api.commit(async (tx) => {
            const registry = await tx.doc(protocol.Subagents, child.parentConversationId);
            const agent = registryAgent(registry, child.name);
            if (!agent || agent.conversationId !== api.conversationId) {
              throw new Error('子智能体归属信息已经失效');
            }
            if (!Object.hasOwn(registry.supervisorRequests, requestId)) {
              const pendingForChild = Object.values(registry.supervisorRequests)
                .filter((request) => (
                  request?.status === 'pending'
                  && request.childConversationId === api.conversationId
                )).length;
              if (pendingForChild >= 4) {
                throw new Error('该子智能体最多同时保留 4 个待回复监督请求');
              }
              registry.supervisorRequests[requestId] = {
                requestId,
                childConversationId: api.conversationId,
                childName: child.name,
                question,
                status: 'pending',
                createdAt: now,
                updatedAt: now,
              };
              protocol.pruneSupervisorRequests(registry.supervisorRequests);
            }
          }, context);
          const submission = await main.submit({
            type: 'input',
            content: [
              '[subagent supervisor request]',
              `request: ${requestId}`,
              `child: ${child.name}`,
              `question: ${question}`,
              'Use subagent_supervisor with action "reply" when you can answer.',
            ].join('\n'),
            whenBusy: 'followUp',
            requestId: `subagent-supervisor-request:${requestId}`,
          }, context);
          return {
            output: [{
              type: 'text',
              text: `已把监督请求发给主智能体（${requestId}）。请求是异步的；不要把它描述成同步阻塞。`,
            }],
            details: {
              supervisorRequestId: requestId,
              parentSubmissionId: String(submission.id),
            },
          };
        },
      }),
    ],
  });
}

function createSubagentExtension(durable, piAi, chordContext) {
  const { defineExtension, defineTool } = durable;
  const Type = toolSchema;
  const protocol = createProtocol(durable);
  const channel = createSubagentChannelExtension(durable, piAi);
  const childSupervisorTool = channel.tools.find((tool) => tool.name === 'contact_supervisor');

  const parentExtension = defineExtension({
    name: 'studio-subagents',
    tasks: [protocol.Anchor, protocol.Reporter],
    sections: [
      durable.section('studio-subagents', () => (
        [
          'Use subagent for self-contained parallel work. A child has its own conversation, model, thinking level, cwd, and narrower tool set.',
          'action=run waits for a foreground result. action=spawn starts a durable background child and reports its answer back as a follow-up.',
          'Use action=send to steer or follow up a named background child, bg_wait to wait for a reporter without stopping it, and subagent_stop to stop only that child.',
          'Child superagent requests arrive as supervisor follow-up messages and must be answered with subagent_supervisor.',
        ].join(' ')
      ), { tag: false }),
    ],
    tools: [
      defineTool({
        name: 'subagent',
        description: 'Run or manage one child Agent. action=run is foreground and waits for the result; spawn creates a named durable background child; send messages a background child; status lists children. use subagent_stop to stop one.',
        parameters: Type.Object({
          action: Type.Optional(Type.Union([
            Type.Literal('run'),
            Type.Literal('spawn'),
            Type.Literal('send'),
            Type.Literal('status'),
          ])),
          name: Type.Optional(Type.String({ description: 'Stable child name for background operations. Names must start with a letter and use letters, digits, _ or -.' })),
          task: Type.Optional(Type.String({ description: 'The complete task for run or spawn.' })),
          message: Type.Optional(Type.String({ description: 'Message for spawn or send.' })),
          instructions: Type.Optional(Type.String({ description: 'Optional role-specific instructions.' })),
          model: Type.Optional(Type.String({
            description: 'Optional provider/modelId override for this child. It must exist in Studio settings.',
          })),
          thinkingLevel: Type.Optional(Type.String({
            description: 'Optional thinking level: off, minimal, low, medium, high, xhigh, or max.',
          })),
          cwd: Type.Optional(Type.String({
            description: 'Optional existing subdirectory inside the parent workspace.',
          })),
          isolation: Type.Optional(Type.Union([
            Type.Literal('workspace'),
            Type.Literal('worktree'),
          ], {
            description: 'Use the shared parent workspace or an isolated managed Git worktree.',
          })),
          mode: Type.Optional(Type.Union([
            Type.Literal('foreground'),
            Type.Literal('background'),
          ])),
          followUp: Type.Optional(Type.Boolean({
            description: 'For send: queue after the child current answer (default true); false steers at the next step.',
          })),
        }),
        replay: 'safe',
        async execute(args, api, context) {
          throwIfAborted(context);
          const parentConversationId = Number(api.conversationId);
          if (!Number.isSafeInteger(parentConversationId) || parentConversationId <= 0) {
            throw new Error('子智能体只能在持久会话中运行');
          }
          const action = args.action || 'run';
          const now = api.now();

          if (action === 'status') {
            const state = await api.snapshot(protocol.Subagents, parentConversationId, context)
              || emptyRegistry();
            const lines = [];
            for (const agent of Object.values(state.agents)) {
              const live = await api.snapshot(durable.LiveDoc, agent.conversationId, context);
              const pending = Object.values(state.supervisorRequests)
                .filter((request) => (
                  request?.childConversationId === agent.conversationId
                  && request.status === 'pending'
                )).length;
              const summary = typeof agent.lastReport === 'string'
                ? agent.lastReport.replace(/\s+/g, ' ').trim().slice(0, 160)
                : '';
              lines.push(
                `${agent.name}: ${live?.run ? 'running' : agent.lastStatus || 'idle'}`
                + ` (${agent.mode || 'background'}, conversation ${agent.conversationId}`
                + `${pending ? `, ${pending} supervisor pending` : ''})`
                + `${summary ? `\n  最近回传：${summary}` : ''}`,
              );
            }
            return {
              output: [{ type: 'text', text: lines.join('\n') || 'No subagents.' }],
              details: { agents: Object.values(state.agents) },
            };
          }

          if (action === 'send') {
            const name = normalizeSubagentName(args.name);
            const state = await api.snapshot(protocol.Subagents, parentConversationId, context)
              || emptyRegistry();
            const agent = registryAgent(state, name);
            if (!agent) throw new Error(`没有名为 ${name} 的子智能体`);
            if (agent.mode !== 'background') {
              throw new Error(`${name} 是前台子智能体，不能继续发送消息`);
            }
            const message = String(args.message || args.task || '').trim();
            if (!message) throw new Error('send 需要 message');
            if (message.length > MAX_SUBAGENT_TEXT_LENGTH) {
              throw new Error(`子智能体消息不能超过 ${MAX_SUBAGENT_TEXT_LENGTH} 个字符`);
            }
            const defaults = normalizeSubagentConfig(
              getSubagentConfig('user'),
              getSubagentConfig('project', settingsWorkspace(await api.agent(context))),
            );
            assertBudgetAvailable(parentConversationId, defaults, state);
            let sendWorktreeId = agent.worktreeId || '';
            let recreatedWorktree;
            const existingWorktree = sendWorktreeId
              ? getStudioDatabase().getManagedWorktree(sendWorktreeId)
              : undefined;
            if (
              sendWorktreeId
              && (
                !existingWorktree
                || ['applied', 'discarded', 'removed'].includes(existingWorktree.status)
                || !require('node:fs').existsSync(existingWorktree.path)
              )
            ) {
              const parentAgent = await api.agent(context);
              if (!parentAgent.cwd) throw new Error('父智能体没有可用于恢复隔离工作树的工作区');
              const nextWorktreeId = `durable-${parentConversationId}-${api.taskId}`;
              recreatedWorktree = await createManagedWorktree({
                id: nextWorktreeId,
                parentConversationId: String(parentConversationId),
                childConversationId: String(agent.conversationId),
                name: name || `agent-${api.taskId}`,
                workspace: parentAgent.cwd,
                limit: defaults.worktreeLimit,
              });
              sendWorktreeId = nextWorktreeId;
            }
            try {
              await api.commit(async (tx) => {
                if (recreatedWorktree) {
                  await durable.configure(tx, agent.conversationId, {
                    cwd: recreatedWorktree.path,
                  });
                  const childContext = await tx.doc(protocol.ChildContext, agent.conversationId);
                  childContext.workspace = recreatedWorktree.path;
                  childContext.worktreeId = sendWorktreeId;
                  childContext.isolation = 'worktree';
                  const registry = await tx.doc(protocol.Subagents, parentConversationId);
                  const registered = registryAgent(registry, name);
                  if (registered) {
                    registered.worktreeId = sendWorktreeId;
                    registered.isolation = 'worktree';
                  }
                }
                await createReporter({
                  tx,
                  durable,
                  parentConversationId,
                  requestKey: `tool:${api.taskId}`,
                  name,
                  conversationId: agent.conversationId,
                  message,
                  followUp: args.followUp !== false,
                  now,
                  maximum: defaults.maxConcurrent,
                  worktreeId: sendWorktreeId,
                });
              }, context);
            } catch (error) {
              if (recreatedWorktree) {
                await discardManagedWorktree(recreatedWorktree.id, { force: true }).catch(() => {});
              }
              throw error;
            }
            await api.details({
              agents: [{
                name,
                conversationId: String(agent.conversationId),
                ...(sendWorktreeId ? { worktreeId: sendWorktreeId } : {}),
              }],
            }, context);
            return {
              output: [{ type: 'text', text: `已向 ${name} 发送消息；结果完成后会自动回传。` }],
              details: {
                name,
                conversationId: String(agent.conversationId),
                ...(sendWorktreeId ? { worktreeId: sendWorktreeId } : {}),
              },
            };
          }

          const settingsBase = await resolveChildSettings(
            args,
            api,
            context,
            childSupervisorTool,
            piAi,
          );
          const registryState = await api.snapshot(protocol.Subagents, parentConversationId, context)
            || emptyRegistry();
          const budgetUsage = assertBudgetAvailable(
            parentConversationId,
            settingsBase.defaults,
            registryState,
          );
          const explicitBackground = action === 'spawn' || args.mode === 'background';
          const background = explicitBackground
            || (!args.mode && settingsBase.defaults.defaultMode === 'background');
          if (background && !settingsBase.defaults.backgroundEnabled) {
            throw new Error('后台子智能体已在 Studio 设置中关闭');
          }
          const explicitIsolation = args.isolation === 'workspace' || args.isolation === 'worktree'
            ? args.isolation
            : '';
          const isolateByDefault = settingsBase.defaults.worktreeIsolation === 'always'
            || (
              settingsBase.defaults.worktreeIsolation === 'background'
              && background
            );
          const shouldIsolate = explicitIsolation
            ? explicitIsolation === 'worktree'
            : isolateByDefault;
          if (shouldIsolate && args.cwd) {
            throw new Error('隔离工作树不能与 cwd 同时使用；工作树路径已经是完整子工作区');
          }
          const taskText = String(args.task || args.message || '').trim();
          if (!taskText) throw new Error(`${action} 需要 task 或 message`);
          if (taskText.length > MAX_SUBAGENT_TEXT_LENGTH) {
            throw new Error(`子智能体任务不能超过 ${MAX_SUBAGENT_TEXT_LENGTH} 个字符`);
          }
          const instructions = String(args.instructions || '').trim();
          if (instructions.length > MAX_SUBAGENT_INSTRUCTIONS_LENGTH) {
            throw new Error(`子智能体附加指令不能超过 ${MAX_SUBAGENT_INSTRUCTIONS_LENGTH} 个字符`);
          }
          const requestedName = background
            ? normalizeSubagentName(args.name, `agent-${api.taskId}`)
            : undefined;
          let worktreeId = '';
          let worktreeRecord;
          let worktreeExisted = false;
          if (shouldIsolate) {
            const parentWorkspace = settingsBase.agent.cwd || '';
            const gitWorkspace = parentWorkspace && await isGitRepository(parentWorkspace);
            if (!gitWorkspace) {
              if (explicitIsolation === 'worktree') {
                throw new Error('当前工作区不是可提交的 Git 仓库，无法创建隔离工作树');
              }
            } else {
              worktreeId = `durable-${parentConversationId}-${api.taskId}`;
              worktreeExisted = Boolean(getStudioDatabase().getManagedWorktree(worktreeId));
              try {
                worktreeRecord = await createManagedWorktree({
                  id: worktreeId,
                  parentConversationId: String(parentConversationId),
                  name: args.name || requestedName || `agent-${api.taskId}`,
                  workspace: parentWorkspace,
                  limit: settingsBase.defaults.worktreeLimit,
                });
              } catch (error) {
                throw new Error(`无法创建隔离工作树：${error instanceof Error ? error.message : String(error)}`);
              }
            }
          }
          const settings = {
            ...settingsBase,
            createdAt: now,
            ...(worktreeRecord
              ? {
                  childCwd: worktreeRecord.path,
                  worktreeId,
                  isolation: 'worktree',
                }
              : { isolation: 'workspace' }),
          };

          if (background) {
            let created;
            try {
              created = await api.commit(async (tx) => {
                const state = await tx.doc(protocol.Subagents, parentConversationId);
                const previous = registryReporter(state, `tool:${api.taskId}`);
                if (previous) {
                  return {
                    name: previous.name,
                    conversationId: registryAgent(state, previous.name).conversationId,
                    taskId: previous.taskId,
                    replayed: true,
                  };
                }
                if (Object.keys(state.agents).length >= settings.defaults.maxSpawns) {
                  throw new Error(`当前会话最多创建 ${settings.defaults.maxSpawns} 个子智能体`);
                }
                if (registryAgent(state, requestedName)) {
                  throw new Error(`子智能体名称已存在：${requestedName}；请使用 action=send`);
                }
                const anchorTaskId = await tx.createTask(
                  protocol.Anchor,
                  null,
                  backgroundOptions(),
                );
                const child = await tx.createConversation({
                  ownership: { kind: 'task', taskId: anchorTaskId },
                });
                await configureChildConversation({
                  tx,
                  durable,
                  childId: child.id,
                  parentConversationId,
                  name: requestedName,
                  anchorTaskId,
                  ownerTaskId: 0,
                  mode: 'background',
                  settings,
                  instructions: [
                    instructions,
                    childInstructions(
                      requestedName,
                      parentConversationId,
                      settings.defaults.supervisorEnabled,
                    ),
                  ].filter(Boolean).join('\n\n'),
                  parentExtension,
                  childChannelExtension: channel,
                });
                const reporter = await createReporter({
                  tx,
                  durable,
                  parentConversationId,
                  requestKey: `tool:${api.taskId}`,
                  name: requestedName,
                  conversationId: child.id,
                  message: taskText,
                  followUp: false,
                  now,
                  maximum: settings.defaults.maxConcurrent,
                  worktreeId,
                });
                return {
                  name: requestedName,
                  conversationId: child.id,
                  taskId: reporter.taskId,
                  replayed: false,
                };
              }, context);
            } catch (error) {
              if (worktreeId && !worktreeExisted) {
                await discardManagedWorktree(worktreeId, { force: true }).catch(() => {});
              }
              throw error;
            }
            if (worktreeId) {
              await bindManagedWorktree(worktreeId, created.conversationId);
            }
            await api.details({
              name: created.name,
              conversationId: String(created.conversationId),
              reporterTaskId: String(created.taskId),
              ...(worktreeId ? { worktreeId } : {}),
              budgetUsage,
            }, context);
            return {
              output: [{
                type: 'text',
                text: created.replayed
                  ? `${created.name} 的本次后台请求已经在运行。`
                  : `已在后台启动 ${created.name}${worktreeRecord ? '（隔离工作树）' : ''}；主智能体可以继续工作，结果会作为 follow-up 回传。`,
              }],
              details: {
                name: created.name,
                conversationId: String(created.conversationId),
                reporterTaskId: String(created.taskId),
                ...(worktreeId ? { worktreeId } : {}),
                budgetUsage,
              },
            };
          }

          let childId;
          try {
            childId = await api.commit(async (tx) => {
              const existing = (await tx.scanConversations({ ownerTaskId: api.taskId }, 1)).items[0];
              const id = existing?.id || (await tx.createConversation({
                ownership: { kind: 'task', taskId: api.taskId },
              })).id;
              const state = await tx.doc(protocol.Subagents, parentConversationId);
              const existingRegistryChild = Object.values(state.agents)
                .find((agent) => agent.ownerTaskId === api.taskId);
              const name = existingRegistryChild?.name
                || normalizeSubagentName(args.name, `foreground-${api.taskId}`);
              if (registryAgent(state, name) && !existingRegistryChild) {
                throw new Error(`子智能体名称已存在：${name}`);
              }
              if (!existingRegistryChild && Object.keys(state.agents).length >= settings.defaults.maxSpawns) {
                throw new Error(`当前会话最多创建 ${settings.defaults.maxSpawns} 个子智能体`);
              }
              await configureChildConversation({
                tx,
                durable,
                childId: id,
                parentConversationId,
                name,
                anchorTaskId: 0,
                ownerTaskId: api.taskId,
                mode: 'foreground',
                settings,
                instructions: [
                  instructions,
                  childInstructions(name, parentConversationId, false),
                ].filter(Boolean).join('\n\n'),
                parentExtension,
                childChannelExtension: channel,
              });
              return { id, name };
            }, context);
          } catch (error) {
            if (worktreeId && !worktreeExisted) {
              await discardManagedWorktree(worktreeId, { force: true }).catch(() => {});
            }
            throw error;
          }
          if (worktreeId) await bindManagedWorktree(worktreeId, childId.id);
          throwIfAborted(context);
          await api.details({
            name: childId.name,
            conversationId: String(childId.id),
            ...(worktreeId ? { worktreeId } : {}),
            budgetUsage,
          }, context);
          const conversation = await api.conversation(childId.id, context);
          if (!conversation) throw new Error('子智能体会话创建失败');
          const submission = await conversation.submit({
            type: 'input',
            content: taskText,
            requestId: `subagent:${api.taskId}`,
          }, context);
          let settled;
          let text = '';
          let lastStatus = 'failed';
          let lastError = '子智能体执行失败';
          try {
            settled = await submission.wait(context);
            if (settled.status === 'done' && settled.type === 'input' && settled.answer !== undefined) {
              const answer = await api.commit(
                (tx) => tx.entry(settled.answer),
                context,
              );
              text = protocol.textOfEntry(answer);
            }
            lastStatus = context?.abortSignal?.aborted
              ? 'stopped'
              : settled.status === 'done'
                ? 'completed'
                : settled.reason === 'aborted'
                  ? 'stopped'
                  : 'failed';
            lastError = lastStatus === 'failed'
              ? String(settled.reason || settled.status || '子智能体执行失败')
              : undefined;
          } catch (error) {
            lastStatus = context?.abortSignal?.aborted ? 'stopped' : 'failed';
            lastError = error instanceof Error ? error.message : String(error);
            throw error;
          } finally {
            try {
              await writeSubagentStatus({
                api,
                protocol,
                parentConversationId,
                name: childId.name,
                status: lastStatus,
                error: lastError,
                context,
              });
            } catch (error) {
              // The owning Durable task remains the authoritative fallback in
              // the read-only child projection.
              console.warn('Unable to persist subagent terminal status:', error);
            }
            if (worktreeId) {
              await completeManagedWorktree(worktreeId, {
                status: lastStatus === 'failed' ? 'failed' : 'finished',
                error: lastError || '',
              }).catch((error) => {
                console.warn('Unable to settle managed worktree:', error);
              });
            }
          }
          throwIfAborted(context);
          return {
            output: [{
              type: 'text',
              text: settled.status === 'done'
                ? text || '子智能体已完成，但没有返回文本。'
                : `子智能体未能回答：${settled.reason || settled.status}`,
            }],
            details: {
              name: childId.name,
              conversationId: String(childId.id),
              submissionId: String(submission.id),
              status: settled.status,
              ...(worktreeId ? { worktreeId } : {}),
              budgetUsage,
            },
          };
        },
      }),
      defineTool({
        name: 'subagent_stop',
        description: 'Stop the current run of one named background child. The child conversation remains available for later messages. This operation is deliberately not replayed after a crash.',
        parameters: Type.Object({
          name: Type.String({ description: 'The background child name.' }),
        }),
        replay: 'unsafe',
        async execute(args, api, context) {
          const parentConversationId = Number(api.conversationId);
          const name = normalizeSubagentName(args.name);
          const state = await api.snapshot(protocol.Subagents, parentConversationId, context)
            || emptyRegistry();
          const agent = registryAgent(state, name);
          if (!agent) throw new Error(`没有名为 ${name} 的子智能体`);
          if (agent.mode !== 'background') {
            throw new Error(`${name} 不是后台子智能体`);
          }
          const conversation = await api.conversation(agent.conversationId, context);
          if (conversation) await conversation.abort(context, { background: true });
          await api.commit(async (tx) => {
            const registry = await tx.doc(protocol.Subagents, parentConversationId);
            const current = registryAgent(registry, name);
            if (current) {
              current.lastStatus = 'stopped';
              current.updatedAt = api.now();
            }
          }, context);
          return {
            output: [{ type: 'text', text: `已停止 ${name} 的当前运行。` }],
            details: { name, conversationId: String(agent.conversationId) },
          };
        },
      }),
      defineTool({
        name: 'bg_wait',
        description: 'Wait for a reporter of one background child or a specific reporter run. A timeout or cancellation ends only this wait; it never stops the child.',
        parameters: Type.Object({
          name: Type.Optional(Type.String({ description: 'Background child name. The newest reporter is selected.' })),
          runId: Type.Optional(Type.String({ description: 'Specific reporter task ID returned by subagent.' })),
          timeoutMs: Type.Optional(Type.Number({ minimum: 1000, maximum: 600000 })),
        }),
        replay: 'safe',
        async execute(args, api, context) {
          const parentConversationId = Number(api.conversationId);
          const state = await api.snapshot(protocol.Subagents, parentConversationId, context)
            || emptyRegistry();
          const reporters = Object.values(state.reporters);
          let reporter;
          if (args.runId) {
            const id = Number(args.runId);
            reporter = reporters.find((item) => Number(item.taskId) === id);
            if (!reporter) throw new Error('指定的后台 reporter 不属于当前会话');
          } else {
            const name = normalizeSubagentName(args.name);
            reporter = reporters
              .filter((item) => item.name === name)
              .sort((left, right) => Number(right.taskId) - Number(left.taskId))[0];
            if (!reporter) throw new Error(`${name} 没有可等待的后台运行`);
          }
          const defaults = normalizeSubagentConfig(
            getSubagentConfig('user'),
            getSubagentConfig('project', settingsWorkspace(await api.agent(context))),
          );
          const timeoutMs = Math.min(
            600_000,
            Math.max(1_000, Number(args.timeoutMs) || defaults.waitTimeoutMs),
          );
          const timeout = new AbortController();
          const timer = setTimeout(() => timeout.abort(new Error('bg_wait timeout')), timeoutMs);
          timer.unref?.();
          const waitContext = chordContext?.withAbortSignal
            ? chordContext.withAbortSignal(timeout.signal, context)
            : context;
          // 先登记「父智能体正在等」：reporter 收尾时据此跳过多余的 follow-up。
          await api.commit(async (tx) => {
            const registry = await tx.doc(protocol.Subagents, parentConversationId);
            const agent = registryAgent(registry, reporter.name);
            if (agent) agent.waitingSince = api.now();
          }, context);
          let timedOut = false;
          try {
            await api.waitForTask(reporter.taskId, waitContext);
          } catch (error) {
            if (context?.abortSignal?.aborted) throw error;
            if (!timeout.signal.aborted) throw error;
            timedOut = true;
          } finally {
            clearTimeout(timer);
          }
          const task = await api.getTask(reporter.taskId, context);
          const settledState = await api.snapshot(protocol.Subagents, parentConversationId, context);
          const agent = registryAgent(settledState, reporter.name);
          await api.commit(async (tx) => {
            const registry = await tx.doc(protocol.Subagents, parentConversationId);
            const current = registryAgent(registry, reporter.name);
            if (current) delete current.waitingSince;
          }, context).catch(() => {});
          const report = typeof agent?.lastReport === 'string' ? agent.lastReport.trim() : '';
          const status = task?.state?.status || 'terminal';
          const body = timedOut
            ? `${reporter.name} 仍在运行；本次等待在 ${timeoutMs}ms 后结束，child 未被停止。`
            : report
              ? `${reporter.name} 已结束（${status}）。\n\n${report}`
              : `${reporter.name} 的这次运行已结束（${status}）。`;
          return {
            output: [{ type: 'text', text: body }],
            details: {
              name: reporter.name,
              reporterTaskId: String(reporter.taskId),
              timedOut,
              terminal: Boolean(task && task.state?.status === 'terminal'),
              report: report || undefined,
              status: agent?.lastStatus || undefined,
            },
          };
        },
      }),
      defineTool({
        name: 'subagent_supervisor',
        description: 'Review pending questions from child Agents and reply to one. Replies are queued as a child follow-up and the child answer is reported back.',
        parameters: Type.Object({
          action: Type.Union([
            Type.Literal('pending'),
            Type.Literal('reply'),
          ]),
          replyTo: Type.Optional(Type.String({ description: 'Supervisor request ID returned by contact_supervisor.' })),
          message: Type.Optional(Type.String({ description: 'Answer to the child request.' })),
        }),
        replay: 'safe',
        async execute(args, api, context) {
          const parentConversationId = Number(api.conversationId);
          const state = await api.snapshot(protocol.Subagents, parentConversationId, context)
            || emptyRegistry();
          if (args.action === 'pending') {
            const pending = Object.values(state.supervisorRequests)
              .filter((request) => request.status === 'pending')
              .sort((left, right) => Number(left.createdAt) - Number(right.createdAt));
            const text = pending.length
              ? pending.map((request) => (
                `${request.requestId} · ${request.childName}: ${request.question}`
              )).join('\n')
              : '没有待回复的子智能体监督请求。';
            return {
              output: [{ type: 'text', text }],
              details: { requests: pending },
            };
          }
          const replyTo = String(args.replyTo || '').trim();
          const message = String(args.message || '').trim();
          if (!replyTo || !message) throw new Error('reply 需要 replyTo 和 message');
          if (message.length > MAX_SUBAGENT_SUPERVISOR_LENGTH) {
            throw new Error(`监督回复不能超过 ${MAX_SUBAGENT_SUPERVISOR_LENGTH} 个字符`);
          }
          const request = Object.hasOwn(state.supervisorRequests, replyTo)
            ? state.supervisorRequests[replyTo]
            : undefined;
          if (!request) throw new Error('监督请求不存在或不属于当前会话');
          if (request.status === 'replied' && request.reply !== message) {
            throw new Error('这个监督请求已经用其他内容回复');
          }
          const agent = registryAgent(state, request.childName);
          if (!agent || agent.conversationId !== request.childConversationId) {
            throw new Error('监督请求对应的子智能体已失效');
          }
          const now = api.now();
          const defaults = normalizeSubagentConfig(
            getSubagentConfig('user'),
            getSubagentConfig('project', settingsWorkspace(await api.agent(context))),
          );
          const reporter = await api.commit((tx) => queueSupervisorReply({
            tx, durable, parentConversationId, replyTo, message, now,
            maximum: defaults.maxConcurrent,
          }), context);
          return {
            output: [{
              type: 'text',
              text: `已回复 ${request.childName}；回复会进入 child 的 follow-up，结果完成后再回传。`,
            }],
            details: {
              requestId: replyTo,
              reporterTaskId: String(reporter.taskId),
              conversationId: String(request.childConversationId),
            },
          };
        },
      }),
    ],
  });
  return { parentExtension, channel };
}

module.exports = {
  createSubagentExtension,
};
