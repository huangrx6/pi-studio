/**
 * Durable-owned state and continuation policy for Studio long-running goals.
 *
 * The SQLite conversation kind is only a sidebar projection. The goal and its
 * lifecycle live in a conversation document so they survive restarts and forks.
 * A GenerationTask hook turns an otherwise terminal answer into the next goal
 * iteration while the goal remains active.
 */

const LONG_TASK_DOC_KIND = 'studio.long-task';
const LONG_TASK_SCHEMA_VERSION = 2;
const LONG_TASK_EXTENSION_NAME = 'studio-long-task';
const LONG_TASK_TOOL_NAME = 'long_task';
const LONG_TASK_CONTINUATION_PREFIX = '[studio-long-task-continuation]';
const MAX_GOAL_LENGTH = 32_000;
const MAX_SUMMARY_LENGTH = 8_000;
const MAX_REASON_LENGTH = 8_000;
const MAX_LONG_TASK_CONTINUATIONS = 32;
const MAX_LONG_TASK_STALLED_CONTINUATIONS = 3;
const LONG_TASK_STATUSES = new Set([
  'idle',
  'active',
  'paused',
  'blocked',
  'completed',
  'failed',
]);

const contracts = new WeakMap();

function cleanText(value, maximum = MAX_GOAL_LENGTH) {
  return typeof value === 'string' ? value.trim().slice(0, maximum) : '';
}

function emptyLongTaskState() {
  return {
    enabled: false,
    goal: '',
    completionCriteria: '',
    status: 'idle',
    iteration: 0,
    lastProgress: '',
    nextStep: '',
    pauseReason: '',
    completionSummary: '',
    blockReason: '',
    lastMutationTaskId: 0,
    createdAt: 0,
    updatedAt: 0,
    completedAt: 0,
    blockedAt: 0,
  };
}

function normalizeLongTaskState(value) {
  const source = value && typeof value === 'object' && !Array.isArray(value)
    ? value
    : {};
  const initial = emptyLongTaskState();
  return {
    enabled: source.enabled === true,
    goal: cleanText(source.goal),
    completionCriteria: cleanText(source.completionCriteria),
    status: LONG_TASK_STATUSES.has(source.status) ? source.status : initial.status,
    iteration: Number.isSafeInteger(source.iteration) && source.iteration >= 0
      ? source.iteration
      : 0,
    lastProgress: cleanText(source.lastProgress, MAX_SUMMARY_LENGTH),
    nextStep: cleanText(source.nextStep, MAX_SUMMARY_LENGTH),
    pauseReason: cleanText(source.pauseReason, MAX_REASON_LENGTH),
    completionSummary: cleanText(source.completionSummary, MAX_SUMMARY_LENGTH),
    blockReason: cleanText(source.blockReason, MAX_REASON_LENGTH),
    lastMutationTaskId: Number.isSafeInteger(source.lastMutationTaskId)
      && source.lastMutationTaskId > 0
      ? source.lastMutationTaskId
      : 0,
    createdAt: Number.isFinite(source.createdAt) && source.createdAt > 0
      ? Number(source.createdAt)
      : 0,
    updatedAt: Number.isFinite(source.updatedAt) && source.updatedAt > 0
      ? Number(source.updatedAt)
      : 0,
    completedAt: Number.isFinite(source.completedAt) && source.completedAt > 0
      ? Number(source.completedAt)
      : 0,
    blockedAt: Number.isFinite(source.blockedAt) && source.blockedAt > 0
      ? Number(source.blockedAt)
      : 0,
  };
}

function createLongTaskContract(durable) {
  const existing = contracts.get(durable);
  if (existing) return existing;
  const LongTask = durable.defineDoc({
    kind: LONG_TASK_DOC_KIND,
    version: LONG_TASK_SCHEMA_VERSION,
    scope: 'conversation',
    history: 'latest',
    // A fork should preserve the goal and progress it branched from.
    fork: 'current',
    migrate: (value) => normalizeLongTaskState(value),
    checkpointWhen: (_value, _ops, info) => info.deltasSinceBase >= 32,
    initial: emptyLongTaskState,
  });
  const contract = { LongTask };
  contracts.set(durable, contract);
  return contract;
}

function initializeLongTaskState(target, options = {}) {
  const state = normalizeLongTaskState(target);
  const now = Number(options.now) || Date.now();
  const goal = cleanText(options.goal);
  if (goal) {
    state.enabled = true;
    state.goal = goal;
    state.completionCriteria = cleanText(options.completionCriteria) || goal;
    state.status = options.status || 'active';
    state.createdAt ||= now;
    state.updatedAt = now;
  }
  Object.assign(target, state);
  return state;
}

function publicLongTaskState(value) {
  const state = normalizeLongTaskState(value);
  return {
    enabled: state.enabled,
    goal: state.goal,
    completionCriteria: state.completionCriteria,
    status: state.status,
    iteration: state.iteration,
    lastProgress: state.lastProgress,
    nextStep: state.nextStep,
    pauseReason: state.pauseReason,
    completionSummary: state.completionSummary,
    blockReason: state.blockReason,
    createdAt: state.createdAt,
    updatedAt: state.updatedAt,
    completedAt: state.completedAt,
    blockedAt: state.blockedAt,
  };
}

function continuationText(state) {
  const current = normalizeLongTaskState(state);
  return [
    LONG_TASK_CONTINUATION_PREFIX,
    'Continue the persisted long-running goal.',
    `Goal: ${current.goal}`,
    `Completion criteria: ${current.completionCriteria || current.goal}`,
    current.lastProgress ? `Last recorded progress: ${current.lastProgress}` : '',
    current.nextStep ? `Next planned step: ${current.nextStep}` : '',
    'Inspect the current workspace and transcript before acting. Do not repeat completed work.',
    'Before ending this iteration with prose, call long_task with action "progress" and record the concrete next step unless the goal is complete or blocked.',
    'Call long_task with action "complete" only after every completion criterion is verified, including relevant tests or checks.',
    'Call long_task with action "block" only when user input, credentials, approval, or an external state is genuinely required.',
  ].filter(Boolean).join('\n');
}

function nextLongTaskContinuationGuard({
  continuations = 0,
  stalledContinuations = 0,
  iteration = 0,
  lastIteration = 0,
  maxContinuations = MAX_LONG_TASK_CONTINUATIONS,
  maxStalledContinuations = MAX_LONG_TASK_STALLED_CONTINUATIONS,
} = {}) {
  const continuationLimit = Math.max(1, Math.trunc(Number(maxContinuations))
    || MAX_LONG_TASK_CONTINUATIONS);
  const stalledLimit = Math.max(1, Math.trunc(Number(maxStalledContinuations))
    || MAX_LONG_TASK_STALLED_CONTINUATIONS);
  const nextContinuations = Math.max(0, Number(continuations) || 0) + 1;
  const progressed = Number(iteration) > Number(lastIteration);
  const nextStalledContinuations = progressed
    ? 0
    : Math.max(0, Number(stalledContinuations) || 0) + 1;
  const pauseReason = nextStalledContinuations >= stalledLimit
    ? `自动暂停：连续 ${stalledLimit} 轮没有通过 long_task 记录实际进展。检查目标与完成条件后，可继续执行。`
    : nextContinuations >= continuationLimit
      ? `自动暂停：本次执行已达到 ${continuationLimit} 轮安全上限。确认方向后，可继续执行。`
      : '';
  return {
    continuations: nextContinuations,
    stalledContinuations: nextStalledContinuations,
    iteration: Number(iteration) || 0,
    pauseReason,
  };
}

function isLongTaskContinuation(content) {
  if (typeof content === 'string') return content.startsWith(LONG_TASK_CONTINUATION_PREFIX);
  if (!Array.isArray(content)) return false;
  return content.some((block) => (
    block?.type === 'text'
    && String(block.text || '').startsWith(LONG_TASK_CONTINUATION_PREFIX)
  ));
}

function longTaskPrompt(state) {
  const current = normalizeLongTaskState(state);
  if (!current.enabled || !current.goal) return undefined;
  const statusGuidance = current.status === 'active'
    ? [
        'You are executing a persistent Studio goal. Continue autonomously across iterations until the goal is completed or genuinely blocked.',
        'Use long_task progress after material milestones, long_task complete after verified completion, and long_task block when user input is required.',
      ]
    : [
        `The persistent goal is currently ${current.status}. Do not resume goal execution or report new progress unless the user explicitly resumes or updates it.`,
      ];
  return [
    ...statusGuidance,
    `Goal:\n${current.goal}`,
    `Completion criteria:\n${current.completionCriteria || current.goal}`,
    current.lastProgress ? `Last progress:\n${current.lastProgress}` : '',
    current.nextStep ? `Next step:\n${current.nextStep}` : '',
    'Do not treat a prose answer as completion. Do not end an active iteration with prose alone: record progress and the next concrete step with long_task, or mark the goal complete or blocked.',
    'Completion requires evidence that satisfies the persisted criteria.',
  ].filter(Boolean).join('\n\n');
}

function createLongTaskExtension(durable, piAi) {
  const { defineExtension, defineTool, Type } = { ...durable, Type: piAi.Type };
  const { LongTask } = createLongTaskContract(durable);
  const action = Type.Union([
    Type.Literal('progress'),
    Type.Literal('complete'),
    Type.Literal('block'),
  ]);

  const longTask = defineTool({
    name: LONG_TASK_TOOL_NAME,
    description: [
      'Update the persisted lifecycle of this long-running goal.',
      'Use progress after a material milestone, complete only after all completion criteria are verified, and block only when user input or an external dependency is required.',
      'Do not use complete for partial work or ordinary conversational answers.',
    ].join(' '),
    parameters: Type.Object({
      action,
      summary: Type.Optional(Type.String({
        maxLength: MAX_SUMMARY_LENGTH,
        description: 'Verified progress or completion summary.',
      })),
      evidence: Type.Optional(Type.String({
        maxLength: MAX_SUMMARY_LENGTH,
        description: 'Tests, checks, files, or other evidence supporting completion.',
      })),
      nextStep: Type.Optional(Type.String({
        maxLength: MAX_SUMMARY_LENGTH,
        description: 'Concrete next action for a progress update.',
      })),
      reason: Type.Optional(Type.String({
        maxLength: MAX_REASON_LENGTH,
        description: 'Exact user input, credential, approval, or external state needed for block.',
      })),
    }),
    replay: 'safe',
    async execute(args, api, context) {
      const conversationId = Number(api.conversationId);
      if (!Number.isSafeInteger(conversationId) || conversationId <= 0) {
        throw new Error('long_task 只能在 Pi Durable 会话中运行');
      }
      const operation = String(args?.action || '');
      if (!['progress', 'complete', 'block'].includes(operation)) {
        throw new Error(`未知 long_task action：${operation || '(empty)'}`);
      }
      const summary = cleanText(args?.summary, MAX_SUMMARY_LENGTH)
        || cleanText(args?.evidence, MAX_SUMMARY_LENGTH);
      const nextStep = cleanText(args?.nextStep, MAX_SUMMARY_LENGTH);
      const reason = cleanText(args?.reason, MAX_REASON_LENGTH);
      if (operation === 'progress' && !summary) {
        throw new Error('long_task progress 需要 summary');
      }
      if (operation === 'complete' && !summary) {
        throw new Error('long_task complete 需要 verified summary');
      }
      if (operation === 'block' && !reason) {
        throw new Error('long_task block 需要具体 reason');
      }

      const mutationTaskId = Number(api.taskId);
      const result = await api.commit(async (tx) => {
        const stored = await tx.doc(LongTask, conversationId);
        const current = normalizeLongTaskState(stored);
        if (
          Number.isSafeInteger(mutationTaskId)
          && mutationTaskId > 0
          && current.lastMutationTaskId === mutationTaskId
        ) {
          return {
            state: publicLongTaskState(current),
            repeated: true,
          };
        }
        if (!current.enabled || !current.goal) {
          throw new Error('当前会话没有可更新的长期目标');
        }
        const now = api.now();
        if (operation === 'progress') {
          current.status = 'active';
          current.iteration += 1;
          current.lastProgress = summary;
          current.nextStep = nextStep;
          current.pauseReason = '';
          current.blockReason = '';
          current.blockedAt = 0;
        } else if (operation === 'complete') {
          current.status = 'completed';
          current.completionSummary = [summary, cleanText(args?.evidence, MAX_SUMMARY_LENGTH)]
            .filter(Boolean)
            .filter((item, index, items) => items.indexOf(item) === index)
            .join('\n\n');
          current.completedAt = now;
          current.pauseReason = '';
          current.blockReason = '';
          current.blockedAt = 0;
        } else {
          current.status = 'blocked';
          current.blockReason = reason;
          current.blockedAt = now;
          current.pauseReason = '';
        }
        current.updatedAt = now;
        if (Number.isSafeInteger(mutationTaskId) && mutationTaskId > 0) {
          current.lastMutationTaskId = mutationTaskId;
        }
        Object.assign(stored, current);
        return {
          state: publicLongTaskState(stored),
          repeated: false,
        };
      }, context);
      const label = result.repeated
        ? 'This long-task update was already recorded.'
        : operation === 'complete'
          ? 'The long-running goal is marked complete.'
          : operation === 'block'
            ? 'The long-running goal is blocked until the user acts.'
            : 'Recorded material progress for the long-running goal.';
      return {
        output: [{ type: 'text', text: label }],
        details: result.state,
      };
    },
  });

  return defineExtension({
    name: LONG_TASK_EXTENSION_NAME,
    sections: [
      durable.section('studio-long-task', async (input, context) => {
        const state = await input.read.snapshot(
          LongTask,
          input.conversationId,
          context,
        );
        return longTaskPrompt(state);
      }, { tag: false }),
    ],
    hooks: [
      durable.hook(durable.GenerationTask, {
        async onYield(_answer, api, context) {
          const state = normalizeLongTaskState(await api.snapshot(
            LongTask,
            api.conversationId,
            context,
          ));
          if (!state.enabled || !state.goal || state.status !== 'active') return undefined;
          return { continue: continuationText(state) };
        },
      }),
    ],
    tools: [longTask],
  });
}

async function readLongTaskState(durable, harness, conversationId, context) {
  const { LongTask } = createLongTaskContract(durable);
  return publicLongTaskState(await harness.snapshot(LongTask, conversationId, context));
}

module.exports = {
  LONG_TASK_CONTINUATION_PREFIX,
  LONG_TASK_DOC_KIND,
  LONG_TASK_EXTENSION_NAME,
  LONG_TASK_SCHEMA_VERSION,
  LONG_TASK_TOOL_NAME,
  MAX_LONG_TASK_CONTINUATIONS,
  MAX_LONG_TASK_STALLED_CONTINUATIONS,
  cleanText,
  continuationText,
  createLongTaskContract,
  createLongTaskExtension,
  emptyLongTaskState,
  initializeLongTaskState,
  isLongTaskContinuation,
  longTaskPrompt,
  nextLongTaskContinuationGuard,
  normalizeLongTaskState,
  publicLongTaskState,
  readLongTaskState,
};
