/**
 * Durable-owned protocol shared by background subagents, their reporters, and
 * the supervisor channel.
 *
 * The parent conversation document is the durable registry of child
 * conversations. Each child also gets a conversation document written by the
 * host, never from model-supplied arguments, so supervisor and permission
 * flows can derive their true parent without trusting the child model.
 */

const {
  completeManagedWorktree,
  reactivateManagedWorktree,
} = require('./worktrees.cjs');

const contracts = new WeakMap();
const MAX_REPORTED_ANSWERS = 64;
const MAX_SUPERVISOR_REQUESTS = 200;

function emptyRegistry() {
  return {
    agents: {},
    reporters: {},
    supervisorRequests: {},
  };
}

function emptyChildContext() {
  return {
    parentConversationId: 0,
    name: '',
    anchorTaskId: 0,
    workspace: '',
    worktreeId: '',
    isolation: 'workspace',
    supervisorEnabled: false,
    createdAt: 0,
  };
}

function textOfEntry(entry) {
  return (entry?.model || [])
    .flatMap((message) => (
      message?.role === 'assistant' && Array.isArray(message.content)
        ? message.content
        : []
    ))
    .filter((block) => block?.type === 'text')
    .map((block) => String(block.text || ''))
    .join('\n')
    .trim();
}

function pruneSupervisorRequests(requests) {
  const terminal = Object.entries(requests)
    .filter(([, request]) => request?.status === 'replied')
    .sort((left, right) => (
      Number(right[1]?.updatedAt || 0) - Number(left[1]?.updatedAt || 0)
    ));
  for (const [key] of terminal.slice(MAX_SUPERVISOR_REQUESTS)) {
    delete requests[key];
  }
}

function createProtocol(durable) {
  const cached = contracts.get(durable);
  if (cached) return cached;

  const Subagents = durable.defineDoc({
    kind: 'studio.subagents',
    version: 1,
    scope: 'conversation',
    history: 'latest',
    fork: 'initial',
    checkpointWhen: () => false,
    initial: emptyRegistry,
  });

  const ChildContext = durable.defineDoc({
    kind: 'studio.subagent-child',
    version: 1,
    scope: 'conversation',
    history: 'latest',
    fork: 'initial',
    checkpointWhen: () => false,
    initial: emptyChildContext,
  });

  const Anchor = durable.defineTask({
    name: 'studio.subagent-anchor',
    version: 1,
    initial: () => ({ phase: 'done' }),
    phases: {
      done: (_task, runtime, context) => runtime.commit(() => ({
        status: 'terminal',
        outcome: { status: 'completed', result: null },
      }), context),
    },
    abort: (_task, runtime, context) => runtime.commit(() => ({
      status: 'terminal',
      outcome: { status: 'aborted' },
    }), context),
  });

  const Reporter = durable.defineTask({
    name: 'studio.subagent-reporter',
    version: 1,
    initial: () => ({ phase: 'deliver' }),
    phases: {
      deliver: async (reporter, runtime, context) => {
        const { name, conversationId, message, followUp, worktreeId } = reporter.input;
        const child = await runtime.conversation(conversationId, context);
        let report;
        let answerId;
        let outcome = 'failed';
        if (!child) {
          report = `[subagent ${name} is unavailable] The child conversation no longer exists.`;
        } else {
          try {
            await reactivateManagedWorktree(worktreeId);
            const submission = await child.submit({
              type: 'input',
              content: message,
              whenBusy: followUp ? 'followUp' : 'steer',
              requestId: `subagent:${reporter.id}`,
            }, context);
            const settled = await submission.wait(context);
            if (settled.status === 'done') {
              outcome = 'completed';
              if (settled.type === 'input') {
                answerId = settled.answer;
                const answer = await runtime.entry(settled.answer, context);
                const text = textOfEntry(answer);
                report = text
                  ? `[subagent ${name} answered]\n${text}`
                  : `[subagent ${name} completed without a text answer]`;
              } else {
                report = `[subagent ${name} completed]`;
              }
            } else {
              const reason = String(settled.reason || settled.status || 'unanswered');
              outcome = settled.reason === 'aborted' ? 'stopped' : 'failed';
              report = `[subagent ${name} ${outcome}: ${reason}]`;
            }
          } catch (error) {
            report = `[subagent ${name} failed: ${error instanceof Error ? error.message : String(error)}]`;
          }
        }

        if (worktreeId) {
          const state = await runtime.snapshot(Subagents, runtime.conversationId, context);
          const waitingForReply = Object.values(state?.supervisorRequests || {}).some((request) => (
            request.childConversationId === conversationId && request.status === 'pending'
          ));
          const hasOtherReporter = Object.values(state?.reporters || {}).some((registration) => (
            registration.name === name && registration.active && registration.taskId !== reporter.id
          ));
          // A completed model turn can still be waiting for a supervisor or a
          // queued follow-up. Keep its cwd alive until that work has settled.
          if (!waitingForReply && !hasOtherReporter) {
            await completeManagedWorktree(worktreeId, {
              status: outcome === 'completed' ? 'finished' : 'failed',
              error: outcome === 'completed' ? '' : report,
            }).catch((error) => {
              console.warn('Unable to settle managed worktree:', error);
            });
          }
        }

        await runtime.commit(async (tx) => {
          const registry = await tx.doc(Subagents, runtime.conversationId);
          const agent = Object.hasOwn(registry.agents, name)
            ? registry.agents[name]
            : undefined;
          if (agent && answerId !== undefined && !agent.reported.includes(answerId)) {
            agent.reported.push(answerId);
            if (agent.reported.length > MAX_REPORTED_ANSWERS) {
              agent.reported.splice(0, agent.reported.length - MAX_REPORTED_ANSWERS);
            }
          }
          if (agent) {
            agent.lastStatus = outcome;
            agent.updatedAt = runtime.now();
            agent.lastReporterTaskId = reporter.id;
            if (report && (report.includes('failed:') || report.includes('failed]'))) {
              agent.lastError = report.slice(0, 2_000);
            } else {
              delete agent.lastError;
            }
          }
          return {
            status: 'running',
            checkpoint: {
              phase: 'report',
              ...(report === undefined ? {} : { report }),
            },
          };
        }, context);
      },
      report: async (reporter, runtime, context) => {
        const { requestKey } = reporter.input;
        const report = reporter.state.checkpoint.report;
        if (report !== undefined) {
          const main = await runtime.conversation(runtime.conversationId, context);
          if (main) {
            await main.submit({
              type: 'input',
              content: report,
              whenBusy: 'followUp',
              requestId: `subagent-report:${reporter.id}`,
            }, context);
          }
        }
        return runtime.commit(async (tx) => {
          const registry = await tx.doc(Subagents, runtime.conversationId);
          const registration = requestKey && Object.hasOwn(registry.reporters, requestKey)
            ? registry.reporters[requestKey]
            : undefined;
          if (registration) {
            registration.active = false;
            registration.status = 'completed';
            registration.endedAt = runtime.now();
          }
          return {
            status: 'terminal',
            outcome: { status: 'completed', result: null },
          };
        }, context);
      },
    },
    abort: (reporter, runtime, context) => runtime.commit(async (tx) => {
      const registry = await tx.doc(Subagents, runtime.conversationId);
      const requestKey = reporter.input.requestKey;
      const registration = requestKey && Object.hasOwn(registry.reporters, requestKey)
        ? registry.reporters[requestKey]
        : undefined;
      if (registration) {
        registration.active = false;
        registration.status = 'stopped';
        registration.endedAt = runtime.now();
      }
      return {
        status: 'terminal',
        outcome: { status: 'aborted' },
      };
    }, context),
  });

  const contract = {
    Anchor,
    ChildContext,
    Reporter,
    Subagents,
    emptyChildContext,
    emptyRegistry,
    pruneSupervisorRequests,
    textOfEntry,
  };
  contracts.set(durable, contract);
  return contract;
}

function pruneReporterRegistrations(state, maximum = 256) {
  const terminal = Object.entries(state.reporters || {})
    .filter(([, reporter]) => reporter?.active !== true)
    .sort((left, right) => (
      Number(right[1]?.endedAt || right[1]?.createdAt || 0)
      - Number(left[1]?.endedAt || left[1]?.createdAt || 0)
    ));
  for (const [requestKey] of terminal.slice(maximum)) {
    delete state.reporters[requestKey];
  }
}


async function createReporter({
  tx,
  durable,
  parentConversationId,
  requestKey,
  name,
  conversationId,
  message,
  followUp,
  now,
  maximum,
  worktreeId = '',
}) {
  const protocol = createProtocol(durable);
  const registry = await tx.doc(protocol.Subagents, parentConversationId);
  const existing = (Object.hasOwn(registry.reporters, requestKey) ? registry.reporters[requestKey] : undefined);
  if (existing) return existing;
  if (Object.values(registry.reporters).filter((item) => item?.active === true).length >= maximum) {
    throw new Error(`后台子智能体已达到并发上限 ${maximum}`);
  }
  const taskId = await tx.createTask(protocol.Reporter, {
    name,
    conversationId,
    message,
    followUp: Boolean(followUp),
    requestKey,
    ...(worktreeId ? { worktreeId } : {}),
  }, { ownership: { kind: 'conversation' }, background: true });
  const record = {
    taskId,
    requestKey,
    name,
    active: true,
    status: 'running',
    createdAt: now,
    updatedAt: now,
  };
  registry.reporters[requestKey] = record;
  pruneReporterRegistrations(registry);
  const agent = (Object.hasOwn(registry.agents, name) ? registry.agents[name] : undefined);
  if (agent) {
    agent.lastReporterTaskId = taskId;
    agent.updatedAt = now;
  }
  return record;
}

/** Check and mark the reply in the same commit that creates its reporter. */
async function queueSupervisorReply({ tx, durable, parentConversationId, replyTo, message, now, maximum, childConversationId }) {
  const protocol = createProtocol(durable);
  const registry = await tx.doc(protocol.Subagents, parentConversationId);
  const current = Object.hasOwn(registry.supervisorRequests, replyTo) ? registry.supervisorRequests[replyTo] : undefined;
  if (!current || (childConversationId !== undefined && current.childConversationId !== childConversationId)) {
    throw new Error('监督请求不存在或不属于这个子智能体');
  }
  const agent = Object.hasOwn(registry.agents, current.childName) ? registry.agents[current.childName] : undefined;
  if (!agent || agent.conversationId !== current.childConversationId) throw new Error('监督请求对应的子智能体已失效');
  if (current.status === 'replied' && current.reply !== message) throw new Error('这个监督请求已经用其他内容回复');
  const requestKey = `supervisor-reply:${replyTo}`;
  // Even if the bounded reporter index has been pruned, never send the same reply twice.
  if (current.status === 'replied') return { taskId: current.reporterTaskId || registry.reporters[requestKey]?.taskId || 0 };
  const reporter = await createReporter({
    tx, durable, parentConversationId, requestKey, name: current.childName,
    conversationId: current.childConversationId,
    message: [`[supervisor reply to ${current.childName}]`, message,
      'Continue the task using this decision. Ask again only if a different decision is required.'].join('\n'),
    followUp: true, now, maximum,
    worktreeId: agent.worktreeId || '',
  });
  current.status = 'replied';
  current.reply = message;
  current.reporterTaskId = reporter.taskId;
  current.updatedAt = now;
  return reporter;
}

module.exports = {
  createReporter,
  queueSupervisorReply,
  createProtocol,
  emptyChildContext,
  emptyRegistry,
};
