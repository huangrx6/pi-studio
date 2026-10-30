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
  Type,
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from '@earendil-works/pi-ai';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  createLongTaskContract,
  createLongTaskExtension,
  initializeLongTaskState,
  LONG_TASK_CONTINUATION_PREFIX,
  MAX_LONG_TASK_CONTINUATIONS,
  MAX_LONG_TASK_STALLED_CONTINUATIONS,
  nextLongTaskContinuationGuard,
  readLongTaskState,
} = require('../../electron/services/studio-long-task.cjs');

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
});

test('an active long task continues across GenerationTask boundaries until it is completed', async () => {
  const durable = await import('@earendil-works/pi-durable');
  const extension = createLongTaskExtension(durable, { Type });
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
  const extension = createLongTaskExtension(durable, { Type });
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

test('a blocked long task waits for the user without starting another goal iteration', async () => {
  const durable = await import('@earendil-works/pi-durable');
  const extension = createLongTaskExtension(durable, { Type });
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
  const extension = createLongTaskExtension(durable, { Type });
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
