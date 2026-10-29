import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

import {
  Harness,
  MemoryStorage,
  ToolResultEntry,
  createRegistry,
  defineExtension,
} from '@earendil-works/pi-durable';
import { createToolSearchExtension } from '@earendil-works/pi-durable/tool-search';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import {
  Type,
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from '@earendil-works/pi-ai';

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-studio-subagent-loop-'));
process.env.PI_STUDIO_USER_DATA = path.join(temporary, 'user-data');
process.env.PI_STUDIO_DB = path.join(temporary, 'studio.sqlite');

const require = createRequire(import.meta.url);
const {
  closeStudioDatabase,
} = require('../../electron/core/studio-db.cjs');
const {
  setSubagentConfig,
} = require('../../electron/core/app-settings.cjs');
const {
  createStudioBuiltins,
} = require('../../electron/services/studio-builtins.cjs');

after(() => {
  closeStudioDatabase();
  fs.rmSync(temporary, { recursive: true, force: true });
});

test('a foreground subagent returns its child answer through the real Durable tool API', async () => {
  setSubagentConfig('user', '', {
    defaultModel: '',
    defaultThinking: '',
    maxThinking: '',
    defaultMode: 'foreground',
    backgroundEnabled: true,
    supervisorEnabled: false,
    allowedTools: [],
  });

  const faux = fauxProvider({
    provider: 'faux',
    models: [{ id: 'faux-1', name: 'Subagent probe' }],
  });
  faux.setResponses([
    () => fauxAssistantMessage(
      fauxToolCall('subagent', {
        action: 'run',
        task: 'Answer with the verified child result.',
      }, { id: 'call-subagent' }),
      { stopReason: 'toolUse' },
    ),
    () => fauxAssistantMessage('child result'),
    () => fauxAssistantMessage('parent received the child result'),
  ]);

  const durable = await import('@earendil-works/pi-durable');
  const builtins = createStudioBuiltins({
    durable,
    piAi: { Type },
    codingTools: defineExtension({ name: 'coding-tools', tools: [] }),
    toolSearch: createToolSearchExtension(),
    chordContext: BACKGROUND_CONTEXT,
  });
  const subagents = builtins.get('builtin:studio-subagents');
  const subagentTool = subagents.tools.find((tool) => tool.name === 'subagent');
  assert.ok(subagentTool);

  const registry = createRegistry();
  registry.install(subagents);
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
        extensions: [subagents],
        tools: [subagentTool],
      },
    });
    const submission = await conversation.submit({
      type: 'input',
      content: 'Run the subagent and report its result.',
    }, BACKGROUND_CONTEXT);
    const settled = await submission.wait(BACKGROUND_CONTEXT);
    assert.equal(settled.status, 'done');

    const page = await conversation.entries(
      { order: 'ascending' },
      100,
      undefined,
      BACKGROUND_CONTEXT,
    );
    const result = page.items
      .filter((entry) => entry.kind === ToolResultEntry.kind)
      .flatMap((entry) => entry.model || [])
      .find((message) => message.role === 'toolResult' && message.toolName === 'subagent');
    assert.ok(result);
    assert.notEqual(result.isError, true);
    assert.equal(result.content[0]?.type, 'text');
    assert.equal(result.content[0]?.text, 'child result');
  } finally {
    await harness.close(BACKGROUND_CONTEXT);
  }
});
