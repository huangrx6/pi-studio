import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  Harness,
  MemoryStorage,
  createRegistry,
} from '@earendil-works/pi-durable';
import { openNodeJsonlStorage } from '@earendil-works/pi-durable/storage/jsonl/node';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from '@earendil-works/pi-ai';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  clearLongTaskState,
  completeLongTaskState,
  continuationText,
  createLongTaskContract,
  createLongTaskExtension,
  editLongTaskState,
  initializeLongTaskState,
  LONG_TASK_CONTINUATION_PREFIX,
  longTaskPrompt,
  MAX_LONG_TASK_COMMAND_LENGTH,
  MAX_LONG_TASK_CONTINUATIONS,
  MAX_LONG_TASK_STALLED_CONTINUATIONS,
  nextLongTaskContinuationGuard,
  readLongTaskState,
  replaceLongTaskState,
  shouldStartLongTaskGoal,
  validateLongTaskGoal,
} = require('../../electron/services/studio-long-task.cjs');

test('goal commands replace, edit, complete, and clear Durable-owned state predictably', () => {
  const state = {
    enabled: true,
    goal: 'Old goal',
    completionCriteria: 'Old criteria',
    status: 'blocked',
    iteration: 7,
    lastProgress: 'Old progress',
    nextStep: 'Old next step',
    pauseReason: '',
    completionSummary: '',
    blockReason: 'Need input',
    lastMutationTaskId: 11,
    createdAt: 10,
    updatedAt: 20,
    completedAt: 0,
    blockedAt: 30,
  };

  editLongTaskState(state, {
    goal: 'Edited goal',
    completionCriteria: 'Edited criteria',
    previousStatus: 'blocked',
    now: 40,
  });
  assert.equal(state.status, 'active');
  assert.equal(state.iteration, 7);
  assert.equal(state.lastProgress, 'Old progress');
  assert.equal(state.blockReason, '');
  assert.equal(state.updatedAt, 40);

  replaceLongTaskState(state, {
    goal: 'Replacement goal',
    completionCriteria: 'Replacement criteria',
    now: 50,
  });
  assert.deepEqual(
    {
      goal: state.goal,
      completionCriteria: state.completionCriteria,
      status: state.status,
      iteration: state.iteration,
      lastProgress: state.lastProgress,
      createdAt: state.createdAt,
      updatedAt: state.updatedAt,
    },
    {
      goal: 'Replacement goal',
      completionCriteria: 'Replacement criteria',
      status: 'active',
      iteration: 0,
      lastProgress: '',
      createdAt: 50,
      updatedAt: 50,
    },
  );
  const prompt = longTaskPrompt(state);
  assert.match(prompt, /Replacement goal/);
  assert.doesNotMatch(prompt, /Old goal/);

  completeLongTaskState(state, { summary: 'Stopped by the user.', now: 60 });
  assert.equal(state.status, 'completed');
  assert.equal(state.completionSummary, 'Stopped by the user.');
  assert.equal(state.completedAt, 60);

  clearLongTaskState(state);
  assert.equal(state.enabled, false);
  assert.equal(state.goal, '');
  assert.equal(state.status, 'idle');
  assert.equal(state.iteration, 0);
});

test('goal commands enforce the documented 4,000-character objective limit', () => {
  assert.equal(validateLongTaskGoal('  ship it  '), 'ship it');
  assert.throws(() => validateLongTaskGoal('   '), /目标不能为空/);
  assert.throws(
    () => validateLongTaskGoal('x'.repeat(MAX_LONG_TASK_COMMAND_LENGTH + 1)),
    /不能超过 4000 个字符/,
  );
});

test('replacing a paused goal starts the new goal while editing keeps it paused', () => {
  assert.equal(shouldStartLongTaskGoal('replace', 'paused'), true);
  assert.equal(shouldStartLongTaskGoal('replace', 'completed'), true);
  assert.equal(shouldStartLongTaskGoal('edit', 'paused'), false);
  assert.equal(shouldStartLongTaskGoal('edit', 'active'), true);
  assert.equal(shouldStartLongTaskGoal('edit', 'blocked'), true);
});

test('the long-task continuation guard stops repeated no-progress loops and retains a hard limit', () => {
  let guard = {
    continuations: 0,
    stalledContinuations: 0,
    iteration: 4,
  };
  for (let index = 1; index < MAX_LONG_TASK_STALLED_CONTINUATIONS; index += 1) {
    const decision = nextLongTaskContinuationGuard({
      ...guard,
      lastIteration: 4,
    });
    assert.equal(decision.pauseReason, '');
    guard = {
      continuations: decision.continuations,
      stalledContinuations: decision.stalledContinuations,
      iteration: decision.iteration,
    };
  }
  const stalled = nextLongTaskContinuationGuard({
    ...guard,
    lastIteration: 4,
  });
  assert.match(stalled.pauseReason, /没有通过 long_task 记录实际进展/);

  const progressed = nextLongTaskContinuationGuard({
    continuations: 5,
    stalledContinuations: 2,
    iteration: 9,
    lastIteration: 8,
  });
  assert.equal(progressed.stalledContinuations, 0);

  const hardLimit = nextLongTaskContinuationGuard({
    continuations: MAX_LONG_TASK_CONTINUATIONS - 1,
    stalledContinuations: 0,
    iteration: 12,
    lastIteration: 11,
  });
  assert.match(hardLimit.pauseReason, /安全上限/);

  const customStalled = nextLongTaskContinuationGuard({
    continuations: 1,
    stalledContinuations: 1,
    iteration: 4,
    lastIteration: 4,
    maxStalledContinuations: 2,
  });
  assert.match(customStalled.pauseReason, /连续 2 轮/);

  const customHardLimit = nextLongTaskContinuationGuard({
    continuations: 3,
    stalledContinuations: 0,
    iteration: 8,
    lastIteration: 7,
    maxContinuations: 4,
  });
  assert.match(customHardLimit.pauseReason, /4 轮安全上限/);
});

test('an active long task continues across GenerationTask boundaries until it is completed', async () => {
  const durable = await import('@earendil-works/pi-durable');
  const extension = createLongTaskExtension(durable);
  const longTaskTool = extension.tools.find((tool) => tool.name === 'long_task');
  assert.ok(longTaskTool);
  const { LongTask } = createLongTaskContract(durable);

  const registry = createRegistry();
  registry.install(extension);
  const faux = fauxProvider({
    provider: 'faux',
    models: [{ id: 'faux-1', name: 'Long task probe' }],
  });
  faux.setResponses([
    () => fauxAssistantMessage('I completed the first implementation pass.'),
    () => fauxAssistantMessage(
      fauxToolCall('long_task', {
        action: 'complete',
        summary: 'Implemented the goal and verified all required tests.',
      }, { id: 'complete-long-task' }),
      { stopReason: 'toolUse' },
    ),
    () => fauxAssistantMessage('The verified goal is complete.'),
  ]);
  const models = createModels();
  models.setProvider(faux.provider);
  const harness = await Harness.open(
    new MemoryStorage(),
    { models, registry },
    BACKGROUND_CONTEXT,
  );
  try {
    const conversation = await harness.root(BACKGROUND_CONTEXT, {
      agent: {
        model: { provider: 'faux', modelId: 'faux-1' },
        extensions: [extension],
        tools: [longTaskTool],
      },
      init: async (tx, conversationId) => {
        initializeLongTaskState(await tx.doc(LongTask, conversationId), {
          goal: 'Build the requested feature.',
          completionCriteria: 'The feature is implemented and pnpm test passes.',
          status: 'active',
          now: 1,
        });
      },
    });
    const submission = await conversation.submit({
      type: 'input',
      content: 'Build the requested feature and verify it.',
    }, BACKGROUND_CONTEXT);
    const settled = await submission.wait(BACKGROUND_CONTEXT);
    assert.equal(settled.status, 'done');

    const page = await conversation.entries(
      { order: 'ascending' },
      100,
      undefined,
      BACKGROUND_CONTEXT,
    );
    const assistantEntries = page.items.filter((entry) => entry.kind === 'pi.assistant');
    assert.equal(assistantEntries.length, 3);
    const continuationEntries = page.items.filter((entry) => (
      entry.kind === 'pi.user'
      && entry.model?.some((message) => (
        typeof message.content === 'string'
        && message.content.startsWith(LONG_TASK_CONTINUATION_PREFIX)
      ))
    ));
    assert.equal(continuationEntries.length, 1);

    const state = await readLongTaskState(
      durable,
      harness,
      conversation.id,
      BACKGROUND_CONTEXT,
    );
    assert.equal(state.status, 'completed');
    assert.match(state.completionSummary, /verified all required tests/i);
  } finally {
    await harness.close(BACKGROUND_CONTEXT);
  }
});

test('a paused long task answers the current message without starting another goal iteration', async () => {
  const durable = await import('@earendil-works/pi-durable');
  const extension = createLongTaskExtension(durable);
  const longTaskTool = extension.tools.find((tool) => tool.name === 'long_task');
  const { LongTask } = createLongTaskContract(durable);
  const registry = createRegistry();
  registry.install(extension);
  const faux = fauxProvider({
    provider: 'faux',
    models: [{ id: 'faux-1', name: 'Paused long task probe' }],
  });
  faux.setResponses([() => fauxAssistantMessage('I answered the current message.')]);
  const models = createModels();
  models.setProvider(faux.provider);
  const harness = await Harness.open(
    new MemoryStorage(),
    { models, registry },
    BACKGROUND_CONTEXT,
  );
  try {
    const conversation = await harness.root(BACKGROUND_CONTEXT, {
      agent: {
        model: { provider: 'faux', modelId: 'faux-1' },
        extensions: [extension],
        tools: [longTaskTool],
      },
      init: async (tx, conversationId) => {
        initializeLongTaskState(await tx.doc(LongTask, conversationId), {
          goal: 'A paused goal.',
          completionCriteria: 'The user resumes the goal.',
          status: 'paused',
          now: 1,
        });
      },
    });
    const submission = await conversation.submit({
      type: 'input',
      content: 'Answer this one message only.',
    }, BACKGROUND_CONTEXT);
    assert.equal((await submission.wait(BACKGROUND_CONTEXT)).status, 'done');
    const page = await conversation.entries(
      { order: 'ascending' },
      100,
      undefined,
      BACKGROUND_CONTEXT,
    );
    assert.equal(
      page.items.filter((entry) => entry.kind === 'pi.assistant').length,
      1,
    );
    assert.equal(
      page.items.filter((entry) => (
        entry.kind === 'pi.user'
        && entry.model?.some((message) => (
          typeof message.content === 'string'
          && message.content.startsWith(LONG_TASK_CONTINUATION_PREFIX)
        ))
      )).length,
      0,
    );
    const state = await readLongTaskState(
      durable,
      harness,
      conversation.id,
      BACKGROUND_CONTEXT,
    );
    assert.equal(state.status, 'paused');
  } finally {
    await harness.close(BACKGROUND_CONTEXT);
  }
});

test('replacing a running goal stops the old continuation and starts only the new goal', async () => {
  const durable = await import('@earendil-works/pi-durable');
  const extension = createLongTaskExtension(durable);
  const longTaskTool = extension.tools.find((tool) => tool.name === 'long_task');
  assert.ok(longTaskTool);
  const { LongTask } = createLongTaskContract(durable);
  const registry = createRegistry();
  registry.install(extension);
  const faux = fauxProvider({
    provider: 'faux',
    models: [{ id: 'faux-1', name: 'Goal replacement probe' }],
  });
  let firstRequestStarted;
  const firstRequest = new Promise((resolve) => {
    firstRequestStarted = resolve;
  });
  let replacementRequestContext;
  faux.setResponses([
    async (_context, options) => {
      firstRequestStarted();
      await new Promise((resolve) => {
        if (options.signal.aborted) {
          resolve();
          return;
        }
        options.signal.addEventListener('abort', resolve, { once: true });
      });
      return fauxAssistantMessage('The superseded goal stopped.');
    },
    (context) => {
      replacementRequestContext = context;
      return fauxAssistantMessage(
        fauxToolCall('long_task', {
          action: 'complete',
          summary: 'The replacement goal completed.',
        }, { id: 'complete-replacement-goal' }),
        { stopReason: 'toolUse' },
      );
    },
    () => fauxAssistantMessage('Replacement goal complete.'),
  ]);
  const models = createModels();
  models.setProvider(faux.provider);
  const harness = await Harness.open(
    new MemoryStorage(),
    { models, registry },
    BACKGROUND_CONTEXT,
  );
  try {
    const conversation = await harness.root(BACKGROUND_CONTEXT, {
      agent: {
        model: { provider: 'faux', modelId: 'faux-1' },
        extensions: [extension],
        tools: [longTaskTool],
      },
      init: async (tx, conversationId) => {
        initializeLongTaskState(await tx.doc(LongTask, conversationId), {
          goal: 'OLD GOAL: migrate the legacy pipeline.',
          completionCriteria: 'The legacy pipeline is gone.',
          status: 'active',
          now: 1,
        });
      },
    });
    const oldSubmission = await conversation.submit({
      type: 'input',
      content: 'Begin the old goal.',
    }, BACKGROUND_CONTEXT);
    await firstRequest;

    // Match the service transaction order: make the old goal unable to yield a
    // continuation before aborting the provider request.
    await conversation.commit(async (tx) => {
      const state = await tx.doc(LongTask, conversation.id);
      state.status = 'paused';
      state.pauseReason = 'Switching goals.';
      state.updatedAt = 2;
    }, BACKGROUND_CONTEXT);
    await conversation.abort(BACKGROUND_CONTEXT, { background: true });
    await oldSubmission.wait(BACKGROUND_CONTEXT);

    const replacement = await conversation.commit(async (tx) => {
      const stored = await tx.doc(LongTask, conversation.id);
      const next = replaceLongTaskState(stored, {
        goal: 'NEW GOAL: ship the replacement.',
        completionCriteria: 'The replacement is verified.',
        now: 3,
      });
      return { ...next };
    }, BACKGROUND_CONTEXT);
    const replacementSubmission = await conversation.submit({
      type: 'input',
      content: continuationText(replacement),
      whenBusy: 'followUp',
    }, BACKGROUND_CONTEXT);
    assert.equal(
      (await replacementSubmission.wait(BACKGROUND_CONTEXT)).status,
      'done',
    );

    const page = await conversation.entries(
      { order: 'ascending' },
      100,
      undefined,
      BACKGROUND_CONTEXT,
    );
    const continuationEntries = page.items.filter((entry) => (
      entry.kind === 'pi.user'
      && entry.model?.some((message) => (
        typeof message.content === 'string'
        && message.content.startsWith(LONG_TASK_CONTINUATION_PREFIX)
      ))
    ));
    assert.equal(continuationEntries.length, 1);
    assert.match(
      continuationEntries[0].model
        .map((message) => typeof message.content === 'string' ? message.content : '')
        .join('\n'),
      /NEW GOAL: ship the replacement/,
    );
    assert.match(
      replacementRequestContext.messages
        .map((message) => typeof message.content === 'string' ? message.content : '')
        .join('\n'),
      /NEW GOAL: ship the replacement/,
    );
    const state = await readLongTaskState(
      durable,
      harness,
      conversation.id,
      BACKGROUND_CONTEXT,
    );
    assert.equal(state.status, 'completed');
    assert.equal(state.goal, 'NEW GOAL: ship the replacement.');
  } finally {
    await harness.close(BACKGROUND_CONTEXT);
  }
});

test('a blocked long task waits for the user without starting another goal iteration', async () => {
  const durable = await import('@earendil-works/pi-durable');
  const extension = createLongTaskExtension(durable);
  const longTaskTool = extension.tools.find((tool) => tool.name === 'long_task');
  assert.ok(longTaskTool);
  const { LongTask } = createLongTaskContract(durable);
  const registry = createRegistry();
  registry.install(extension);
  const faux = fauxProvider({
    provider: 'faux',
    models: [{ id: 'faux-1', name: 'Blocked long task probe' }],
  });
  faux.setResponses([
    () => fauxAssistantMessage(
      fauxToolCall('long_task', {
        action: 'block',
        reason: 'The user must provide a deployment token.',
      }, { id: 'block-long-task' }),
      { stopReason: 'toolUse' },
    ),
    () => fauxAssistantMessage('I need the deployment token before continuing.'),
  ]);
  const models = createModels();
  models.setProvider(faux.provider);
  const harness = await Harness.open(
    new MemoryStorage(),
    { models, registry },
    BACKGROUND_CONTEXT,
  );
  try {
    const conversation = await harness.root(BACKGROUND_CONTEXT, {
      agent: {
        model: { provider: 'faux', modelId: 'faux-1' },
        extensions: [extension],
        tools: [longTaskTool],
      },
      init: async (tx, conversationId) => {
        initializeLongTaskState(await tx.doc(LongTask, conversationId), {
          goal: 'Deploy the application.',
          completionCriteria: 'The deployment is live and verified.',
          status: 'active',
          now: 1,
        });
      },
    });
    const submission = await conversation.submit({
      type: 'input',
      content: 'Deploy the application.',
    }, BACKGROUND_CONTEXT);
    assert.equal((await submission.wait(BACKGROUND_CONTEXT)).status, 'done');
    const page = await conversation.entries(
      { order: 'ascending' },
      100,
      undefined,
      BACKGROUND_CONTEXT,
    );
    assert.equal(
      page.items.filter((entry) => entry.kind === 'pi.assistant').length,
      2,
    );
    assert.equal(
      page.items.filter((entry) => (
        entry.kind === 'pi.user'
        && entry.model?.some((message) => (
          typeof message.content === 'string'
          && message.content.startsWith(LONG_TASK_CONTINUATION_PREFIX)
        ))
      )).length,
      0,
    );
    const state = await readLongTaskState(
      durable,
      harness,
      conversation.id,
      BACKGROUND_CONTEXT,
    );
    assert.equal(state.status, 'blocked');
    assert.match(state.blockReason, /deployment token/i);
  } finally {
    await harness.close(BACKGROUND_CONTEXT);
  }
});

test('long-task state survives a Durable storage reopen', async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-studio-long-task-'));
  const durable = await import('@earendil-works/pi-durable');
  const extension = createLongTaskExtension(durable);
  const longTaskTool = extension.tools.find((tool) => tool.name === 'long_task');
  assert.ok(longTaskTool);
  const { LongTask } = createLongTaskContract(durable);
  const registry = createRegistry();
  registry.install(extension);
  const faux = fauxProvider({
    provider: 'faux',
    models: [{ id: 'faux-1', name: 'Reopen probe' }],
  });
  const models = createModels();
  models.setProvider(faux.provider);
  const options = { models, registry };
  const agent = {
    model: { provider: 'faux', modelId: 'faux-1' },
    extensions: [extension],
    tools: [longTaskTool],
  };
  const storageDirectory = path.join(temporary, 'storage');
  let harness;
  try {
    let storage = await openNodeJsonlStorage(storageDirectory, BACKGROUND_CONTEXT);
    harness = await Harness.open(storage, options, BACKGROUND_CONTEXT);
    const conversation = await harness.root(BACKGROUND_CONTEXT, {
      agent,
      init: async (tx, conversationId) => {
        initializeLongTaskState(await tx.doc(LongTask, conversationId), {
          goal: 'Persist the goal.',
          completionCriteria: 'The goal is readable after reopen.',
          status: 'paused',
          now: 1,
        });
      },
    });
    await harness.close(BACKGROUND_CONTEXT);

    storage = await openNodeJsonlStorage(storageDirectory, BACKGROUND_CONTEXT);
    harness = await Harness.open(storage, options, BACKGROUND_CONTEXT);
    const reopened = await harness.root(BACKGROUND_CONTEXT, { agent });
    const state = await readLongTaskState(
      durable,
      harness,
      reopened.id,
      BACKGROUND_CONTEXT,
    );
    assert.equal(state.goal, 'Persist the goal.');
    assert.equal(state.status, 'paused');
  } finally {
    await harness?.close(BACKGROUND_CONTEXT).catch(() => {});
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});
