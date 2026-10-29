import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';

import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import {
  Harness,
  MemoryStorage,
  createRegistry,
} from '@earendil-works/pi-durable';
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
} from '@earendil-works/pi-ai';

const require = createRequire(import.meta.url);
const { createMetricsRuntime } = require('../../electron/services/metrics-runtime.cjs');

function flatten(value) {
  if (Array.isArray(value)) return value.flatMap(flatten);
  if (!value || typeof value !== 'object') return [value];
  return [value, ...Object.values(value).flatMap(flatten)];
}

test('collects live metrics through the official Pi AI and Durable telemetry path', async () => {
  const runtime = createMetricsRuntime();
  const faux = fauxProvider({
    provider: 'faux',
    models: [{ id: 'metrics-probe', name: 'Metrics probe' }],
  });
  faux.setResponses([() => fauxAssistantMessage('Telemetry complete.')]);
  const models = createModels();
  models.setProvider(faux.provider);
  const harness = await Harness.open(new MemoryStorage(), {
    models,
    registry: createRegistry(),
    telemetry: runtime.telemetry,
  }, BACKGROUND_CONTEXT);

  try {
    const conversation = await harness.root(BACKGROUND_CONTEXT, {
      agent: {
        model: { provider: 'faux', modelId: 'metrics-probe' },
      },
    });
    runtime.recordConversationEvent({
      type: 'run.started',
      conversationId: String(conversation.id),
    });
    const submission = await conversation.submit({
      type: 'input',
      content: 'This content must never become metrics.',
    }, BACKGROUND_CONTEXT);
    assert.equal((await submission.wait(BACKGROUND_CONTEXT)).status, 'done');
    runtime.recordConversationEvent({
      type: 'run.completed',
      conversationId: String(conversation.id),
    });

    const content = runtime.provider.read({ sessionId: String(conversation.id) });
    const values = flatten(content);
    const requestDuration = values.find((value) => value?.id === 'request-duration');
    const outputTokens = values.find((value) => value?.id === 'output-tokens');
    const tps = values.find((value) => value?.id === 'live-tps');
    assert.ok(requestDuration);
    assert.equal(typeof requestDuration.value, 'string');
    assert.match(requestDuration.value, /^\d+(?:\.\d+)?$/);
    assert.match(requestDuration.unit, /^(ms|s|m|h)$/);
    assert.ok(outputTokens);
    assert.equal(typeof outputTokens.value, 'string');
    assert.ok(tps);
    assert.equal(
      JSON.stringify(content).includes('This content must never become metrics.'),
      false,
    );
  } finally {
    await harness.close(BACKGROUND_CONTEXT);
    runtime.close();
  }
});
