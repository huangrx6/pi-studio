const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const test = require('node:test');
const { createExtensionInstallRecovery } = require('../../electron/services/extension-install-recovery.cjs');
const { createExtensionMutationRecovery } = require('../../electron/services/extension-mutation-recovery.cjs');
const installed = { id: 'qa', version: '1', contentChanged: true, activeCodePath: '/private/code', dataPath: '/private/data' };

function fixture() {
  const handlers = new Map(), fail = {}, calls = { mutate: [], revoke: [], views: [], runtime: [], settings: [] };
  const row = { id: 'project:qa', scope: 'project', enabled: true, trusted: true, contentHash: 'old-hash' };
  const db = {
    getExtension() { if (fail.trustRead && calls.mutate.length) throw new Error('/private/token=secret'); return { ...row }; },
    setExtensionTrusted(id, trusted, hash) {
      if (fail.trustWrite) throw new Error('/private/token=secret');
      calls.revoke.push(id); Object.assign(row, { trusted, contentHash: hash });
    },
  };
  function mutate(action, cwd, value) {
    if (fail.write) throw new Error('write not committed');
    calls.mutate.push({ action, cwd });
    if (action === 'enable') row.enabled = value;
    if (action === 'trust') row.trusted = value;
    if (action === 'remove') row.removed = true;
    return installed;
  }
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../electron/ipc/settings.cjs'), 'utf8'), {
    module, exports: module.exports,
    require(id) {
      if (id.startsWith('node:')) return require(id);
      if (id === 'electron') return { ipcMain: { handle: (name, callback) => handlers.set(name, callback) }, webContents: { getAllWebContents: () => [] } };
      if (id === '../core/state.cjs') return { DEFAULT_CWD: '/default' };
      if (id === '../core/studio-db.cjs') return { getStudioDatabase: () => db };
      if (id === '../services/extension-install-recovery.cjs') return { createExtensionInstallRecovery };
      if (id === '../services/extension-mutation-recovery.cjs') return { createExtensionMutationRecovery };
      if (id === '../services/studio-extensions.cjs') return {
        stableExtensionId: (scope, id) => `${scope}:${id}`,
        setStudioExtensionEnabled: (_id, value, cwd) => mutate('enable', cwd, value),
        setStudioExtensionTrusted: (_id, value, cwd) => mutate('trust', cwd, value),
        removeStudioExtension: async (_id, cwd) => mutate('remove', cwd),
        extensionDistributionService: () => ({ rollback: async (_id, options) => mutate('rollback', options.cwd) }),
      };
      if (id === './sessions.cjs') return { closeExtensionDataViews: async id => { calls.views.push(id); if (fail.views) throw new Error('secret'); } };
      if (id === '../runtime/durable-runtime.cjs') return { refreshExtensionRuntime: async cwd => { calls.runtime.push(cwd); if (fail.runtime) throw new Error('secret'); } };
      if (id === '../services/settings.cjs') return { settingsSnapshot: async cwd => { calls.settings.push(cwd); if (fail.settings) throw new Error('/private'); return { extensions: [{ ...row }] }; } };
      return {};
    },
  });
  module.exports.registerSettingsIpc();
  const sender = Object.assign(new EventEmitter(), { id: 19, isDestroyed: () => false });
  const invoke = (channel, payload, owner = sender) => handlers.get(channel)({ sender: owner }, payload);
  const channels = { enable: 'pi:extensions-enable', trust: 'pi:extensions-trust', remove: 'pi:remove-extension', rollback: 'pi:extension-rollback' };
  return { fail, calls, row, sender, invoke,
    change: action => invoke(channels[action], { id: 'project:qa', enabled: false, trusted: false, scope: 'project', cwd: '/workspace/A' }),
    refresh: token => invoke('pi:extension-mutation-refresh', { token, cwd: '/ignored/B', scope: 'user' }),
  };
}

for (const action of ['enable', 'trust', 'remove', 'rollback']) {
  for (const stage of ['views', 'runtime', 'settings', ...(action === 'rollback' ? ['trustRead', 'trustWrite'] : [])]) {
    test(`${action}: ${stage} failure preserves commit and recovery never repeats the mutation`, async () => {
      const h = fixture(); h.fail[stage] = true;
      const first = await h.change(action);
      assert.equal(first.committed, true); assert.equal(first.projection.status, 'error');
      assert.match(first.projection.message, /更改已保存/);
      assert.doesNotMatch(JSON.stringify(first), /private|secret|activeCodePath|dataPath/);
      assert.equal('installed' in first, action === 'rollback');
      if (action === 'rollback') assert.deepEqual(Object.keys(first.installed).sort(), ['contentChanged', 'id', 'trustRevoked', 'version']);
      h.fail[stage] = false;
      const recovered = await h.refresh(first.recoveryToken);
      assert.equal(recovered.projection.status, 'ready'); assert.equal(h.calls.mutate.length, 1);
      assert.ok(h.calls.runtime.every(cwd => cwd === '/workspace/A'));
      assert.ok(h.calls.settings.every(cwd => cwd === '/workspace/A'));
      assert.ok(h.calls.views.every(id => id === 'project:qa'));
      if (action === 'rollback') assert.equal(h.calls.revoke.length, 1);
      const before = JSON.stringify(h.calls); await h.refresh(first.recoveryToken);
      assert.equal(JSON.stringify(h.calls), before, 'ready receipt does not rerun completed stages');
    });
  }
  test(`${action}: a rejected mutation remains uncommitted and runs no post-commit stages`, async () => {
    const h = fixture(); h.fail.write = true;
    await assert.rejects(h.change(action), /not committed/);
    assert.equal(h.calls.views.length, 0); assert.equal(h.calls.runtime.length, 0); assert.equal(h.calls.revoke.length, 0);
  });
}

test('rollback recovery distinguishes a later trust grant from an unrelated metadata update', async () => {
  for (const newConsent of [true, false]) {
    const h = fixture(); h.fail.trustRead = true;
    const first = await h.change('rollback');
    Object.assign(h.row, newConsent ? { contentHash: 'new-authorized-hash', trusted: true } : { enabled: false, updatedAt: 999 });
    h.fail.trustRead = false;
    const recovered = await h.refresh(first.recoveryToken);
    assert.equal(recovered.projection.status, 'ready');
    assert.equal(h.row.trusted, newConsent); assert.equal(h.calls.revoke.length, newConsent ? 0 : 1);
  }
});

test('a completed revoke is not replayed after later explicit trust', async () => {
  const h = fixture(); h.fail.views = true; const first = await h.change('rollback');
  Object.assign(h.row, { contentHash: 'new-authorized-hash', trusted: true }); h.fail.views = false;
  await h.refresh(first.recoveryToken); assert.equal(h.calls.revoke.length, 1); assert.equal(h.row.trusted, true);
});

test('owner, explicit disposal and window destruction isolate recovery receipts', async () => {
  const h = fixture(); h.fail.views = true; const first = await h.change('remove');
  assert.throws(() => h.invoke('pi:extension-mutation-refresh', { token: first.recoveryToken }, { id: 20 }), /不可用/);
  assert.throws(() => h.invoke('pi:extension-mutation-recovery-dispose', { token: first.recoveryToken }, { id: 20 }), /不属于/);
  h.invoke('pi:extension-mutation-recovery-dispose', { token: first.recoveryToken });
  h.invoke('pi:extension-mutation-recovery-dispose', { token: first.recoveryToken });
  assert.throws(() => h.refresh(first.recoveryToken), /不可用/);
  const second = await h.change('enable'); h.sender.emit('destroyed');
  assert.throws(() => h.refresh(second.recoveryToken), /不可用/);
});

test('unfinished commits survive TTL and keep capacity reserved; ready receipts expire or can be reclaimed', async () => {
  let time = 0, writes = 0, fail = true;
  const service = createExtensionMutationRecovery({ maxReceipts: 1, ttlMs: 10, now: () => time,
    revokeTrust() {}, closeViews() {}, readSettings() { if (fail) throw new Error('failure'); return {}; },
  });
  const change = () => service.mutate({ ownerId: 1, action: 'remove', id: 'user:qa', cwd: '/A', mutate() { writes++; } });
  const first = await change(); assert.throws(change, /操作过多|更改过多/); assert.equal(writes, 1);
  time = 11;
  assert.equal((await service.refresh(1, first.recoveryToken)).projection.status, 'error');
  assert.throws(change, /操作过多|更改过多/); assert.equal(writes, 1);
  fail = false;
  assert.equal((await service.refresh(1, first.recoveryToken)).projection.status, 'ready');
  assert.equal(writes, 1, 'recovery after TTL never replays the mutation');
  assert.throws(() => service.refresh(1, first.recoveryToken), /过期/);
  const ready = await change();
  time = 22; assert.throws(() => service.refresh(1, ready.recoveryToken), /过期/);
  await change(); await change(); assert.equal(writes, 4);
});

test('concurrent refresh calls share pending work and the original workspace', async () => {
  let reads = 0, resolve;
  const service = createExtensionMutationRecovery({ revokeTrust() {}, closeViews() {}, readSettings(record) {
    assert.equal(record.cwd, '/A');
    if (++reads === 1) throw new Error('first');
    return new Promise(done => { resolve = done; });
  } });
  const first = await service.mutate({ ownerId: 1, action: 'enable', id: 'user:qa', cwd: '/A', mutate() {} });
  const one = service.refresh(1, first.recoveryToken), two = service.refresh(1, first.recoveryToken);
  assert.equal(one, two); await Promise.resolve(); resolve({ extensions: [] });
  assert.equal((await one).projection.status, 'ready'); assert.equal(reads, 2);
});
