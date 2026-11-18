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
const { createMetricsRuntime } = require('../../electron/main/capabilities/metrics/index.cjs');

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

test('Durable partial views publish changing metrics before the first text block finishes', async () => {
  const view = require('../../electron/main/runtime/view.cjs');
  const runtime = createMetricsRuntime();
  const faux = fauxProvider({ provider: 'faux-stream', models: [{ id: 'slow' }], tokensPerSecond: 60, tokenSize: { min: 3, max: 3 } });
  faux.setResponses([() => fauxAssistantMessage('A streamed response with enough chunks to measure progress before the text block has ended. '.repeat(3))]);
  const models = createModels(); models.setProvider(faux.provider);
  const harness = await Harness.open(new MemoryStorage(), { models, registry: createRegistry(), telemetry: runtime.telemetry, settings: { progress: { partialIntervalMs: 20 } } }, BACKGROUND_CONTEXT);
  let watch;
  try {
    const conversation = await harness.root(BACKGROUND_CONTEXT, { agent: { model: { provider: 'faux-stream', modelId: 'slow' } } });
    const id = String(conversation.id);
    const frames = [];
    runtime.recordConversationEvent({ type: 'run.started', conversationId: id });
    watch = await conversation.watch(BACKGROUND_CONTEXT);
    watch.start(async call => {
      if (call.kind !== 'value') return;
      const live = view.liveFromView(call.value);
      const sample = view.streamingMetricSample(live.generation?.message);
      if (!sample) return;
      runtime.recordStreamProgress(id, sample);
      const request = runtime.sessions.get(id)?.currentRequest;
      if (request && !request.completed && request.outputChars === 0) {
        const metric = flatten(runtime.provider.read({ sessionId: id })).find(value => value?.id === 'output-tokens');
        frames.push(Number(metric.value));
      }
    });
    const submission = await conversation.submit({ type: 'input', content: 'synthetic request' }, BACKGROUND_CONTEXT);
    assert.equal((await submission.wait(BACKGROUND_CONTEXT)).status, 'done');
    assert.ok(new Set(frames.filter(value => value > 0)).size >= 3, `expected several progress values before text_end; got ${frames}`);
  } finally { await watch?.stop(); await harness.close(BACKGROUND_CONTEXT); runtime.close(); }
});
