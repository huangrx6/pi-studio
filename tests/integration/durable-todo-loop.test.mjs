import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import {
  Harness,
  ToolResultEntry,
  createRegistry,
  defineExtension,
} from '@earendil-works/pi-durable';
import { createToolSearchExtension } from '@earendil-works/pi-durable/tool-search';
import { openNodeJsonlStorage } from '@earendil-works/pi-durable/storage/jsonl/node';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from '@earendil-works/pi-ai';
import toolSchema from '../../electron/runtime/tool-schema.cjs';

const require = createRequire(import.meta.url);
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-studio-todo-loop-'));
process.env.PI_STUDIO_DB = path.join(temporary, 'studio.sqlite');

const { closeStudioDatabase } = require('../../electron/core/studio-db.cjs');
const { readTodoDetails, readTodoHistory } = require('../../electron/capabilities/todo/index.cjs');
const { createStudioBuiltins } = require('../../electron/runtime/builtin-registry.cjs');

after(() => {
  closeStudioDatabase();
  fs.rmSync(temporary, { recursive: true, force: true });
});

function toolResult(page, name) {
  return page.items
    .filter((entry) => entry.kind === ToolResultEntry.kind)
    .flatMap((entry) => entry.model || [])
    .find((message) => message.role === 'toolResult' && message.toolName === name);
}

test('the todo tool result reaches the UI contract and its Durable document survives reopen', async () => {
  const durable = await import('@earendil-works/pi-durable');
  const builtins = createStudioBuiltins({
    durable,
    piAi: { Type: toolSchema },
    codingTools: defineExtension({ name: 'coding-tools', tools: [] }),
    toolSearch: createToolSearchExtension(),
    chordContext: BACKGROUND_CONTEXT,
  });
  const todoExtension = builtins.get('builtin:studio-todo');
  const todoTool = todoExtension.tools.find((tool) => tool.name === 'todo');
  assert.ok(todoTool);

  const registry = createRegistry();
  registry.install(todoExtension);
  const storageDirectory = path.join(temporary, 'durable-storage');
  let storage = await openNodeJsonlStorage(storageDirectory, BACKGROUND_CONTEXT);
  const faux = fauxProvider({
    provider: 'faux',
    models: [{ id: 'faux-1', name: 'Todo probe' }],
  });
  const models = createModels();
  models.setProvider(faux.provider);
  const options = {
    models,
    registry,
  };
  const agent = {
    model: { provider: 'faux', modelId: 'faux-1' },
    cwd: temporary,
    extensions: [todoExtension],
    tools: [todoTool],
  };

  let harness = await Harness.open(storage, options, BACKGROUND_CONTEXT);
  try {
    const conversation = await harness.root(BACKGROUND_CONTEXT, { agent });
    assert.deepEqual(
      (await conversation.agent(BACKGROUND_CONTEXT)).tools.map((tool) => tool.name),
      ['todo'],
    );
    faux.setResponses([
      () => fauxAssistantMessage(
        fauxToolCall('todo', {
          action: 'createMany',
          items: [
            { subject: 'Inspect the problem' },
            { subject: 'Implement and verify the fix' },
          ],
        }, { id: 'create-plan' }),
        { stopReason: 'toolUse' },
      ),
      () => fauxAssistantMessage('I created the task plan.'),
    ]);

    const submission = await conversation.submit({
      type: 'input',
      content: 'Plan this multi-step change.',
    }, BACKGROUND_CONTEXT);
    assert.equal((await submission.wait(BACKGROUND_CONTEXT)).status, 'done');

    const firstPage = await conversation.entries(
      { order: 'ascending' },
      100,
      undefined,
      BACKGROUND_CONTEXT,
    );
    const firstResult = toolResult(firstPage, 'todo');
    assert.ok(firstResult);
    assert.equal(
      firstResult.isError,
      false,
      firstResult.content.map((block) => block.text || '').join('\n'),
    );
    assert.equal(firstResult.details.schemaVersion, 2);
    assert.equal(firstResult.details.tasks.length, 2);
    assert.equal(firstResult.details.nextId, 3);
  } finally {
    await harness.close(BACKGROUND_CONTEXT);
  }

  storage = await openNodeJsonlStorage(storageDirectory, BACKGROUND_CONTEXT);
  faux.setResponses([
    () => fauxAssistantMessage(
      fauxToolCall('todo', { action: 'list' }, { id: 'list-plan' }),
      { stopReason: 'toolUse' },
    ),
    () => fauxAssistantMessage('The plan is still available.'),
  ]);
  harness = await Harness.open(storage, options, BACKGROUND_CONTEXT);
  try {
    const reopened = await harness.root(BACKGROUND_CONTEXT, { agent });
    const submission = await reopened.submit({
      type: 'input',
      content: 'Show the current plan.',
    }, BACKGROUND_CONTEXT);
    assert.equal((await submission.wait(BACKGROUND_CONTEXT)).status, 'done');
    const page = await reopened.entries(
      { order: 'descending' },
      100,
      undefined,
      BACKGROUND_CONTEXT,
    );
    const listed = toolResult(page, 'todo');
    assert.ok(listed);
    assert.equal(
      listed.isError,
      false,
      listed.content.map((block) => block.text || '').join('\n'),
    );
    assert.deepEqual(listed.details.tasks, []);
    assert.equal(await readTodoDetails(durable, harness, reopened.id, BACKGROUND_CONTEXT), undefined);
    const history = await readTodoHistory(durable, harness, reopened.id, {}, BACKGROUND_CONTEXT);
    assert.equal(history.items.length, 1);
    assert.equal(history.items[0].scope, 'turn');
    assert.deepEqual(
      history.items[0].tasks.map((task) => task.subject),
      ['Inspect the problem', 'Implement and verify the fix'],
    );
  } finally {
    await harness.close(BACKGROUND_CONTEXT);
  }
});

test('old tasks and more than 100 new tasks remain pageable across runs, Goal resumes and a storage reopen', async () => {
  const durable = await import('@earendil-works/pi-durable');
  const { createStudioTodoExtension } = require('../../electron/capabilities/todo/index.cjs');
  const { createLongTaskContract, replaceLongTaskState, editLongTaskState } = require('../../electron/capabilities/long-task/index.cjs');
  const todo = createStudioTodoExtension(durable);
  const { LongTask } = createLongTaskContract(durable);
  const context = BACKGROUND_CONTEXT;
  const registry = createRegistry();
  registry.install(todo);
  const faux = fauxProvider({ provider: 'faux', models: [{ id: 'faux-1', name: 'Checklist history' }] });
  const models = createModels();
  models.setProvider(faux.provider);
  const agent = { model: { provider: 'faux', modelId: 'faux-1' }, extensions: [todo], tools: todo.tools };
  const directory = path.join(temporary, 'history');
  const open = async () => Harness.open(await openNodeJsonlStorage(directory, context), { models, registry }, context);
  let harness = await open();
  let conversation;
  let request = 0;
  const history = options => readTodoHistory(durable, harness, conversation.id, options, context);
  const current = () => readTodoDetails(durable, harness, conversation.id, context);

  async function run(actions, entry) {
    const responses = actions.map((args, index) => () => fauxAssistantMessage(
      fauxToolCall('todo', args, { id: `todo-${request}-${index}` }), { stopReason: 'toolUse' },
    ));
    faux.setResponses([...responses, () => fauxAssistantMessage('Done.')]);
    const submission = await conversation.submit({ type: 'input', content: `Run ${++request}`, ...(entry && { entry }) }, context);
    assert.equal((await submission.wait(context)).status, 'done');
    const page = await conversation.entries({ order: 'descending' }, 2 * actions.length + 1, undefined, context);
    const results = page.items.filter(record => record.kind === ToolResultEntry.kind).map(record => record.model[0]).reverse();
    assert.equal(results.length, actions.length);
    for (const result of results) assert.equal(result.isError, false, JSON.stringify(result.content));
    return { id: String(submission.id), results: results.map(result => result.details) };
  }

  try {
    const legacyDoc = durable.defineDoc({
      kind: 'studio.todo', version: 1, scope: 'conversation', history: 'rewindable', fork: 'asOf',
      checkpointWhen: () => false, initial: () => ({ tasks: [], nextId: 1 }),
    });
    conversation = await harness.root(context, { agent });
    await conversation.commit(async tx => {
      const doc = await tx.doc(legacyDoc, conversation.id);
      doc.tasks = [{ id: 17, subject: 'Old record', status: 'completed' }];
      doc.nextId = 18;
    }, context);
    await harness.close(context);
    harness = await open();
    conversation = await harness.root(context, { agent });
    assert.equal(await current(), undefined);
    assert.deepEqual((await history({})).items.map(plan => [plan.title, plan.scope, plan.tasks[0].id]), [['早期会话任务', 'legacy', 17]]);

    assert.equal((await history({})).items[0].lifecycle, 'unknown');
    const items = prefix => Array.from({ length: 50 }, (_, i) => ({ subject: `${prefix} ${i}` }));
    const first = await run([{ action: 'createMany', items: items('A') }, { action: 'complete', id: 18 }]);
    const forkPoint = (await conversation.entries({ order: 'descending' }, 1, undefined, context)).items[0].id;
    const second = await run([{ action: 'list' }, { action: 'createMany', items: items('B') }]);
    assert.equal(first.results[0].turnId, first.id);
    assert.equal(first.results[1].tasks[0].status, 'completed');
    assert.deepEqual(second.results[0].tasks, []);
    assert.equal(second.results[1].turnId, second.id);
    assert.equal(second.results[1].tasks[0].id, 68);
    const fork = await conversation.fork(forkPoint, { agent, ownership: { kind: 'ownerless' } }, context);
    const forkHistory = await readTodoHistory(durable, harness, fork.id, {}, context);
    assert.deepEqual(forkHistory.items.map(plan => plan.planId), [2, 1]);
    assert.equal((await history({})).items.find(plan => plan.planId === 2).lifecycle, 'ended');
    assert.equal(forkHistory.items[0].conversationId, String(fork.id));
    assert.equal(await current(), undefined);

    const setGoal = () => conversation.commit(async tx => replaceLongTaskState(await tx.doc(LongTask, conversation.id), {
      goal: 'Same goal title', now: 200,
    }), context);
    const goal = await setGoal();
    const { id: goalTurn, results: [, goalChecklist] } = await run([
      { scope: 'goal', action: 'list' },
      { action: 'create', subject: 'Goal task' },
    ]);
    assert.equal(goalChecklist.scope, 'goal');
    await conversation.commit(async tx => { (await tx.doc(LongTask, conversation.id)).status = 'paused'; }, context);
    assert.equal((await history({})).items[0].lifecycle, 'open');
    await conversation.commit(async tx => { (await tx.doc(LongTask, conversation.id)).status = 'active'; }, context);
    const separate = await run([{ action: 'create', subject: 'Unrelated request' }]);
    assert.equal(separate.results[0].scope, 'turn');
    assert.equal(separate.results[0].goalId, undefined);
    await conversation.commit(async tx => editLongTaskState(await tx.doc(LongTask, conversation.id), { goal: 'Edited goal' }), context);
    const resume = await run([{ action: 'complete', id: 118 }], { kind: 'studio.user', data: { studioGoalId: goal.goalId } });
    assert.equal(resume.results[0].planId, goalChecklist.planId);
    assert.equal(resume.results[0].turnId, goalTurn);
    assert.equal(resume.results[0].goalId, goal.goalId);
    assert.equal(resume.results[0].lastTurnId, resume.id);
    assert.equal(resume.results[0].tasks[0].status, 'completed');
    assert.equal((await current()).planId, goalChecklist.planId);

    const firstPage = await history({ limit: 2 });
    assert.deepEqual(firstPage.items.map(plan => plan.scope), ['turn', 'goal']);
    assert.deepEqual(firstPage.items.map(plan => plan.lifecycle), ['ended', 'open']);
    const replacement = await setGoal();
    assert.notEqual(replacement.goalId, goal.goalId);
    assert.equal((await history({})).items.find(plan => plan.goalId === goal.goalId).lifecycle, 'ended');
    assert.equal(await current(), undefined);
    const replaced = await run([{ action: 'create', scope: 'goal', subject: 'Replacement task' }, { action: 'clear', scope: 'goal' }]);
    assert.notEqual(replaced.results[0].planId, goalChecklist.planId);
    assert.deepEqual(replaced.results[1].tasks, []);
    assert.equal(await current(), undefined);

    await harness.close(context);
    harness = await open();
    conversation = await harness.root(context, { agent });
    const secondPage = await history({ limit: 2, cursor: firstPage.nextCursor });
    const lastPage = await history({ limit: 2, cursor: secondPage.nextCursor });
    assert.equal(lastPage.nextCursor, null);
    const plans = [...firstPage.items, ...secondPage.items, ...lastPage.items];
    assert.deepEqual(plans.map(plan => plan.planId), [5, 4, 3, 2, 1]);
    assert.equal(plans.flatMap(plan => plan.tasks).length, 103);
    const detached = (await history({ limit: 1 })).items[0];
    assert.equal(detached.tasks[0].subject, 'Replacement task');
    assert.equal(detached.tasks[0].status, 'pending');
    assert.equal(detached.lifecycle, 'ended');
    assert.deepEqual(lastPage.items[0].tasks, [{ id: 17, subject: 'Old record', status: 'completed' }]);
    const other = await harness.createConversation({ agent, ownership: { kind: 'ownerless' } }, context);
    assert.deepEqual(await readTodoHistory(durable, harness, other.id, {}, context), { items: [], nextCursor: null });
  } finally {
    await harness.close(context);
  }
});
