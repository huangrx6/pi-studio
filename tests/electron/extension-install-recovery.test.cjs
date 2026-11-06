const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const test = require('node:test');
const { createExtensionInstallRecovery } = require('../../electron/services/extension-install-recovery.cjs');

const installed = { id: 'qa', version: '2', contentChanged: true, activeCodePath: '/private/code', dataPath: '/private/data' };
function ipcFixture() {
  const handlers = new Map(), rows = [{ id: 'project:qa', scope: 'project', trusted: true, contentHash: 'old-hash', updatedAt: 1 }];
  const calls = { install: [], revoke: [], views: [], settings: [], runtime: [] };
  const fail = {};
  const db = {
    listExtensions: () => rows.map(row => ({ ...row })),
    getExtension(id) { if (fail.trustRead) throw new Error('/private/db?apiKey=secret'); return rows.find(row => row.id === id); },
    setExtensionTrusted(id, trusted, contentHash) {
      if (fail.trustWrite) throw new Error('credential=secret');
      calls.revoke.push(id); Object.assign(rows.find(row => row.id === id), { trusted, contentHash, updatedAt: 2 });
      if (fail.trustAfterWrite) throw new Error('secret after commit');
    },
  };
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../electron/ipc/settings.cjs'), 'utf8'), {
    module, exports: module.exports, console,
    require(id) {
      if (id.startsWith('node:')) return require(id);
      if (id === 'electron') return { ipcMain: { handle: (channel, callback) => handlers.set(channel, callback) }, webContents: { getAllWebContents: () => [] } };
      if (id === '../core/state.cjs') return { DEFAULT_CWD: '/default' };
      if (id === '../core/studio-db.cjs') return { getStudioDatabase: () => db };
      if (id === '../services/extension-install-recovery.cjs') return { createExtensionInstallRecovery };
      if (id === '../services/studio-extensions.cjs') return {
        stableExtensionId: (scope, name) => `${scope}:${name}`,
        extensionDistributionService: () => ({ installPrepared: async (token, options) => { calls.install.push({ token, options }); if (fail.install) throw new Error('not committed'); return installed; } }),
      };
      if (id === './sessions.cjs') return { closeExtensionDataViews: async id => { calls.views.push(id); if (fail.views) throw new Error('apiKey=secret'); } };
      if (id === '../runtime/durable-runtime.cjs') return { refreshExtensionRuntime: async cwd => { calls.runtime.push(cwd); if (fail.runtime) throw new Error('token=secret'); } };
      if (id === '../services/settings.cjs') return { settingsSnapshot: async cwd => { calls.settings.push(cwd); if (fail.settings) throw new Error('/private/settings'); return { skills: [], extensions: [] }; } };
      return {};
    },
  });
  module.exports.registerSettingsIpc();
  const sender = Object.assign(new EventEmitter(), { id: 41, isDestroyed: () => false });
  const invoke = (channel, payload, owner = sender) => handlers.get(channel)({ sender: owner }, payload);
  const install = () => invoke('pi:extension-install', { token: 'prepared-token', scope: 'project', cwd: '/workspace/A', acceptedPermissions: ['agent.tools'], acceptedExecution: true });
  return { fail, rows, calls, sender, invoke, install };
}

for (const stage of ['trustRead', 'trustWrite', 'views', 'settings', 'runtime']) {
  test(`committed installation survives ${stage} failure and refresh retries only incomplete post-commit work`, async () => {
    const h = ipcFixture(); h.fail[stage] = true;
    const first = await h.install();
    assert.equal(first.committed, true); assert.equal(first.projection.status, 'error');
    assert.match(first.projection.message, /已安装/);
    assert.doesNotMatch(JSON.stringify(first), /secret|private|activeCodePath|dataPath|prepared-token/);
    assert.ok(first.recoveryToken); h.fail[stage] = false;
    const recovered = await h.invoke('pi:extension-install-refresh', { token: first.recoveryToken, scope: 'user', cwd: '/malicious/B', acceptedExecution: false });
    assert.equal(recovered.projection.status, 'ready'); assert.equal(recovered.recoveryToken, first.recoveryToken);
    assert.equal(h.calls.install.length, 1); assert.equal(h.calls.revoke.length, 1);
    assert.ok(h.calls.runtime.every(cwd => cwd === '/workspace/A'));
    assert.ok(h.calls.settings.every(cwd => cwd === '/workspace/A'));
    const before = JSON.stringify(h.calls);
    await h.invoke('pi:extension-install-refresh', { token: first.recoveryToken });
    assert.equal(JSON.stringify(h.calls), before, 'ready receipt performs no stages again');
  });
}

test('later explicit trust is not revoked by retry after a successful revoke or an ambiguous post-write read failure', async () => {
  for (const postWrite of [false, true]) {
    const h = ipcFixture(); h.fail[postWrite ? 'trustAfterWrite' : 'views'] = true;
    const first = await h.install(); assert.equal(first.projection.status, 'error'); assert.equal(h.calls.revoke.length, 1);
    Object.assign(h.rows[0], { trusted: true, contentHash: 'new-authorized-content', updatedAt: 3 });
    h.fail.trustAfterWrite = false; h.fail.views = false;
    const next = await h.invoke('pi:extension-install-refresh', { token: first.recoveryToken });
    assert.equal(next.projection.status, 'ready'); assert.equal(h.rows[0].trusted, true); assert.equal(h.calls.revoke.length, 1);
  }
});

test('enable changes and metadata upserts cannot preserve stale content trust merely by updating its timestamp', async () => {
  for (const metadata of [{ enabled: false }, { name: 'updated manifest name', version: '2' }]) {
    const h = ipcFixture(); h.fail.trustRead = true;
    const first = await h.install();
    Object.assign(h.rows[0], metadata, { updatedAt: 99 });
    h.fail.trustRead = false;
    const recovered = await h.invoke('pi:extension-install-refresh', { token: first.recoveryToken });
    assert.equal(recovered.projection.status, 'ready');
    assert.equal(recovered.installed.trustRevoked, true);
    assert.equal(h.rows[0].trusted, false); assert.equal(h.calls.revoke.length, 1);
  }
});

test('receipt owner validation, explicit cleanup and window destruction prevent cross-window recovery', async () => {
  const h = ipcFixture(); h.fail.views = true; const first = await h.install();
  const other = { id: 42 };
  assert.throws(() => h.invoke('pi:extension-install-refresh', { token: first.recoveryToken }, other), /不可用/);
  assert.throws(() => h.invoke('pi:extension-install-recovery-dispose', { token: first.recoveryToken }, other), /不属于/);
  h.invoke('pi:extension-install-recovery-dispose', { token: first.recoveryToken });
  h.invoke('pi:extension-install-recovery-dispose', { token: first.recoveryToken });
  assert.throws(() => h.invoke('pi:extension-install-refresh', { token: first.recoveryToken }), /不可用/);
  const second = await h.install(); h.sender.emit('destroyed');
  assert.throws(() => h.invoke('pi:extension-install-refresh', { token: second.recoveryToken }), /不可用/);
});

test('simultaneous recovery shares a promise and retains immutable scope and commit metadata', async () => {
  let settingsCalls = 0, resolve;
  const service = createExtensionInstallRecovery({ revokeTrust: () => false, closeViews: () => {}, readSettings: () => { if (++settingsCalls === 1) throw new Error('first'); return new Promise(done => { resolve = done; }); } });
  const first = await service.install({ ownerId: 1, scope: 'user', cwd: '/A', install: async () => installed });
  const a = service.refresh(1, first.recoveryToken), b = service.refresh(1, first.recoveryToken);
  assert.equal(a, b); await Promise.resolve(); resolve({ extensions: [] });
  const result = await a;
  assert.equal(result.projection.status, 'ready'); assert.equal(settingsCalls, 2);
  assert.deepEqual(Object.keys(result.installed).sort(), ['contentChanged', 'id', 'trustRevoked', 'version']);
});

test('bounded receipt capacity rejects before installation, expiry releases capacity, ready records are reclaimable', async () => {
  let time = 0, installs = 0, failing = true;
  const service = createExtensionInstallRecovery({ now: () => time, maxReceipts: 1, ttlMs: 10, revokeTrust: () => false, closeViews() {}, readSettings() { if (failing) throw new Error('fail'); return {}; } });
  const commit = () => service.install({ ownerId: 1, scope: 'user', cwd: '/A', install: async () => { installs++; return installed; } });
  const first = await commit(); assert.throws(commit, /操作过多/); assert.equal(installs, 1);
  time = 11; assert.throws(() => service.refresh(1, first.recoveryToken), /过期/);
  failing = false; const ready = await commit(); assert.equal(ready.projection.status, 'ready');
  await commit(); assert.equal(installs, 3);
});

test('pre-commit installation failure remains a rejection and creates no recoverable receipt', async () => {
  const h = ipcFixture(); h.fail.install = true;
  await assert.rejects(h.install(), /not committed/);
  assert.equal(h.calls.revoke.length, 0); assert.equal(h.calls.views.length, 0); assert.equal(h.calls.settings.length, 0);
});
