const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createStartupGate } = require('../../electron/core/startup-gate.cjs');

test('activation is deferred until initialization has completed', async () => {
  let release;
  const initialization = new Promise((resolve) => {
    release = resolve;
  });
  let readyCalls = 0;
  const gate = createStartupGate({
    initialize: () => initialization,
    ready: ({ requestedBeforeReady }) => {
      readyCalls += 1;
      assert.equal(requestedBeforeReady, true);
    },
    failed: () => assert.fail('startup must not fail'),
  });

  const started = gate.start();
  assert.equal(gate.status, 'starting');
  assert.equal(gate.requestReveal(), false);
  assert.equal(gate.requestedBeforeReady, true);
  release();
  await started;
  assert.equal(gate.status, 'ready');
  assert.equal(gate.requestReveal(), true);
  assert.equal(readyCalls, 1);
});

test('startup failure never exposes a ready window and is reported once', async () => {
  const errors = [];
  let failureCalls = 0;
  const gate = createStartupGate({
    initialize: async () => {
      throw new Error('database unavailable');
    },
    ready: () => assert.fail('failed startup must not create a window'),
    failed: (error) => {
      failureCalls += 1;
      errors.push(error.message);
    },
  });

  await gate.start();
  assert.equal(gate.status, 'failed');
  assert.equal(gate.requestReveal(), false);
  assert.equal(failureCalls, 1);
  assert.deepEqual(errors, ['database unavailable']);
  await gate.start();
  assert.equal(failureCalls, 1);
});
