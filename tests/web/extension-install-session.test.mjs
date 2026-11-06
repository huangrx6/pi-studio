import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
import { errorText } from '../../web/src/shared/error-text.ts';

const source = fs.readFileSync(new URL('../../web/src/features/extensions/extension-install-session.ts', import.meta.url), 'utf8');
const context = { exports: {}, setTimeout, clearTimeout, require: () => ({ errorText }) };
vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, context);
const { createExtensionInstallSession, extensionInstallOwnerKey } = context.exports;
const preview = (token = 'a', overrides = {}) => ({ token, scope: 'project', name: 'QA', version: '1', executable: true, executableExpansion: false, permissions: [], addedPermissions: [], providerAccess: [], addedProviderAccess: [], requires: [], addedRequirements: [], missingDependencies: [], requiresPublisherTrust: false, ...overrides });
const result = { committed: true, installed: { id: 'qa', version: '1', contentChanged: true, trustRevoked: false }, projection: { status: 'ready', value: {} }, recoveryToken: 'recovery-receipt' };
const tick = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
const timers = () => new Promise(resolve => setTimeout(resolve, 5));
function fixture(initialPreview = null, onInstalled) {
  const calls = [], disposed = [], disposedReceipts = [], changes = [], applied = [];
  let cwd = '/A', seed = initialPreview, closes = 0;
  const api = Object.fromEntries(['pickExtensionSource', 'prepareExtensionInstall', 'installExtension', 'refreshExtensionInstall'].map(method => [method, (...args) => new Promise((resolve, reject) => calls.push({ method, args, resolve, reject }))]));
  api.disposeExtensionInstall = async token => { disposed.push(token); if (api.failDispose) throw new Error('dispose rejected'); };
  api.disposeExtensionInstallRecovery = async token => { disposedReceipts.push(token); if (api.failDispose) throw new Error('receipt dispose rejected'); };
  const session = createExtensionInstallSession({ api, cwd, initialPreview,
    isContextCurrent: key => key === extensionInstallOwnerKey(cwd, seed),
    onChange: state => changes.push(state), onInstalled: value => { applied.push(value); return onInstalled?.(value); }, onClose: () => { closes++; },
  });
  session.activate();
  return { session, calls, disposed, disposedReceipts, changes, applied, api, get closes() { return closes; },
    change(nextCwd, nextPreview = null, effect = true) { cwd = nextCwd; seed = nextPreview; if (effect) session.setContext(cwd, seed); },
  };
}
const input = { source: '/synthetic/source', scope: 'project', registryUrl: '' };

test('pick, prepare and install each acquire one synchronous shared operation lock', async () => {
  for (const action of ['pick', 'prepare', 'install']) {
    const h = fixture(action === 'install' ? preview() : null);
    const invoke = () => action === 'pick' ? h.session.pick('directory') : action === 'prepare' ? h.session.prepare(input) : h.session.install(true);
    const first = invoke(); await invoke(); await h.session.pick('package'); h.session.close();
    assert.equal(h.calls.length, 1); assert.equal(h.closes, 0);
    h.calls[0].resolve(action === 'pick' ? '/picked' : action === 'prepare' ? preview() : result);
    await first;
    if (action === 'install') assert.equal(h.closes, 1);
    else h.session.close();
  }
});

test('late prepare tokens are disposed after unmount or a workspace render change before its effect', async () => {
  for (const change of ['unmount', 'render', 'context']) {
    const h = fixture(); const pending = h.session.prepare(input);
    if (change === 'unmount') h.session.deactivate(); else h.change('/B', null, change !== 'render');
    h.calls[0].resolve(preview('late')); await pending; await tick();
    assert.deepEqual(h.disposed, ['late']); assert.equal(h.applied.length, 0);
    assert.equal(h.session.getState().preview, null);
    h.session.deactivate(); await timers();
  }
});

test('late pick and failure do not replace the next workspace source or error', async () => {
  for (const fail of [false, true]) {
    const h = fixture(); const pending = h.session.pick('directory'); h.change('/B');
    if (fail) h.calls[0].reject(new Error('old A')); else h.calls[0].resolve('/A/path');
    await pending; assert.equal(h.session.getState().source, ''); assert.equal(h.session.getState().error, null);
  }
});

test('new workspace can prepare immediately while old owner cannot release its lock or replace its result', async () => {
  for (const oldFirst of [true, false]) {
    const h = fixture(); const old = h.session.prepare(input); h.change('/B');
    assert.equal(h.session.getState().phase, null);
    const next = h.session.prepare({ ...input, source: '/B/source' });
    assert.equal(h.calls.length, 2); assert.equal(h.calls[1].args[0].cwd, '/B');
    if (oldFirst) {
      h.calls[0].resolve(preview('obsolete')); await old;
      assert.equal(h.session.getState().phase, 'prepare');
      await h.session.prepare(input); assert.equal(h.calls.length, 2);
      h.calls[1].resolve(preview('B')); await next;
    } else {
      h.calls[1].resolve(preview('B')); await next;
      h.calls[0].resolve(preview('obsolete')); await old;
    }
    await tick();
    assert.equal(h.session.getState().preview.token, 'B');
    assert.equal(h.session.getState().phase, null);
    assert.deepEqual(h.disposed, ['obsolete']);
  }
});

test('StrictMode cleanup-setup retains a valid initial token; real disposal catches rejected cleanup', async () => {
  const h = fixture(preview()); h.api.failDispose = true;
  h.session.deactivate(); h.session.activate(); await timers(); assert.equal(h.disposed.length, 0);
  h.session.deactivate(); await timers(); await tick(); assert.deepEqual(h.disposed, ['a']);
});

test('workspace change discards an unchanged initial token and never submits it under a new scope', async () => {
  const initial = preview(); const h = fixture(initial);
  h.change('/B', initial); await tick();
  assert.equal(h.session.getState().preview, null); assert.deepEqual(h.disposed, ['a']);
  await h.session.install(true); assert.equal(h.calls.length, 0);
  const next = preview('b', { scope: 'user' }); h.change('/B', next);
  const pending = h.session.install(true); assert.equal(h.calls[0].args[0].scope, 'user'); assert.equal(h.calls[0].args[0].cwd, '/B');
  h.calls[0].resolve(result); await pending;
});

test('preview scope and every required acceptance are preserved; missing dependencies and missing consent block IPC', async () => {
  const initial = preview('a', { addedPermissions: ['agent.tools'], addedProviderAccess: ['provider-a'], addedRequirements: ['dependency-a'], requiresPublisherTrust: true });
  const h = fixture(initial); await h.session.install(false); assert.equal(h.calls.length, 0);
  const pending = h.session.install(true);
  assert.deepEqual(JSON.parse(JSON.stringify(h.calls[0].args[0])), {
    token: 'a', scope: 'project', cwd: '/A', acceptedPermissions: ['agent.tools'], acceptedProviderAccess: ['provider-a'], acceptedRequirements: true, acceptedExecution: true, acceptedPublisherKey: true,
  });
  h.calls[0].resolve(result); await pending;
  const missing = fixture(preview('missing', { missingDependencies: ['not-installed'] })); await missing.session.install(true); assert.equal(missing.calls.length, 0);
});

test('successful install followed by callback failure retries only result application, never installation', async () => {
  let count = 0;
  const h = fixture(preview(), async () => { if (++count === 1) throw new Error('refresh rejected'); });
  const pending = h.session.install(true); h.calls[0].resolve(result); await pending;
  assert.equal(h.session.getState().committed, true); assert.match(h.session.getState().error, /已安装.*刷新失败/);
  assert.equal(h.closes, 0); await h.session.install(true); assert.equal(h.calls.length, 1);
  await h.session.retryApply(); assert.equal(h.applied.length, 2); assert.equal(h.calls.length, 1); assert.equal(h.closes, 1);
});

test('install success after unmount or workspace change never invokes stale callbacks', async () => {
  for (const unmount of [true, false]) {
    const h = fixture(preview()); const pending = h.session.install(true);
    if (unmount) h.session.deactivate(); else h.change('/B');
    h.calls[0].resolve(result); await pending;
    assert.equal(h.applied.length, 0); assert.equal(h.closes, 0); await timers();
  }
});

test('abandoned failed install retries cleanup after main releases its claimed token', async () => {
  const h = fixture(preview()); const pending = h.session.install(true); h.session.deactivate(); await timers();
  assert.deepEqual(h.disposed, ['a']);
  h.calls[0].reject(new Error('failed after claim')); await pending; await tick();
  assert.deepEqual(h.disposed, ['a', 'a']); assert.equal(h.applied.length, 0);
});

test('closing after back disposes a token only once and successful cleanup is not required for a new preview', async () => {
  const h = fixture(preview()); h.api.failDispose = true; h.session.back(); await tick();
  const pending = h.session.prepare(input); h.calls[0].resolve(preview('b')); await pending;
  h.session.close(); await tick(); assert.deepEqual(h.disposed, ['a', 'b']); assert.equal(h.closes, 1);
});

test('committed projection failure retries the receipt only and never repeats installation or consent', async () => {
  const h = fixture(preview());
  const installing = h.session.install(true);
  h.calls[0].resolve({ ...result, projection: { status: 'error', message: '扩展已安装，但设置同步失败。' } }); await installing;
  assert.equal(h.session.getState().committed, true); assert.equal(h.applied.length, 0); assert.equal(h.closes, 0);
  let refreshing = h.session.retryApply(); await h.session.retryApply();
  assert.equal(h.calls.length, 2); assert.equal(h.calls[1].method, 'refreshExtensionInstall');
  assert.deepEqual(h.calls[1].args, ['recovery-receipt']);
  h.calls[1].reject(new Error('/private/path?token=secret')); await refreshing;
  assert.match(h.session.getState().error, /已安装/); assert.doesNotMatch(h.session.getState().error, /private|secret/);
  assert.deepEqual(h.disposedReceipts, []);
  refreshing = h.session.retryApply(); h.calls[2].resolve(result); await refreshing; await tick();
  assert.equal(h.calls.filter(call => call.method === 'installExtension').length, 1);
  assert.equal(h.applied.length, 1); assert.equal(h.closes, 1);
  assert.deepEqual(h.disposedReceipts, ['recovery-receipt']);
  assert.deepEqual(h.disposed, [], 'consumed preview is not a recovery receipt');
});

test('a late receipt refresh does not apply to another workspace or unlock its pending preview', async () => {
  const h = fixture(preview()); const installing = h.session.install(true);
  h.calls[0].resolve({ ...result, projection: { status: 'error', message: '已安装' } }); await installing;
  const old = h.session.retryApply(); h.change('/B');
  const current = h.session.prepare({ ...input, source: '/B' });
  h.calls[1].resolve(result); await old; await tick();
  assert.equal(h.applied.length, 0); assert.equal(h.closes, 0);
  assert.equal(h.session.getState().phase, 'prepare'); assert.deepEqual(h.disposedReceipts, ['recovery-receipt']);
  h.calls[2].resolve(preview('B')); await current; assert.equal(h.session.getState().preview.token, 'B');
});

test('close or real unmount releases receipts, while StrictMode replay retains them and catches cleanup errors', async () => {
  for (const close of [true, false]) {
    const h = fixture(preview()); h.api.failDispose = true;
    const installing = h.session.install(true); h.calls[0].resolve({ ...result, projection: { status: 'error', message: '已安装' } }); await installing;
    h.session.deactivate(); h.session.activate(); await timers(); assert.equal(h.disposedReceipts.length, 0);
    if (close) h.session.close(); else h.session.deactivate();
    await timers(); await tick(); assert.deepEqual(h.disposedReceipts, ['recovery-receipt']);
  }
});
