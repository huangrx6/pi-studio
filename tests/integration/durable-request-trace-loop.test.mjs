import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';

import {
  Harness,
  MemoryStorage,
  createRegistry,
  defineExtension,
} from '@earendil-works/pi-durable';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import {
  Type,
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from '@earendil-works/pi-ai';

const require = createRequire(import.meta.url);
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-studio-request-trace-'));
process.env.PI_STUDIO_DB = path.join(temporary, 'studio.sqlite');

const { closeStudioDatabase } = require('../../electron/core/studio-db.cjs');
const {
  createStudioRequestTraceExtension,
  onRequestTrace,
} = require('../../electron/services/studio-request-trace.cjs');

test.after(() => {
  closeStudioDatabase();
  fs.rmSync(temporary, { recursive: true, force: true });
});

test('Durable beforeRequest traces the exact system prompt, user input, tool round, and tool definitions', async () => {
  const durable = await import('@earendil-works/pi-durable');
  const requestTrace = createStudioRequestTraceExtension(durable);
  const probeTool = {
    name: 'probe',
    description: 'Return one deterministic probe result.',
    parameters: Type.Object({}),
    async execute() {
      return { output: [{ type: 'text', text: 'probe result' }] };
    },
  };
  const probeExtension = defineExtension({
    name: 'probe-tools',
    tools: [probeTool],
  });

  const faux = fauxProvider({
    provider: 'faux',
    models: [{ id: 'faux-trace', name: 'Trace probe', reasoning: true }],
  });
  faux.setResponses([
    () => fauxAssistantMessage(
      fauxToolCall('probe', {}, { id: 'probe-call' }),
      { stopReason: 'toolUse' },
    ),
    () => fauxAssistantMessage('trace complete'),
  ]);

  const registry = createRegistry();
  registry.install(requestTrace);
  registry.install(probeExtension);
  const models = createModels();
  models.setProvider(faux.provider);
  const traces = [];
  const unsubscribe = onRequestTrace((trace) => traces.push(trace));

  const harness = await Harness.open(
    new MemoryStorage(),
    { models, registry },
    BACKGROUND_CONTEXT,
  );
  try {
    const conversation = await harness.root(BACKGROUND_CONTEXT, {
      agent: {
        model: { provider: 'faux', modelId: 'faux-trace' },
        thinkingLevel: 'high',
        extensions: [requestTrace, probeExtension],
        tools: [probeTool],
        instructions: 'STUDIO_TRACE_SYSTEM_MARKER',
      },
    });
    const submission = await conversation.submit({
      type: 'input',
      content: 'STUDIO_TRACE_USER_MARKER',
    }, BACKGROUND_CONTEXT);
    assert.equal((await submission.wait(BACKGROUND_CONTEXT)).status, 'done');

    assert.equal(traces.length, 2);
    const first = traces[0];
    assert.equal(first.model.provider, 'faux');
    assert.equal(first.model.modelId, 'faux-trace');
    assert.equal(first.thinkingLevel, 'high');
    assert.equal(first.attempt, 1);
    assert.deepEqual(first.messages.map((message) => message.role), ['system', 'user']);
    assert.match(
      first.messages[0].content.map((block) => block.text || '').join('\n'),
      /STUDIO_TRACE_SYSTEM_MARKER/,
    );
    assert.match(
      first.messages[1].content.map((block) => block.text || '').join('\n'),
      /STUDIO_TRACE_USER_MARKER/,
    );
    assert.deepEqual(first.tools.map((tool) => tool.name), ['probe']);
    assert.match(first.tools[0].description, /deterministic probe/);

    const second = traces[1];
    assert.notEqual(second.requestId, first.requestId);
    assert.ok(second.messages.some((message) => (
      message.role === 'toolResult'
      && message.content.some((block) => block.type === 'text' && /probe result/.test(block.text))
    )));
  } finally {
    unsubscribe();
    await harness.close(BACKGROUND_CONTEXT);
  }
});
