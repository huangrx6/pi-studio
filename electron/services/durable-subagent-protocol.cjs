/**
 * Durable-owned protocol shared by background subagents, their reporters, and
 * the supervisor channel.
 *
 * The parent conversation document is the durable registry of child
 * conversations. Each child also gets a conversation document written by the
 * host, never from model-supplied arguments, so supervisor and permission
 * flows can derive their true parent without trusting the child model.
 */

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
        const { name, conversationId, message, followUp } = reporter.input;
        const child = await runtime.conversation(conversationId, context);
        let report;
        let answerId;
        let outcome = 'failed';
        if (!child) {
          report = `[subagent ${name} is unavailable] The child conversation no longer exists.`;
        } else {
          try {
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

module.exports = {
  createProtocol,
  emptyChildContext,
  emptyRegistry,
};
