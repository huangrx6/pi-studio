import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import ts from 'typescript';
import { errorText } from '../../web/src/shared/error-text.ts';

const module = { exports: {} };
const source = fs.readFileSync(new URL('../../web/src/features/update/update-resource.ts', import.meta.url), 'utf8');
vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, {
  module, exports: module.exports, require: () => ({ errorText }),
});
const { createUpdateResource } = module.exports;
const tick = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
const snapshot = (state, extra = {}) => ({ currentVersion: '1', state, ...extra });
function harness() {
  const calls = [], order = [], changes = [];
  let emit, open, opens = 0, unsubscribed = 0;
  const api = Object.fromEntries(['updateState', 'checkForUpdates', 'downloadUpdate', 'installUpdate'].map(method => [method, (...args) => {
    order.push(method); return new Promise((resolve, reject) => calls.push({ method, args, resolve, reject }));
  }]));
  api.onUpdateState = callback => { order.push('subscribe'); emit = callback; return () => { unsubscribed++; }; };
  api.onOpenUpdate = callback => { open = callback; return () => { unsubscribed++; }; };
  const resource = createUpdateResource({ api, onChange: value => changes.push(value), onOpen: () => { opens++; } });
  resource.start();
  return { resource, calls, order, changes, emit: value => emit(value), open: () => open(), get opens() { return opens; }, get unsubscribed() { return unsubscribed; } };
}

test('subscribe precedes initial read; late initial snapshot cannot replace newer event', async () => {
  const h = harness(); await tick(); assert.deepEqual(h.order, ['subscribe', 'updateState']);
  h.emit(snapshot('available')); h.calls[0].resolve(snapshot('idle')); await tick();
  assert.equal(h.changes.length, 1); assert.equal(h.changes.at(-1).state, 'available');
});

test('late check and download results cannot rewind newer event snapshots', async () => {
  for (const method of ['check', 'download']) {
    const h = harness(); await tick(); const pending = h.resource[method](); await tick();
    h.emit(snapshot('downloading', { progress: 75 })); h.calls[1].resolve(snapshot('available')); await pending;
    assert.equal(h.changes.at(-1).progress, 75);
  }
});

test('starting an action invalidates the startup read even before any main-process event', async () => {
  const h = harness(); await tick(); const pending = h.resource.check(); await tick();
  h.calls[0].resolve(snapshot('idle')); await tick(); assert.equal(h.changes.length, 0);
  h.calls[1].resolve(snapshot('available')); await pending;
  assert.equal(h.changes.at(-1).state, 'available');
});

test('duplicates share an app-wide promise; a different pending action gives explicit retry feedback', async () => {
  const h = harness(); await tick();
  const first = h.resource.check(); assert.equal(h.resource.check(), first);
  await assert.rejects(h.resource.download(), /请稍后重试/);
  await tick(); assert.equal(h.calls.length, 2);
  h.calls[1].resolve(snapshot('available')); await first;
  const next = h.resource.download(); await tick(); assert.equal(h.calls.length, 3);
  h.calls[2].resolve(snapshot('downloaded')); await next;
});

test('obsolete rejected checks do not erase newer completed state; current failure is recoverable', async () => {
  for (const state of ['available', 'downloaded', 'up-to-date', 'downloading']) {
    const h = harness(); await tick(); const pending = h.resource.check(); await tick();
    h.emit(snapshot(state)); h.calls[1].reject(new Error('stale')); await pending;
    assert.equal(h.changes.at(-1).state, state);
  }
  const h = harness(); await tick(); const pending = h.resource.check(); await tick();
  h.emit(snapshot('checking')); h.calls[1].reject(new Error('offline')); await pending;
  assert.equal(h.changes.at(-1).state, 'error'); assert.equal(h.changes.at(-1).error, 'offline');
});

test('install failure retains downloaded state, rejects to dialog, and releases retry lock', async () => {
  const h = harness(); await tick(); h.emit(snapshot('downloaded'));
  const pending = h.resource.install(); await tick(); h.calls[1].reject(new Error('cannot restart'));
  await assert.rejects(pending, /cannot restart/); assert.equal(h.changes.at(-1).state, 'downloaded');
  const retry = h.resource.install(); await tick(); h.calls[2].resolve({ started: true }); await retry;
});

test('available and ready targets autoopen once each; a new build or explicit request opens again', async () => {
  const h = harness(); await tick();
  const available = snapshot('available', { latestVersion: '2', latestBuildId: 'a' });
  h.emit(available); h.emit(available); assert.equal(h.opens, 1);
  const ready = snapshot('downloaded', { latestVersion: '2', latestBuildId: 'a' });
  h.emit(ready); h.emit(ready); h.emit(available); assert.equal(h.opens, 2);
  h.emit({ ...ready, latestBuildId: 'b' }); assert.equal(h.opens, 3);
  h.open(); assert.equal(h.opens, 4);
});

test('dispose ignores old event/read/action completion and unsubscribes both listeners', async () => {
  const h = harness(); await tick(); const pending = h.resource.download(); await tick();
  h.resource.dispose(); h.calls[0].resolve(snapshot('available')); h.calls[1].reject(new Error('obsolete'));
  h.emit(snapshot('downloaded')); h.open(); await pending; await tick();
  assert.equal(h.changes.length, 0); assert.equal(h.opens, 0); assert.equal(h.unsubscribed, 2);
  await h.resource.check(); assert.equal(h.calls.length, 2);
});
