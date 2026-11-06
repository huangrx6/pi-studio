const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const vm = require('node:vm');
const test = require('node:test');

const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const tick = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
const SECRET = 'synthetic-credential-never-in-result';

function harness(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-studio-model-editor-'));
  const control = { encryptionAvailable: true, encryptFailure: false, fail: '', encryptions: 0, rebuilds: 0, providerWrites: 0, modelWrites: 0, credentialWrites: 0 };
  const originalLoad = Module._load;
  const safeStorage = {
    isEncryptionAvailable: () => control.encryptionAvailable,
    encryptString(value) { control.encryptions++; if (control.encryptFailure) throw new Error(SECRET); return Buffer.from(`protected:${value}`); },
    decryptString(value) { return Buffer.from(value).toString().slice('protected:'.length); },
  };
  Module._load = function (request, parent, isMain) { return request === 'electron' ? { safeStorage } : originalLoad.call(this, request, parent, isMain); };
  const { StudioDatabase } = require('../../electron/core/studio-db.cjs');
  const db = new StudioDatabase(path.join(directory, 'studio.sqlite'));
  t.after(() => { db.db.close(); Module._load = originalLoad; fs.rmSync(directory, { recursive: true, force: true }); });
  for (const [method, count] of [['upsertProvider', 'providerWrites'], ['upsertModel', 'modelWrites'], ['writeCredential', 'credentialWrites']]) {
    const original = db[method].bind(db); db[method] = (...args) => { control[count]++; return original(...args); };
  }

  // Load the real credential queue/store implementation, without building a
  // provider runtime or contacting a service. Runtime rebuilds are controlled IPC
  // dependencies below; all transaction/credential persistence uses real SQLite.
  const corePath = path.resolve(__dirname, '../../electron/core/studio-models.cjs');
  const coreModule = { exports: {} }, coreRequire = Module.createRequire(corePath);
  vm.runInNewContext(fs.readFileSync(corePath, 'utf8') + '\nmodule.exports.testCredentialStore = createCredentialStore;', {
    module: coreModule, exports: coreModule.exports,
    require(id) { if (id === './studio-db.cjs') return { getStudioDatabase: () => db }; if (id === './model-metadata.cjs') return {}; return coreRequire(id); },
  }, { filename: corePath });
  const credentials = coreModule.exports.testCredentialStore(db);
  const fail = stage => { if (control.fail === stage) throw new Error(`${stage}: ${SECRET}`); };
  const handlers = new Map();
  const ipcPath = path.resolve(__dirname, '../../electron/ipc/models.cjs'), ipcRequire = Module.createRequire(ipcPath), ipcModule = { exports: {} };
  const dependencies = {
    electron: { ipcMain: { handle: (name, action) => handlers.set(name, action) } },
    '../core/studio-db.cjs': { getStudioDatabase: () => db },
    '../core/app-settings.cjs': {}, '../core/context-policy.cjs': {},
    '../core/studio-models.cjs': {
      getStudioModelsRuntime: async () => ({ credentials }),
      rebuildStudioModels: async () => { control.rebuilds++; fail('rebuild'); },
      withProviderCredentialLock: coreModule.exports.withProviderCredentialLock,
      invalidateProviderCredentials: coreModule.exports.invalidateProviderCredentials,
    },
    '../services/models.cjs': { availableModels: async () => { fail('models'); return { models: db.listModels().map(row => ({ id: `${row.providerId}/${row.modelId}` })) }; } },
    '../services/settings.cjs': { settingsSnapshot: async cwd => { fail('settings'); return { cwd, providers: db.listProviders() }; } },
    '../core/state.cjs': { DEFAULT_CWD: '/synthetic/default' },
    '../core/model-metadata.cjs': {},
  };
  vm.runInNewContext(fs.readFileSync(ipcPath, 'utf8'), {
    module: ipcModule, exports: ipcModule.exports,
    require: id => Object.hasOwn(dependencies, id) ? dependencies[id] : ipcRequire(id),
  }, { filename: ipcPath });
  ipcModule.exports.registerModelsIpc();
  return { db, control, credentials, newCredentialStore: () => coreModule.exports.testCredentialStore(db), call: (name, ...args) => handlers.get(name)({}, ...args) };
}
const provider = extra => ({ providerId: 'gateway', name: 'Gateway', api: 'openai-completions', baseUrl: 'https://fixture.invalid/v1', cwd: '/synthetic/A', ...extra });
const plain = value => JSON.parse(JSON.stringify(value));
const noSecrets = value => assert.doesNotMatch(typeof value === 'string' ? value : JSON.stringify(value), new RegExp(SECRET));

test('provider configuration and encrypted API key commit together, with an explicit ready projection', async t => {
  const { db, call } = harness(t);
  const result = await call('pi:add-provider', provider({ apiKey: SECRET }));
  assert.equal(result.committed, true); assert.equal(result.projection.status, 'ready'); assert.equal(result.projection.value.settings.cwd, '/synthetic/A');
  assert.ok(result.projection.value.models); assert.equal(db.getProvider('gateway').name, 'Gateway');
  assert.deepEqual(db.readCredential('gateway'), { type: 'api_key', key: SECRET });
  const stored = JSON.parse(db.db.prepare('SELECT value FROM credentials WHERE provider_id = ?').get('gateway').value);
  assert.equal(stored.format, 'safeStorage-v1'); noSecrets(stored); noSecrets(result);
});

test('safeStorage and credential SQL failures roll back existing and newly inserted provider configuration', async t => {
  const { db, control, call } = harness(t);
  await call('pi:add-provider', provider({ apiKey: 'previous-key' })); const original = db.getProvider('gateway');
  for (const kind of ['unavailable', 'encryption', 'sql']) {
    control.encryptionAvailable = kind !== 'unavailable'; control.encryptFailure = kind === 'encryption';
    if (kind === 'sql') db.db.exec(`CREATE TRIGGER fail_credential BEFORE INSERT ON credentials BEGIN SELECT RAISE(ABORT, '${SECRET}'); END;`);
    for (const id of ['gateway', 'new-gateway']) {
      await assert.rejects(call('pi:add-provider', provider({ providerId: id, name: 'Must roll back', apiKey: SECRET })), error => {
        assert.match(error.message, /均未更改/); noSecrets(error.message); return true;
      });
      assert.deepEqual(db.getProvider('gateway'), original); assert.equal(db.getProvider('new-gateway'), undefined);
    }
    if (kind === 'sql') db.db.exec('DROP TRIGGER fail_credential');
  }
  control.encryptionAvailable = true; control.encryptFailure = false;
  assert.deepEqual(db.readCredential('gateway'), { type: 'api_key', key: 'previous-key' });
  assert.equal(db.readCredential('new-gateway'), undefined);
});

test('postcommit rebuild, models and settings failures return safe committed state; refresh retry performs zero resource writes', async t => {
  const { db, control, call } = harness(t);
  for (const stage of ['rebuild', 'models', 'settings']) {
    control.fail = stage;
    const result = await call('pi:add-provider', provider({ name: `Committed ${stage}`, apiKey: SECRET }));
    assert.equal(result.committed, true); assert.equal(result.projection.status, 'error'); assert.match(result.projection.message, /重试刷新/); noSecrets(result);
    assert.equal(db.getProvider('gateway').name, `Committed ${stage}`);
    const writes = [control.providerWrites, control.modelWrites, control.credentialWrites, control.encryptions];
    await assert.rejects(call('pi:models-refresh', '/synthetic/B'), error => { noSecrets(error.message); assert.equal(error.message, result.projection.message); return true; });
    control.fail = ''; const refreshed = await call('pi:models-refresh', '/synthetic/B');
    assert.equal(refreshed.settings.cwd, '/synthetic/B'); assert.ok(refreshed.models); noSecrets(refreshed);
    assert.deepEqual([control.providerWrites, control.modelWrites, control.credentialWrites, control.encryptions], writes);
  }
});

test('custom model saves have the same commit contract, preserve model metadata, and rollback SQL failures', async t => {
  const { db, control, call } = harness(t); await call('pi:add-provider', provider());
  const input = { providerId: 'gateway', modelId: 'reasoner', name: 'Reasoner', reasoning: true, thinkingLevels: ['low', 'high'], contextWindow: 128000, maxTokens: 8000, cwd: '/synthetic/A' };
  let result = await call('pi:add-custom-model', input);
  assert.equal(result.committed, true); assert.equal(result.projection.status, 'ready'); assert.ok(result.projection.value.models); assert.ok(result.projection.value.settings);
  assert.deepEqual(db.getModel('gateway', 'reasoner').thinkingLevels, ['low', 'high']);
  control.fail = 'rebuild'; result = await call('pi:add-custom-model', { ...input, name: 'Saved despite refresh failure' });
  assert.equal(result.projection.status, 'error'); assert.equal(db.getModel('gateway', 'reasoner').name, 'Saved despite refresh failure'); noSecrets(result);
  const original = db.getModel('gateway', 'reasoner');
  db.db.exec(`CREATE TRIGGER fail_model BEFORE INSERT ON model_catalog BEGIN SELECT RAISE(ABORT, '${SECRET}'); END;`);
  await assert.rejects(call('pi:add-custom-model', { ...input, name: 'Must roll back' }), error => { assert.match(error.message, /配置未更改/); noSecrets(error.message); return true; });
  assert.deepEqual(db.getModel('gateway', 'reasoner'), original);
});

test('provider saves serialize with credential modify across rebuilt stores, while other providers remain independent', async t => {
  const { db, credentials, newCredentialStore, call } = harness(t); await call('pi:add-provider', provider({ apiKey: 'old' }));
  const held = deferred(), entered = deferred(), events = [];
  const modifying = credentials.modify('gateway', async current => { events.push(current.key); entered.resolve(); await held.promise; return { type: 'api_key', key: 'refreshed-before-save' }; });
  await entered.promise;
  const saving = call('pi:add-provider', provider({ name: 'Queued save', apiKey: SECRET }));
  const later = newCredentialStore().modify('gateway', current => { events.push(current.key); return { type: 'api_key', key: 'later-write' }; });
  await tick(); assert.equal(db.getProvider('gateway').name, 'Gateway');
  await call('pi:add-provider', provider({ providerId: 'other', name: 'Independent', apiKey: 'other-key' }));
  assert.equal(db.getProvider('other').name, 'Independent');
  held.resolve(); await Promise.all([modifying, saving, later]);
  assert.deepEqual(events, ['old', SECRET]); assert.equal(db.getProvider('gateway').name, 'Queued save');
  assert.deepEqual(db.readCredential('gateway'), { type: 'api_key', key: 'later-write' });
});

test('empty API key retains credentials and a failed transaction releases the shared queue', async t => {
  const { db, control, credentials, call } = harness(t); await call('pi:add-provider', provider({ apiKey: 'keep-key' }));
  control.encryptFailure = true;
  await assert.rejects(call('pi:add-provider', provider({ apiKey: SECRET })));
  const before = control.encryptions;
  await call('pi:add-provider', provider({ name: 'No key replacement', apiKey: ' ' }));
  assert.equal(control.encryptions, before);
  control.encryptFailure = false; assert.deepEqual(db.readCredential('gateway'), { type: 'api_key', key: 'keep-key' });
  await credentials.delete('gateway'); assert.equal(db.readCredential('gateway'), undefined);
});

test('invalid provider input or missing model provider rejects before any resource write', async t => {
  const { control, call } = harness(t);
  await assert.rejects(call('pi:add-provider', provider({ modelsUrl: 'invalid', apiKey: SECRET })), /HTTP/);
  await assert.rejects(call('pi:add-custom-model', { providerId: 'missing', modelId: 'x' }), /请先创建/);
  assert.deepEqual(plain([control.providerWrites, control.modelWrites, control.credentialWrites, control.rebuilds]), [0, 0, 0, 0]);
});

test('delete, enable and import IPCs report committed projection failure and refresh without repeating writes', async t => {
  const cases = [
    ['pi:remove-provider', { providerId: 'gateway' }, db => assert.equal(db.getProvider('gateway'), undefined)],
    ['pi:remove-custom-model', { providerId: 'gateway', modelId: 'existing' }, db => assert.equal(db.getModel('gateway', 'existing'), undefined)],
    ['pi:import-provider-models', { providerId: 'gateway', models: [{ id: 'imported', name: 'Imported' }] }, db => assert.equal(db.getModel('gateway', 'imported').name, 'Imported')],
    ['pi:set-provider-enabled', { providerId: 'gateway', enabled: false }, db => assert.equal(db.getProvider('gateway').enabled, false)],
    ['pi:set-enabled-models', { models: [] }, db => assert.equal(db.getModel('gateway', 'existing').enabled, false)],
  ];
  for (const [method, input, verify] of cases) await t.test(method, async t => {
    const { db, control, call } = harness(t);
    await call('pi:add-provider', provider({ apiKey: SECRET })); db.upsertModel({ providerId: 'gateway', modelId: 'existing', enabled: true });
    control.fail = 'settings'; const result = await call(method, { ...input, cwd: '/synthetic/mutation' });
    assert.equal(result.committed, true); assert.equal(result.projection.status, 'error'); noSecrets(result); verify(db);
    const changes = () => db.db.prepare('SELECT total_changes() AS n').get().n;
    const before = changes(), encryptedBefore = control.encryptions;
    control.fail = ''; const refreshed = await call('pi:models-refresh', '/synthetic/retry');
    assert.equal(refreshed.settings.cwd, '/synthetic/retry'); assert.ok(refreshed.models);
    assert.equal(changes(), before); assert.equal(control.encryptions, encryptedBefore); verify(db);
  });
});

test('batch import rolls back earlier updates and inserts when a later row fails, retaining prior enablement and origin', async t => {
  const { db, control, call } = harness(t); await call('pi:add-provider', provider());
  db.upsertModel({ providerId: 'gateway', modelId: 'existing', name: 'Original', enabled: false, source: 'builtin', reasoning: true, thinkingLevels: ['low', 'high'] });
  const original = db.getModel('gateway', 'existing'), rebuilds = control.rebuilds;
  db.db.exec(`CREATE TRIGGER fail_import BEFORE INSERT ON model_catalog WHEN NEW.model_id = 'fail' BEGIN SELECT RAISE(ABORT, '${SECRET}'); END;`);
  const models = [{ id: 'existing', name: 'Changed' }, { id: 'inserted' }, { id: 'fail' }];
  await assert.rejects(call('pi:import-provider-models', { providerId: 'gateway', models }), error => { assert.match(error.message, /所选模型均未更改/); noSecrets(error.message); return true; });
  assert.deepEqual(db.getModel('gateway', 'existing'), original); assert.equal(db.getModel('gateway', 'inserted'), undefined); assert.equal(control.rebuilds, rebuilds);
  db.db.exec('DROP TRIGGER fail_import');
  const result = await call('pi:import-provider-models', { providerId: 'gateway', models });
  assert.equal(result.projection.status, 'ready'); const updated = db.getModel('gateway', 'existing');
  assert.equal(updated.name, 'Changed'); assert.equal(updated.enabled, false); assert.equal(updated.source, 'builtin'); assert.deepEqual(updated.thinkingLevels, ['low', 'high']);
  assert.equal(db.getModel('gateway', 'inserted').enabled, true);
});

test('provider deletion rolls back removed catalog, credentials and defaults on SQL failure', async t => {
  const { db, control, call } = harness(t); await call('pi:add-provider', provider({ apiKey: SECRET }));
  db.upsertModel({ providerId: 'gateway', modelId: 'existing' }); db.setSetting('studio.models.defaultModelRef', 'gateway/existing');
  const original = db.getModel('gateway', 'existing'), rebuilds = control.rebuilds;
  db.db.exec(`CREATE TRIGGER fail_provider_delete BEFORE DELETE ON model_providers BEGIN SELECT RAISE(ABORT, '${SECRET}'); END;`);
  await assert.rejects(call('pi:remove-provider', { providerId: 'gateway' }), error => { assert.match(error.message, /均未更改/); noSecrets(error.message); return true; });
  assert.ok(db.getProvider('gateway')); assert.deepEqual(db.getModel('gateway', 'existing'), original); assert.equal(db.readCredential('gateway').key, SECRET);
  assert.equal(db.getSetting('studio.models.defaultModelRef'), 'gateway/existing'); assert.equal(control.rebuilds, rebuilds);
  db.db.exec('DROP TRIGGER fail_provider_delete'); const result = await call('pi:remove-provider', { providerId: 'gateway' });
  assert.equal(result.projection.status, 'ready'); assert.equal(db.getModel('gateway', 'existing'), undefined); assert.equal(db.readCredential('gateway'), undefined);
});

test('model bulk enablement rolls back when its local result read fails; provider toggle errors remain uncommitted', async t => {
  const { db, control, call } = harness(t); await call('pi:add-provider', provider());
  db.upsertModel({ providerId: 'gateway', modelId: 'enabled', enabled: true }); db.upsertModel({ providerId: 'gateway', modelId: 'disabled', enabled: false });
  const originals = db.listModels(), rebuilds = control.rebuilds, read = db.listEnabledModels;
  db.listEnabledModels = () => { throw new Error(SECRET); };
  await assert.rejects(call('pi:set-enabled-models', { models: ['gateway/disabled'] }), error => { assert.match(error.message, /配置未更改/); noSecrets(error.message); return true; });
  db.listEnabledModels = read; assert.deepEqual(db.listModels(), originals); assert.equal(control.rebuilds, rebuilds);
  db.db.exec(`CREATE TRIGGER fail_provider_toggle BEFORE UPDATE ON model_providers BEGIN SELECT RAISE(ABORT, '${SECRET}'); END;`);
  await assert.rejects(call('pi:set-provider-enabled', { providerId: 'gateway', enabled: false }), error => { assert.match(error.message, /配置未更改/); noSecrets(error.message); return true; });
  assert.equal(db.getProvider('gateway').enabled, true); assert.equal(control.rebuilds, rebuilds);
});

test('provider deletion waits for active credential modification and queued late modification cannot recreate credentials', async t => {
  const { db, credentials, call } = harness(t); await call('pi:add-provider', provider({ apiKey: 'initial' }));
  const held = deferred(), entered = deferred(); let lateCalled = false;
  const first = credentials.modify('gateway', async () => { entered.resolve(); await held.promise; return { type: 'api_key', key: 'refreshed' }; });
  await entered.promise; const deletion = call('pi:remove-provider', { providerId: 'gateway' });
  const late = credentials.modify('gateway', () => { lateCalled = true; return { type: 'api_key', key: SECRET }; });
  const lateFailure = assert.rejects(late, /模型来源不存在/);
  await tick(); assert.ok(db.getProvider('gateway')); held.resolve(); await Promise.all([first, deletion, lateFailure]);
  assert.equal(lateCalled, false); assert.equal(db.getProvider('gateway'), undefined); assert.equal(db.readCredential('gateway'), undefined);
});

test('removing built-in models disables their row while configured models are deleted; missing deletions stay idempotent', async t => {
  const { db, call } = harness(t); await call('pi:add-provider', provider());
  db.upsertModel({ providerId: 'gateway', modelId: 'builtin', source: 'builtin', enabled: true });
  let result = await call('pi:remove-custom-model', { providerId: 'gateway', modelId: 'builtin' });
  assert.equal(result.committed, true); assert.equal(db.getModel('gateway', 'builtin').source, 'builtin'); assert.equal(db.getModel('gateway', 'builtin').enabled, false);
  result = await call('pi:remove-custom-model', { providerId: 'gateway', modelId: 'missing' }); assert.equal(result.projection.status, 'ready');
  result = await call('pi:remove-provider', { providerId: 'missing' }); assert.equal(result.projection.status, 'ready');
});

test('delete then recreate rejects an old queued credential operation but accepts a new operation for the recreated provider', async t => {
  const { db, credentials, newCredentialStore, call } = harness(t); await call('pi:add-provider', provider({ apiKey: 'original' }));
  const entered = deferred(), held = deferred(); let staleCalled = false;
  const active = credentials.modify('gateway', async () => { entered.resolve(); await held.promise; return { type: 'api_key', key: 'before-delete' }; });
  await entered.promise;
  const deletion = call('pi:remove-provider', { providerId: 'gateway' });
  const recreation = call('pi:add-provider', provider({ name: 'New identity', apiKey: 'recreated-key' }));
  const stale = newCredentialStore().modify('gateway', () => { staleCalled = true; return { type: 'api_key', key: SECRET }; });
  const rejected = assert.rejects(stale, /模型来源已变化/);
  held.resolve(); await Promise.all([active, deletion, recreation, rejected]);
  assert.equal(staleCalled, false); assert.equal(db.readCredential('gateway').key, 'recreated-key');
  await credentials.modify('gateway', () => ({ type: 'api_key', key: 'valid-new-operation' }));
  assert.equal(db.readCredential('gateway').key, 'valid-new-operation');
});

test('failed deletion does not invalidate a credential operation already queued behind it', async t => {
  const { db, credentials, call } = harness(t); await call('pi:add-provider', provider({ apiKey: 'original' }));
  const entered = deferred(), held = deferred();
  const active = credentials.modify('gateway', async () => { entered.resolve(); await held.promise; return undefined; });
  await entered.promise;
  db.db.exec(`CREATE TRIGGER fail_delete_epoch BEFORE DELETE ON model_providers BEGIN SELECT RAISE(ABORT, '${SECRET}'); END;`);
  const deletion = call('pi:remove-provider', { providerId: 'gateway' }); const rejected = assert.rejects(deletion, /均未更改/);
  const queued = credentials.modify('gateway', () => ({ type: 'api_key', key: 'valid-after-failed-delete' }));
  held.resolve(); await Promise.all([active, rejected, queued]);
  assert.equal(db.readCredential('gateway').key, 'valid-after-failed-delete'); assert.ok(db.getProvider('gateway'));
});

test('an old queued delete-key cannot clear credentials belonging to a recreated provider', async t => {
  const { db, credentials, call } = harness(t); await call('pi:add-provider', provider({ apiKey: 'original' }));
  const entered = deferred(), held = deferred();
  const active = credentials.modify('gateway', async () => { entered.resolve(); await held.promise; return undefined; });
  await entered.promise;
  const deletion = call('pi:remove-provider', { providerId: 'gateway' });
  const recreation = call('pi:add-provider', provider({ apiKey: 'recreated-key' }));
  const staleDeletion = call('pi:delete-key', { providerId: 'gateway' });
  const rejected = assert.rejects(staleDeletion, /模型来源已变化，凭据未清除/);
  await tick(); held.resolve(); await Promise.all([active, deletion, recreation, rejected]);
  assert.equal(db.readCredential('gateway').key, 'recreated-key');
  await call('pi:delete-key', { providerId: 'gateway' }); assert.equal(db.readCredential('gateway'), undefined);
});

test('standalone credential set and delete return committed projections and preserve requested projection cwd', async t => {
  const { db, call } = harness(t);
  await call('pi:add-provider', provider({ apiKey: 'before' }));
  const saved = await call('pi:set-key', { providerId: 'gateway', apiKey: ` ${SECRET} `, cwd: '/synthetic/key-editor' });
  assert.equal(saved.committed, true); assert.equal(saved.projection.status, 'ready');
  assert.equal(saved.projection.value.settings.cwd, '/synthetic/key-editor');
  assert.equal(db.readCredential('gateway').key, SECRET); noSecrets(saved);
  const removed = await call('pi:delete-key', { providerId: 'gateway' });
  assert.equal(removed.committed, true); assert.equal(removed.projection.status, 'ready');
  assert.equal(removed.projection.value.settings.cwd, '/synthetic/default');
  assert.equal(db.readCredential('gateway'), undefined); noSecrets(removed);
});

test('standalone credential commit survives all projection failures; refresh retries never rewrite or re-encrypt', async t => {
  for (const method of ['pi:set-key', 'pi:delete-key']) for (const stage of ['rebuild', 'models', 'settings']) {
    await t.test(`${method} / ${stage}`, async t => {
      const { db, control, call } = harness(t);
      await call('pi:add-provider', provider({ apiKey: 'before' }));
      control.fail = stage;
      const result = await call(method, { providerId: 'gateway', apiKey: SECRET, cwd: '/synthetic/credential' });
      assert.equal(result.committed, true); assert.equal(result.projection.status, 'error'); noSecrets(result);
      const verify = () => method === 'pi:set-key'
        ? assert.equal(db.readCredential('gateway').key, SECRET)
        : assert.equal(db.readCredential('gateway'), undefined);
      verify();
      const writes = () => [db.db.prepare('SELECT total_changes() AS n').get().n, control.encryptions];
      const before = writes();
      await assert.rejects(call('pi:models-refresh', '/synthetic/retry'), error => { noSecrets(error.message); return true; });
      control.fail = '';
      const projection = await call('pi:models-refresh', '/synthetic/retry');
      assert.equal(projection.settings.cwd, '/synthetic/retry'); noSecrets(projection);
      assert.deepEqual(writes(), before); verify();
    });
  }
});

test('standalone credential precommit failures reject safely and leave the stored credential unchanged', async t => {
  const { db, control, call } = harness(t);
  await call('pi:add-provider', provider({ apiKey: 'before' }));
  const rebuilds = control.rebuilds;
  control.encryptFailure = true;
  await assert.rejects(call('pi:set-key', { providerId: 'gateway', apiKey: SECRET }), error => {
    assert.match(error.message, /凭据保存失败，凭据未更改/); noSecrets(error.message); return true;
  });
  control.encryptFailure = false;
  db.db.exec(`CREATE TRIGGER fail_key_delete BEFORE DELETE ON credentials BEGIN SELECT RAISE(ABORT, '${SECRET}'); END;`);
  await assert.rejects(call('pi:delete-key', { providerId: 'gateway' }), error => {
    assert.match(error.message, /凭据清除失败，凭据未更改/); noSecrets(error.message); return true;
  });
  assert.equal(db.readCredential('gateway').key, 'before');
  assert.equal(control.rebuilds, rebuilds, 'uncommitted failures must not start projection recovery');
  db.db.exec('DROP TRIGGER fail_key_delete');
  await call('pi:delete-key', { providerId: 'gateway' });
  assert.equal(db.readCredential('gateway'), undefined, 'failure releases the credential queue for explicit retry');
});

test('an old queued set-key still rejects after provider recreation without leaking its submitted credential', async t => {
  const { db, credentials, call } = harness(t);
  await call('pi:add-provider', provider({ apiKey: 'original' }));
  const entered = deferred(), held = deferred();
  const active = credentials.modify('gateway', async () => { entered.resolve(); await held.promise; return undefined; });
  await entered.promise;
  const deletion = call('pi:remove-provider', { providerId: 'gateway' });
  const recreation = call('pi:add-provider', provider({ apiKey: 'recreated-key' }));
  const stale = call('pi:set-key', { providerId: 'gateway', apiKey: SECRET });
  const rejected = assert.rejects(stale, error => {
    assert.match(error.message, /模型来源已变化，凭据未写入/); noSecrets(error.message); return true;
  });
  await tick(); held.resolve(); await Promise.all([active, deletion, recreation, rejected]);
  assert.equal(db.readCredential('gateway').key, 'recreated-key');
  const fresh = await call('pi:set-key', { providerId: 'gateway', apiKey: 'fresh-request' });
  assert.equal(fresh.projection.status, 'ready'); assert.equal(db.readCredential('gateway').key, 'fresh-request');
});
