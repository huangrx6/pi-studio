const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

const { createStudioDatabase } = require('../../electron/core/studio-db.cjs');
const {
  MAX_ACTIVE_SPANS,
  MAX_RECENT_RUNS,
  MAX_SESSIONS,
  MAX_TPS_SAMPLES,
  METRICS_FOOTER_SOURCE_ID,
  METRICS_SOURCE_ID,
  compactFooterDuration,
  createMetricsRuntime,
} = require('../../electron/services/metrics-runtime.cjs');

function flatten(value) {
  if (Array.isArray(value)) return value.flatMap(flatten);
  if (!value || typeof value !== 'object') return [value];
  return [value, ...Object.values(value).flatMap(flatten)];
}

function metric(content, id) {
  return flatten(content).find((value) => value?.id === id && value?.label);
}

async function waitFor(predicate, timeoutMs = 500) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.ok(predicate(), 'condition was not met before timeout');
}

test('uses content-free Pi telemetry and preserves the completed run', async () => {
  const runtime = createMetricsRuntime();
  const events = [];
  const unsubscribe = runtime.provider.subscribe({
    sourceId: METRICS_SOURCE_ID,
    sessionId: '7',
  }, (content) => events.push(content));

  runtime.recordConversationEvent({ type: 'run.started', conversationId: '7' });
  await runtime.telemetry.startSpan({
    name: 'pi.durable.submit',
    attributes: {
      'conversation.id': 7,
      'submission.type': 'input',
    },
  }, async (submit) => {
    const carrier = runtime.telemetry.propagation.inject(submit);
    assert.ok(carrier);
    const taskContext = runtime.telemetry.propagation.extract(carrier);
    await taskContext.startSpan({
      name: 'pi.durable.phase',
      attributes: {
        'task.id': 41,
        'task.name': 'pi.generation',
        phase: 'model',
        kind: 'run',
        resumed: false,
      },
    }, async (phase) => {
      phase.addEvent('pi.durable.checkpoint', { phase: 'stream', secret: 'TOOL_ARGS' });
      await phase.startSpan({
        name: 'pi.ai.request',
        attributes: {
          provider: 'faux',
          api: 'faux-api',
          model: 'faux-1',
          prompt: 'TRANSCRIPT_SECRET',
        },
      }, async (request) => {
        request.addEvent('pi.ai.first_chunk');
        request.addEvent('pi.ai.block', {
          type: 'text',
          index: 0,
          chars: 80,
          text: 'GENERATED_SECRET',
        });
        assert.equal(Object.hasOwn(request.record.attributes, 'prompt'), false);
        request.setAttributes({
          stop: 'stop',
          'usage.input': 100,
          'usage.output': 40,
          'usage.cache_read': 20,
          'usage.cache_write': 5,
          'cost.total': 0.002,
          'response.id': 'RESPONSE_SECRET',
        });
        assert.equal(Object.hasOwn(request.record.attributes, 'response.id'), false);
        request.setStatus({
          status: 'error',
          error: { name: 'provider_error', message: 'ERROR_SECRET' },
        });
        const metrics = runtime.telemetry.metrics;
        metrics.histogram('pi.ai.request.duration').record(
          900,
          { provider: 'faux', model: 'faux-1', stop: 'stop' },
          request,
        );
        metrics.counter('pi.ai.tokens').add(
          100,
          { provider: 'faux', model: 'faux-1', kind: 'input' },
        );
        metrics.counter('pi.ai.tokens').add(
          40,
          { provider: 'faux', model: 'faux-1', kind: 'output' },
        );
        metrics.counter('pi.ai.cost').add(
          0.002,
          { provider: 'faux', model: 'faux-1' },
        );
      });
    });
  });
  runtime.recordConversationEvent({ type: 'run.completed', conversationId: '7' });

  const content = runtime.provider.read({ sessionId: '7' });
  assert.equal(metric(content, 'live-tps').unit, 'tok/s');
  assert.equal(metric(content, 'ttft').unit, 'ms');
  assert.equal(metric(content, 'request-duration').value, '900');
  assert.equal(metric(content, 'request-duration').unit, 'ms');
  assert.equal(metric(content, 'input-tokens').value, '125');
  assert.equal(metric(content, 'output-tokens').value, '40');
  assert.equal(metric(content, 'cost').value, '$0.002');
  assert.ok(flatten(content).some((value) => value === '本轮完成'));
  assert.ok(flatten(content).some((value) => value === '最近一轮已结束'));

  const serialized = JSON.stringify(content);
  for (const secret of [
    'TRANSCRIPT_SECRET',
    'GENERATED_SECRET',
    'TOOL_ARGS',
    'RESPONSE_SECRET',
    'ERROR_SECRET',
  ]) {
    assert.equal(serialized.includes(secret), false, `${secret} leaked into UI data`);
  }

  await waitFor(() => events.length > 0);
  unsubscribe();
  assert.equal(runtime.diagnostics().dataSourceSubscriptions, 0);
});

test('uses reference counted providers and releases every window subscription', async () => {
  const runtime = createMetricsRuntime();
  let firstEvents = 0;
  let secondEvents = 0;
  const first = runtime.provider.subscribe({ sessionId: '11' }, () => {
    firstEvents += 1;
  });
  const second = runtime.provider.subscribe({ sessionId: '11' }, () => {
    secondEvents += 1;
  });

  assert.equal(runtime.diagnostics().dataSourceSubscriptions, 2);
  first();
  first();
  assert.equal(runtime.diagnostics().dataSourceSubscriptions, 1);
  runtime.recordConversationEvent({ type: 'run.started', conversationId: '11' });
  await waitFor(() => secondEvents > 0);
  assert.equal(firstEvents, 0);

  second();
  assert.equal(runtime.diagnostics().dataSourceSubscriptions, 0);
  runtime.recordConversationEvent({ type: 'run.completed', conversationId: '11' });
  await new Promise((resolve) => setTimeout(resolve, 130));
  assert.equal(firstEvents, 0);
  assert.equal(secondEvents, 1);
});

test('running usage updates expose tokens and cost before completion', () => {
  const runtime = createMetricsRuntime();
  runtime.recordConversationEvent({ type: 'run.started', conversationId: '21' });
  runtime.recordConversationEvent({
    type: 'usage.updated',
    conversationId: '21',
    payload: {
      usage: {
        models: {
          'faux/faux-1': {
            input: 100,
            output: 40,
            cacheRead: 20,
            cacheWrite: 5,
            cost: { total: 0.002 },
          },
        },
      },
    },
  });

  const live = runtime.provider.read({ sessionId: '21' });
  assert.equal(metric(live, 'input-tokens').value, '125');
  assert.equal(metric(live, 'output-tokens').value, '40');
  assert.equal(metric(live, 'cost').value, '$0.002');

  runtime.recordConversationEvent({ type: 'run.completed', conversationId: '21' });
  const completed = runtime.provider.read({ sessionId: '21' });
  assert.equal(metric(completed, 'input-tokens').value, '125');
  assert.equal(metric(completed, 'output-tokens').value, '40');
  assert.equal(metric(completed, 'cost').value, '$0.002');
});

test('maps a public session UUID to the numeric Durable conversation ID', async () => {
  const runtime = createMetricsRuntime();
  const events = [];
  const unsubscribe = runtime.provider.subscribe({
    sourceId: METRICS_SOURCE_ID,
    sessionId: '45c5e0e5-05b6-4ba3-ab38-afd88fdd7235',
    durableSessionId: '45',
  }, (content) => events.push(content));

  runtime.recordConversationEvent({ type: 'run.started', conversationId: '45' });
  runtime.recordConversationEvent({
    type: 'usage.updated',
    conversationId: '45',
    payload: {
      usage: {
        models: {
          'deepseek/deepseek-flash': {
            input: 80,
            output: 20,
            cost: { total: 0.001 },
          },
        },
      },
    },
  });
  await waitFor(() => events.some((content) => metric(content, 'output-tokens')));

  const content = runtime.provider.read({
    sessionId: '45c5e0e5-05b6-4ba3-ab38-afd88fdd7235',
    durableSessionId: '45',
  });
  assert.equal(metric(content, 'input-tokens').value, '80');
  assert.equal(metric(content, 'output-tokens').value, '20');
  unsubscribe();
});

test('formats large metric values without overflowing their cards', async () => {
  const runtime = createMetricsRuntime();
  runtime.recordConversationEvent({ type: 'run.started', conversationId: '51' });
  await runtime.telemetry.startSpan({
    name: 'pi.durable.submit',
    attributes: {
      'conversation.id': 51,
      'submission.type': 'input',
    },
  }, async (submit) => {
    const carrier = runtime.telemetry.propagation.inject(submit);
    const taskContext = runtime.telemetry.propagation.extract(carrier);
    await taskContext.startSpan({
      name: 'pi.durable.phase',
      attributes: {
        'task.id': 52,
        'task.name': 'pi.generation',
        phase: 'model',
        kind: 'run',
      },
    }, async (phase) => {
      await phase.startSpan({
        name: 'pi.ai.request',
        attributes: {
          provider: 'faux',
          model: 'large-values',
        },
      }, async (request) => {
        request.addEvent('pi.ai.first_chunk');
        request.setAttributes({
          'usage.input': 11_475,
          'usage.output': 48,
          'cost.total': 0.0000004,
        });
        runtime.telemetry.metrics.histogram('pi.ai.request.duration').record(
          2_390,
          { provider: 'faux', model: 'large-values' },
          request,
        );
      });
    });
  });
  runtime.recordConversationEvent({ type: 'run.completed', conversationId: '51' });

  const content = runtime.provider.read({ sessionId: '51' });
  assert.equal(metric(content, 'request-duration').value, '2.39');
  assert.equal(metric(content, 'request-duration').unit, 's');
  assert.equal(metric(content, 'input-tokens').value, '11.5K');
  assert.equal(metric(content, 'output-tokens').value, '48');
  assert.equal(metric(content, 'cost').value, '<$0.000001');

  const recentResults = flatten(content).find((value) => (
    value?.kind === 'statusList' && value?.title === '最近结果'
  ));
  assert.ok(recentResults);
  assert.match(recentResults.items[0].detail, /TPS .* · TTFT .* · 耗时 2\.39 s/);
  assert.match(recentResults.items[0].detail, /Token 11\.5K \/ 48/);

  const footer = runtime.provider.read({
    sourceId: METRICS_FOOTER_SOURCE_ID,
    sessionId: '51',
  });
  const footerText = flatten(footer).find((value) => value?.kind === 'text')?.text;
  assert.ok(footerText);
  assert.match(footerText, / · TTFT \d+(?:\.\d+)? s$/);
  assert.equal(footerText.includes('Token'), false);

  assert.equal(compactFooterDuration(900), '0.9 s');
  assert.equal(compactFooterDuration(2_390), '2.39 s');
  assert.equal(compactFooterDuration(65_000), '1m 05s');
});

test('restores persisted request metrics after the runtime restarts', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-studio-metrics-persist-'));
  const filename = path.join(directory, 'studio.sqlite');
  let database = createStudioDatabase(filename);
  t.after(() => {
    if (database.isOpen()) database.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  database.insertConversation({
    id: '61',
    publicId: '61-public',
    workspace: directory,
    kind: 'conversation',
    title: 'Metrics persistence',
  });

  const first = createMetricsRuntime({
    onRequestCompleted: (request) => {
      database.recordUsageRequest(request);
      database.recordMetricRequest(request);
    },
  });
  first.recordConversationEvent({ type: 'run.started', conversationId: '61' });
  await first.telemetry.startSpan({
    name: 'pi.durable.submit',
    attributes: {
      'conversation.id': 61,
      'submission.type': 'input',
    },
  }, async (submit) => {
    const carrier = first.telemetry.propagation.inject(submit);
    const taskContext = first.telemetry.propagation.extract(carrier);
    await taskContext.startSpan({
      name: 'pi.durable.phase',
      attributes: {
        'task.id': 62,
        'task.name': 'pi.generation',
        phase: 'model',
        kind: 'run',
      },
    }, async (phase) => {
      await phase.startSpan({
        name: 'pi.ai.request',
        attributes: {
          provider: 'deepseek',
          model: 'deepseek-flash',
        },
      }, async (request) => {
        request.addEvent('pi.ai.first_chunk');
        first.telemetry.metrics.histogram('pi.ai.first_chunk.duration').record(
          250,
          { provider: 'deepseek', model: 'deepseek-flash' },
          request,
        );
        request.setAttributes({
          'usage.input': 1_200,
          'usage.output': 200,
          'usage.cache_read': 100,
          'cost.total': 0.004,
        });
        first.telemetry.metrics.histogram('pi.ai.request.duration').record(
          2_500,
          { provider: 'deepseek', model: 'deepseek-flash' },
          request,
        );
      });
    });
  });
  first.recordConversationEvent({ type: 'run.completed', conversationId: '61' });
  first.close();
  database.close();
  database = createStudioDatabase(filename);

  const rows = database.listMetricRequests({ conversationId: '61' });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].providerId, 'deepseek');
  assert.equal(rows[0].modelId, 'deepseek-flash');
  assert.equal(rows[0].durationMs, 2_500);

  const restored = createMetricsRuntime({
    loadMetricRequests: (conversationId) => (
      database.listMetricRequests({ conversationId })
    ),
  });
  const scope = {
    sourceId: METRICS_SOURCE_ID,
    sessionId: '61-public',
    durableSessionId: '61',
  };
  const content = restored.provider.read(scope);
  assert.equal(metric(content, 'request-duration').value, '2.5');
  assert.equal(metric(content, 'input-tokens').value, '1.3K');
  assert.equal(metric(content, 'output-tokens').value, '200');
  assert.equal(metric(content, 'cost').value, '$0.004');

  const footer = restored.provider.read({
    ...scope,
    sourceId: METRICS_FOOTER_SOURCE_ID,
  });
  assert.match(
    flatten(footer).find((value) => value?.kind === 'text')?.text,
    /^最近请求 · \d+(?:\.\d+)? tok\/s · TTFT 0\.25 s$/,
  );
  restored.close();

  database.deleteConversation('61-public');
  assert.deepEqual(database.listMetricRequests({ conversationId: '61' }), []);
});

test('bounds persisted metric history per conversation', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-studio-metrics-bound-'));
  const database = createStudioDatabase(path.join(directory, 'studio.sqlite'));
  t.after(() => {
    database.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  for (let index = 0; index < 14; index += 1) {
    database.recordMetricRequest({
      requestId: `bounded-metric-${index}`,
      conversationId: '71',
      at: 1_000 + index,
      finishedAt: 2_000 + index,
      providerId: 'faux',
      modelId: 'bounded',
      durationMs: 10,
      input: index,
      output: index,
    });
  }
  database.recordMetricRequest({
    requestId: 'other-conversation',
    conversationId: '72',
    at: 1,
    finishedAt: 2,
    providerId: 'faux',
    modelId: 'other',
    durationMs: 1,
  });

  const rows = database.listMetricRequests({ conversationId: '71' });
  assert.equal(rows.length, 8);
  assert.equal(rows[0].requestId, 'bounded-metric-13');
  assert.equal(rows.at(-1).requestId, 'bounded-metric-6');
  assert.equal(database.listMetricRequests({ conversationId: '72' }).length, 1);
});

test('emits one content-free aggregate when a model request settles', async () => {
  const completed = [];
  const runtime = createMetricsRuntime({
    onRequestCompleted: (request) => completed.push(request),
  });
  runtime.recordConversationEvent({ type: 'run.started', conversationId: '31' });
  await runtime.telemetry.startSpan({
    name: 'pi.ai.request',
    attributes: {
      'conversation.id': 31,
      provider: 'deepseek',
      model: 'deepseek-flash',
      prompt: 'must not be persisted',
    },
  }, async (request) => {
    request.addEvent('pi.ai.first_chunk');
    request.setAttributes({
      'usage.input': 200,
      'usage.output': 80,
      'usage.cache_read': 20,
      'usage.cache_write': 5,
      'cost.total': 0.003,
      body: 'must not be persisted',
    });
  });

  assert.equal(completed.length, 1);
  assert.equal(completed[0].providerId, 'deepseek');
  assert.equal(completed[0].modelId, 'deepseek-flash');
  assert.equal(completed[0].input, 200);
  assert.equal(completed[0].output, 80);
  assert.equal(JSON.stringify(completed).includes('must not be persisted'), false);
});

test('keeps retained sessions, samples and active spans bounded', async () => {
  const runtime = createMetricsRuntime();
  for (let id = 1; id <= MAX_SESSIONS + 16; id += 1) {
    runtime.recordConversationEvent({
      type: 'snapshot',
      conversationId: String(id),
      payload: { run: { id } },
    });
  }
  assert.equal(runtime.diagnostics().sessions, MAX_SESSIONS);

  const session = [...runtime.sessions.values()][0];
  for (let index = 0; index < MAX_TPS_SAMPLES + 20; index += 1) {
    runtime.pushTpsSample(session, index + 1);
  }
  for (let index = 0; index < MAX_RECENT_RUNS + 4; index += 1) {
    session.running = true;
    session.currentRun = {
      ...session.currentRun,
      status: 'running',
      tps: index,
    };
    runtime.finishRun(session, 'done');
  }
  assert.equal(session.tpsSamples.length, MAX_TPS_SAMPLES);
  assert.equal(session.recentRuns.length, MAX_RECENT_RUNS);

  const pending = [];
  for (let index = 0; index < MAX_ACTIVE_SPANS + 12; index += 1) {
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const promise = runtime.telemetry.startSpan({
      name: 'pi.durable.submit',
      attributes: { 'conversation.id': index + 1 },
    }, async () => gate);
    pending.push({ promise, release });
  }
  assert.equal(runtime.diagnostics().activeSpans, MAX_ACTIVE_SPANS);
  for (const item of pending) item.release();
  await Promise.all(pending.map((item) => item.promise));
  assert.equal(runtime.diagnostics().activeSpans, 0);
});

test('disabling the extension clears telemetry and live subscriptions', () => {
  const runtime = createMetricsRuntime();
  const unsubscribe = runtime.provider.subscribe({ sessionId: '9' }, () => {});
  runtime.recordConversationEvent({ type: 'run.started', conversationId: '9' });
  assert.equal(runtime.diagnostics().sessions, 1);
  assert.equal(runtime.diagnostics().dataSourceSubscriptions, 1);

  runtime.setEnabled(false);
  assert.deepEqual(runtime.provider.read({ sessionId: '9' }), []);
  assert.equal(runtime.diagnostics().sessions, 0);
  assert.equal(runtime.diagnostics().dataSourceSubscriptions, 0);
  unsubscribe();

  runtime.setEnabled(true);
  runtime.recordConversationEvent({ type: 'run.started', conversationId: '9' });
  runtime.close();
  assert.deepEqual(runtime.provider.read({ sessionId: '9' }), []);
});
