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
  Type,
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from '@earendil-works/pi-ai';

const require = createRequire(import.meta.url);
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-studio-todo-loop-'));
process.env.PI_STUDIO_DB = path.join(temporary, 'studio.sqlite');

const { closeStudioDatabase } = require('../../electron/core/studio-db.cjs');
const { createStudioBuiltins } = require('../../electron/services/studio-builtins.cjs');

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
    piAi: { Type },
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
    assert.equal(firstResult.details.schemaVersion, 1);
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
    assert.deepEqual(
      listed.details.tasks.map((task) => task.subject),
      ['Inspect the problem', 'Implement and verify the fix'],
    );
  } finally {
    await harness.close(BACKGROUND_CONTEXT);
  }
});
