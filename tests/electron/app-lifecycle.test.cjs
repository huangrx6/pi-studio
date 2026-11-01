const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { installApplicationShutdown } = require('../../electron/core/app-lifecycle.cjs');

function fixture(overrides = {}) {
  const app = new EventEmitter();
  let exit;
  const exited = new Promise(resolve => { exit = resolve; });
  const codes = [];
  app.exit = code => { codes.push(code); exit(); };
  const calls = [];
  installApplicationShutdown({ app, updaterOwnsQuit: () => false,
    stopUi: () => calls.push('ui'), report: () => {}, steps: [], ...overrides });
  const quit = () => {
    let prevented = false;
    app.emit('before-quit', { preventDefault: () => { prevented = true; } });
    return prevented;
  };
  return { app, exited, codes, calls, quit };
}

test('quit is marked before cleanup, repeated requests finish once, final native phase is not blocked', async () => {
  let release;
  const cleanup = new Promise(resolve => { release = resolve; });
  const f = fixture({ steps: [[{ label: 'runtime', run: () => cleanup, timeoutMs: 500 }]] });
  assert.equal(f.quit(), true);
  assert.equal(f.app.isQuitting, true);
  await Promise.resolve();
  assert.deepEqual(f.calls, ['ui']);
  assert.equal(f.quit(), true);
  assert.equal(f.app.listenerCount('will-quit'), 0);
  release();
  await f.exited;
  assert.deepEqual(f.codes, [0]);
});

test('failed or hung service cannot prevent the rest of cleanup or process exit', async () => {
  const calls = [];
  const f = fixture({ steps: [
    [{ label: 'hung', run: () => new Promise(() => {}), timeoutMs: 10 },
      { label: 'failed', run: () => { throw Error('failed'); }, timeoutMs: 10 }],
    [{ label: 'storage', run: () => calls.push('storage'), timeoutMs: 10 }],
  ] });
  f.quit();
  await f.exited;
  assert.deepEqual(calls, ['storage']);
  assert.deepEqual(f.codes, [0]);
});

test('updater-owned quit remains native and does not destroy its install flow', () => {
  const f = fixture({ updaterOwnsQuit: () => true });
  assert.equal(f.quit(), false);
  assert.equal(f.app.isQuitting, true);
  assert.deepEqual(f.calls, []);
  assert.deepEqual(f.codes, []);
});

test('UI teardown failure still terminates the process', async () => {
  const f = fixture({ stopUi: () => { throw Error('destroyed tray'); } });
  f.quit();
  await f.exited;
  assert.deepEqual(f.codes, [0]);
});
