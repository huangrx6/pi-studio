const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { test, after } = require('node:test');
const { installElectronSafeStorage } = require('./helpers/electron-safe-storage.cjs');
installElectronSafeStorage({ after });
const { createStudioDatabase } = require('../../electron/core/studio-db.cjs');
const { createExtensionInstallRecovery } = require('../../electron/services/extension-install-recovery.cjs');
const source = fs.readFileSync(path.join(__dirname, '../../electron/ipc/settings.cjs'), 'utf8');

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-studio-mcp-projection-'));
  const db = createStudioDatabase(path.join(directory, 'studio.sqlite'));
  t.after(() => { db.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  const seed = name => db.upsertMcpServer({ name, transport: 'stdio', command: 'synthetic-command', args: [], env: { TOKEN: 'synthetic-secret' }, headers: { Authorization: 'synthetic-header-secret' }, enabled: true });
  seed('original');
  const writes = [], runtime = [], reads = [], oauthWrites = [], invalidations = [], handlers = new Map(), fail = {};
  for (const method of ['upsertMcpServer', 'removeMcpServer', 'setMcpEnabled']) {
    const original = db[method].bind(db);
    db[method] = (...args) => {
      writes.push(method);
      const result = original(...args);
      if (fail.afterWrite === method) throw new Error('synthetic post-write failure');
      return result;
    };
  }
  const module = { exports: {} };
  vm.runInNewContext(source, { module, exports: module.exports, console, require(id) {
    if (id.startsWith('node:')) return require(id);
    if (id === 'electron') return { ipcMain: { handle: (name, callback) => handlers.set(name, callback) }, webContents: { getAllWebContents: () => [] } };
    if (id === '../core/external-url.cjs') return require('../../electron/core/external-url.cjs');
    if (id === '../integrations/mcp/index.cjs') return {
      authorizeMcpServer: async server => {
        if (fail.credential) throw new Error('private access_token=synthetic-secret');
        db.writeMcpOAuthState(server.url, { serverUrl: server.url, tokens: { access_token: 'synthetic-secret', token_type: 'Bearer' } });
        oauthWrites.push('authorize'); return { ok: true };
      },
      clearMcpOAuth: url => {
        if (fail.credential) throw new Error('private access_token=synthetic-secret');
        db.deleteMcpOAuthState(url); oauthWrites.push('logout');
      },
      invalidateMcpConnection: async name => {
        invalidations.push(name); if (fail.invalidate) throw new Error('private access_token=synthetic-secret');
      },
    };
    if (id === '../core/state.cjs') return { DEFAULT_CWD: '/synthetic/default' };
    if (id === '../core/studio-db.cjs') return { getStudioDatabase: () => db };
    if (id === '../services/extension-install-recovery.cjs') return { createExtensionInstallRecovery };
    if (id === '../runtime/durable-runtime.cjs') return { refreshExtensionRuntime: async cwd => {
      runtime.push(cwd); if (fail.runtime) throw new Error('Authorization=synthetic-secret /private/runtime');
    } };
    if (id === '../services/settings.cjs') return { settingsSnapshot: async cwd => {
      reads.push(cwd); if (fail.settings) throw new Error('/private/db?token=synthetic-secret');
      return { mcpServers: db.listMcpServers() };
    } };
    return {};
  } });
  module.exports.registerSettingsIpc();
  return { db, seed, fail, writes, runtime, reads, oauthWrites, invalidations, invoke: (channel, ...args) => handlers.get(channel)({}, ...args),
    raw: () => db.db.prepare('SELECT * FROM mcp_servers ORDER BY name').all(),
  };
}
const input = { name: 'renamed', originalName: 'original', transport: 'stdio', command: 'synthetic-command', env: 'TOKEN=', headers: 'Authorization=', cwd: '/synthetic/workspace' };
const mutations = [
  ['add', 'upsertMcpServer', h => h.invoke('pi:add-mcp', input)],
  ['remove', 'removeMcpServer', h => h.invoke('pi:remove-mcp', 'original', '/synthetic/workspace')],
  ['enabled', 'setMcpEnabled', h => h.invoke('pi:set-mcp-enabled', { name: 'original', enabled: false, cwd: '/synthetic/workspace' })],
];

for (const [name, method, mutate] of mutations) {
  test(`${name}: synchronous post-write failure rolls the real SQLite transaction back`, async t => {
    const h = fixture(t), before = h.raw(); h.fail.afterWrite = method;
    await assert.rejects(mutate(h), /post-write failure/);
    assert.deepEqual(h.raw(), before); assert.equal(h.runtime.length, 0); assert.equal(h.reads.length, 0);
  });
  for (const failedPhase of ['runtime', 'settings']) {
    test(`${name}: ${failedPhase} failure after commit returns a safe committed projection and refresh performs zero config writes`, async t => {
      const h = fixture(t); h.fail[failedPhase] = true;
      const result = await mutate(h);
      assert.equal(result.committed, true); assert.equal(result.projection.status, 'error');
      assert.match(result.projection.message, /已保存/);
      assert.doesNotMatch(JSON.stringify(result), /private|synthetic-secret|Authorization=/);
      if (name === 'add') { assert.ok(h.db.getMcpServer('renamed')); assert.equal(h.db.getMcpServer('original'), undefined); }
      if (name === 'remove') assert.equal(h.db.getMcpServer('original'), undefined);
      if (name === 'enabled') assert.equal(h.db.getMcpServer('original').enabled, false);
      const writes = h.writes.length, committedRows = h.raw();
      await assert.rejects(h.invoke('pi:mcp-refresh', '/synthetic/workspace'), error => {
        assert.equal(error.message, 'MCP 刷新未完成，请稍后重试。'); return true;
      });
      h.fail[failedPhase] = false;
      const refreshed = await h.invoke('pi:mcp-refresh', '/synthetic/workspace');
      assert.equal(refreshed.runtimeRefresh.status, 'ready');
      assert.equal(h.writes.length, writes); assert.deepEqual(h.raw(), committedRows);
      assert.ok(h.runtime.every(cwd => cwd === '/synthetic/workspace'));
      assert.doesNotMatch(JSON.stringify(refreshed), /synthetic-secret|synthetic-header-secret/);
    });
  }
}

test('rename is atomic when deleting the old name fails after the new row was inserted', async t => {
  const h = fixture(t), before = h.raw();
  h.db.db.exec("CREATE TRIGGER fail_rename BEFORE DELETE ON mcp_servers WHEN OLD.name = 'original' BEGIN SELECT RAISE(ABORT, 'synthetic delete failure'); END;");
  await assert.rejects(h.invoke('pi:add-mcp', input), /synthetic delete failure/);
  assert.deepEqual(h.raw(), before); assert.equal(h.db.getMcpServer('renamed'), undefined);
  assert.equal(h.runtime.length, 0);
});

test('rename cannot overwrite an existing target and normalized namespace collisions remain blocked', async t => {
  const h = fixture(t); h.seed('occupied'); const before = h.raw();
  await assert.rejects(h.invoke('pi:add-mcp', { ...input, name: 'occupied' }), /已被使用/);
  assert.deepEqual(h.raw(), before);
  h.seed('tool-name'); const beforeCollision = h.raw();
  await assert.rejects(h.invoke('pi:add-mcp', { ...input, name: 'tool_name' }), /同一工具命名空间/);
  assert.deepEqual(h.raw(), beforeCollision);
});

test('successful committed projection preserves credential placeholders in main and excludes plaintext values', async t => {
  const h = fixture(t); const result = await h.invoke('pi:add-mcp', input);
  assert.equal(result.committed, true); assert.equal(result.projection.status, 'ready');
  assert.equal(h.db.getMcpServer('renamed', { includeSecrets: true }).env.TOKEN, 'synthetic-secret');
  assert.equal(h.db.getMcpServer('renamed', { includeSecrets: true }).headers.Authorization, 'synthetic-header-secret');
  assert.doesNotMatch(JSON.stringify(result), /synthetic-secret|synthetic-header-secret/);
});

test('read-only refresh rejects explicit runtime failures and failed-session counts without leaking their errors', async () => {
  const start = source.indexOf('async function readMcpSettingsWithRuntime(');
  const end = source.indexOf('async function committedMcpProjection(', start);
  const context = { pendingMcpOAuthInvalidations: new Map(), settingsWithRuntime: async () => context.snapshot };
  vm.runInNewContext(`${source.slice(start, end)}; globalThis.read = readMcpSettingsWithRuntime;`, context);
  for (const runtimeRefresh of [{ status: 'error' }, { status: 'ready', failedSessions: 1 }]) {
    context.snapshot = { runtimeRefresh: { ...runtimeRefresh, errors: ['secret'] } };
    await assert.rejects(context.read('/synthetic'), error => error.message === 'MCP 刷新未完成，请稍后重试。');
  }
  context.snapshot = { runtimeRefresh: { status: 'pending', failedSessions: 0 } };
  assert.equal(await context.read('/synthetic'), context.snapshot);
});


for (const action of ['start', 'logout']) {
  for (const phase of ['invalidate', 'runtime', 'settings']) {
    test(`OAuth ${action}: committed ${phase} failure is recoverable without touching credentials again`, async t => {
      const h = fixture(t), url = 'https://mcp.example.test/synthetic';
      h.db.upsertMcpServer({ name: 'oauth', transport: 'http', url, enabled: true });
      h.db.writeMcpOAuthState(url, { serverUrl: url, tokens: { access_token: 'previous-secret', token_type: 'Bearer' } });
      h.fail[phase] = true;
      const result = await h.invoke(`pi:mcp-oauth-${action}`, { name: 'oauth', cwd: '/original/workspace' });
      assert.equal(result.committed, true); assert.equal(result.projection.status, 'error');
      assert.doesNotMatch(JSON.stringify(result), /private|synthetic-secret|previous-secret/);
      const credential = h.db.readMcpOAuthState(url);
      if (action === 'start') assert.equal(credential.tokens.access_token, 'synthetic-secret');
      else assert.equal(credential, undefined);
      assert.deepEqual(h.oauthWrites, [action === 'start' ? 'authorize' : 'logout']);
      await assert.rejects(h.invoke('pi:mcp-refresh', '/original/workspace'), /MCP 刷新未完成/);
      h.fail[phase] = false;
      const snapshot = await h.invoke('pi:mcp-refresh', '/original/workspace');
      assert.equal(snapshot.runtimeRefresh.status, 'ready');
      assert.equal(h.oauthWrites.length, 1); assert.deepEqual(h.db.readMcpOAuthState(url), credential);
      assert.ok(h.runtime.every(cwd => cwd === '/original/workspace'));
      assert.doesNotMatch(JSON.stringify(snapshot), /synthetic-secret|previous-secret/);
      if (phase === 'invalidate') assert.equal(h.invalidations.length, 3);
    });
  }
  test(`OAuth ${action}: credential failure rejects safely before any runtime work`, async t => {
    const h = fixture(t), url = 'https://mcp.example.test/synthetic';
    h.db.upsertMcpServer({ name: 'oauth', transport: 'http', url, enabled: true });
    h.db.writeMcpOAuthState(url, { serverUrl: url, tokens: { access_token: 'previous-secret', token_type: 'Bearer' } });
    const before = h.db.readMcpOAuthState(url); h.fail.credential = true;
    await assert.rejects(h.invoke(`pi:mcp-oauth-${action}`, { name: 'oauth', cwd: '/original' }), error => {
      assert.doesNotMatch(error.message, /private|synthetic-secret/); return true;
    });
    assert.deepEqual(h.db.readMcpOAuthState(url), before); assert.equal(h.runtime.length, 0);
    assert.equal(h.invalidations.length, 0); assert.equal(h.oauthWrites.length, 0);
  });
}
