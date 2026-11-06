const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const { spawnSync } = require('node:child_process');
const { test, after } = require('node:test');
const { installElectronSafeStorage } = require('./helpers/electron-safe-storage.cjs');

const userRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-uninstall-transaction-'));
process.env.PI_STUDIO_DB = path.join(userRoot, 'studio.sqlite');
installElectronSafeStorage({ after });
const originalLoad = Module._load;
Module._load = function(request, parent, isMain) {
  if (request === 'electron') return { app: { getPath: () => userRoot } };
  return originalLoad.call(this, request, parent, isMain);
};
const studio = require('../../electron/services/studio-extensions.cjs');
Module._load = originalLoad;
const { getStudioDatabase } = require('../../electron/core/studio-db.cjs');
const {
  ExtensionDistributionService,
  removeManagedExtensionPaths,
} = require('../../electron/services/extension-distribution.cjs');
after(() => fs.rmSync(userRoot, { recursive: true, force: true }));
let nextId = 0;

async function fixture(t, managed = true) {
  const root = fs.mkdtempSync(path.join(userRoot, 'case-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cwd = path.join(root, 'workspace'), source = path.join(root, 'source');
  fs.mkdirSync(cwd); fs.mkdirSync(source);
  const id = `uninstall.fixture${++nextId}`, stableId = `project:${id}`;
  fs.writeFileSync(path.join(source, 'pi-studio.extension.json'), JSON.stringify({
    format: 1, id, version: '1.0.0', name: 'Uninstall fixture', publisher: 'synthetic-qa', license: 'MIT', permissions: [], contributes: {},
  }));
  fs.writeFileSync(path.join(source, 'original.txt'), 'original code');
  const service = studio.extensionDistributionService();
  let installed;
  if (managed) {
    const preview = await service.prepare(source, { scope: 'project', cwd });
    installed = await service.installPrepared(preview.token, { scope: 'project', cwd });
  } else studio.importStudioExtension(source, 'project', cwd);
  studio.syncStudioExtensions(cwd);
  const db = getStudioDatabase();
  t.after(() => db.removeExtension(stableId));
  const code = path.join(cwd, '.pi-studio', 'extensions', id);
  const state = managed ? service.stateFile('project', cwd, id) : null;
  if (installed) fs.writeFileSync(path.join(installed.dataPath, 'keep.txt'), 'original data');
  return { root, cwd, id, stableId, service, db, installed, code, state };
}
function tombstones(parent) { return fs.readdirSync(parent).filter(name => name.startsWith('.uninstall-')); }

function directInstall(root, id) {
  root = fs.realpathSync(root);
  const code = path.join(root, 'extensions', id, '1.0.0');
  const stateDirectory = path.join(root, 'extension-state', 'user');
  const state = path.join(stateDirectory, `${id}.json`);
  const data = path.join(root, 'extension-data', 'user', id);
  fs.mkdirSync(code, { recursive: true });
  fs.mkdirSync(stateDirectory, { recursive: true });
  fs.mkdirSync(data, { recursive: true });
  fs.writeFileSync(path.join(code, 'pi-studio.extension.json'), JSON.stringify({
    format: 1,
    id,
    version: '1.0.0',
    name: 'Crash fixture',
  }));
  fs.writeFileSync(path.join(code, 'original.txt'), 'original code');
  fs.writeFileSync(path.join(data, 'keep.txt'), 'original data');
  fs.writeFileSync(state, JSON.stringify({
    schemaVersion: 1,
    id,
    scope: 'user',
    dataPath: data,
    activeHistoryIndex: 0,
    history: [{
      version: '1.0.0',
      codePath: code,
      sha256: '0'.repeat(64),
      requires: [],
    }],
    installedAt: 1,
    updatedAt: 1,
  }));
  return { code, state, data };
}

function crashAfterStaging(root, id) {
  const distributionModule = require.resolve('../../electron/services/extension-distribution.cjs');
  const source = `
    const { createExtensionDistributionService } = require(${JSON.stringify(distributionModule)});
    const service = createExtensionDistributionService({
      userDataPath: process.argv[1],
      fetchImpl: async () => { throw new Error('unused'); },
    });
    service.uninstall(${JSON.stringify(id)}, {
      scope: 'user',
      commit() { process.exit(73); },
    }).catch(error => { console.error(error); process.exit(2); });
  `;
  return spawnSync(process.execPath, ['-e', source, root], { encoding: 'utf8' });
}

function distributionFor(root, installed) {
  return new ExtensionDistributionService({
    userDataPath: root,
    fetchImpl: async () => { throw new Error('unused'); },
    isExtensionInstalled: () => installed,
  });
}

for (const managed of [false, true]) {
  test(`${managed ? 'managed' : 'bare'} uninstall rolls back files and a real SQLite deletion when metadata commit fails`, async t => {
    const f = await fixture(t, managed);
    const original = f.db.removeExtension;
    f.db.removeExtension = function(id) { original.call(this, id); if (id === f.stableId) throw new Error('injected metadata failure after DELETE'); };
    try { await assert.rejects(studio.removeStudioExtension(f.stableId, f.cwd, { preserveData: false }), /metadata failure/); }
    finally { f.db.removeExtension = original; }
    assert.ok(f.db.getExtension(f.stableId), 'SQLite transaction restores metadata');
    assert.equal(fs.readFileSync(path.join(managed ? f.installed.activeCodePath : f.code, 'original.txt'), 'utf8'), 'original code');
    assert.equal(tombstones(path.dirname(f.code)).length, 0);
    if (managed) {
      assert.equal(f.service.getInstalled(f.id, 'project', f.cwd).version, '1.0.0');
      assert.equal(fs.readFileSync(path.join(f.installed.dataPath, 'keep.txt'), 'utf8'), 'original data');
      assert.ok(fs.existsSync(f.state));
    }
    const result = await studio.removeStudioExtension(f.stableId, f.cwd);
    assert.equal(result.removed, true); assert.equal(f.db.getExtension(f.stableId), undefined); assert.equal(fs.existsSync(f.code), false);
    if (managed) assert.equal(fs.readFileSync(path.join(f.installed.dataPath, 'keep.txt'), 'utf8'), 'original data');
  });

  test(`${managed ? 'managed' : 'bare'} postcommit cleanup failure preserves success and cannot resurrect a hidden tombstone`, async t => {
    const f = await fixture(t, managed), original = fs.rmSync;
    let failed = 0;
    fs.rmSync = function(target, options) {
      if (path.basename(String(target)).startsWith('.uninstall-')) { failed++; throw new Error('injected cleanup failure'); }
      return original.call(this, target, options);
    };
    let result;
    try { result = await studio.removeStudioExtension(f.stableId, f.cwd); }
    finally { fs.rmSync = original; }
    assert.equal(result.removed, true); assert.ok(failed > 0); assert.equal(fs.existsSync(f.code), false);
    assert.equal(f.db.getExtension(f.stableId), undefined);
    assert.ok(tombstones(path.dirname(f.code)).length);
    studio.syncStudioExtensions(f.cwd);
    assert.equal(f.db.getExtension(f.stableId), undefined, 'hidden original manifest is not imported again');
    if (managed) assert.equal(f.service.getInstalled(f.id, 'project', f.cwd), undefined);
  });
}

for (const stage of ['state', 'data']) {
  test(`failed ${stage} rename restores earlier staged paths before metadata mutation`, async t => {
    const f = await fixture(t), original = fs.renameSync;
    let commitCalls = 0;
    const failPath = stage === 'state' ? f.state : f.installed.dataPath;
    fs.renameSync = function(source, target) {
      if (path.resolve(source) === path.resolve(failPath)) throw new Error(`injected ${stage} staging failure`);
      return original.call(this, source, target);
    };
    try {
      await assert.rejects(f.service.uninstall(f.id, { scope: 'project', cwd: f.cwd, preserveData: false, commit() { commitCalls++; } }), /staging failure/);
    } finally { fs.renameSync = original; }
    assert.equal(commitCalls, 0); assert.ok(f.db.getExtension(f.stableId));
    assert.equal(f.service.getInstalled(f.id, 'project', f.cwd).version, '1.0.0');
    assert.equal(fs.readFileSync(path.join(f.installed.dataPath, 'keep.txt'), 'utf8'), 'original data');
    assert.equal(tombstones(path.dirname(f.code)).length, 0);
  });
}

test('rollback never overwrites a replacement created at the original path', t => {
  const root = fs.mkdtempSync(path.join(userRoot, 'replace-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const target = path.join(root, 'extension'); fs.mkdirSync(target); fs.writeFileSync(path.join(target, 'original'), 'old');
  assert.throws(() => removeManagedExtensionPaths([{ target, boundary: root }], () => {
    fs.mkdirSync(target); fs.writeFileSync(path.join(target, 'replacement'), 'user files');
    throw new Error('metadata failed');
  }), error => error.code === 'TRANSACTION_RECOVERY_FAILED');
  assert.equal(fs.readFileSync(path.join(target, 'replacement'), 'utf8'), 'user files');
  const [hidden] = tombstones(root); assert.equal(fs.readFileSync(path.join(root, hidden, 'original'), 'utf8'), 'old');
});

test('postcommit cleanup never removes a replacement at either original or tombstone path', t => {
  const root = fs.mkdtempSync(path.join(userRoot, 'replace-cleanup-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const target = path.join(root, 'extension'); fs.mkdirSync(target); fs.writeFileSync(path.join(target, 'original'), 'old');
  removeManagedExtensionPaths([{ target, boundary: root }], () => {
    const hidden = path.join(root, tombstones(root)[0]);
    fs.renameSync(hidden, path.join(root, 'saved-original'));
    fs.mkdirSync(hidden); fs.writeFileSync(path.join(hidden, 'replacement'), 'hidden replacement');
    fs.mkdirSync(target); fs.writeFileSync(path.join(target, 'replacement'), 'original replacement');
  });
  assert.equal(fs.readFileSync(path.join(target, 'replacement'), 'utf8'), 'original replacement');
  assert.equal(fs.readFileSync(path.join(root, tombstones(root)[0], 'replacement'), 'utf8'), 'hidden replacement');
  assert.equal(fs.readFileSync(path.join(root, 'saved-original', 'original'), 'utf8'), 'old');
});

test('dangling symlinks and symlinked parents are rejected before staging or metadata commit', t => {
  const root = fs.mkdtempSync(path.join(userRoot, 'symlinks-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const outside = path.join(root, 'outside'), boundary = path.join(root, 'managed'); fs.mkdirSync(outside); fs.mkdirSync(boundary);
  fs.writeFileSync(path.join(outside, 'keep'), 'keep');
  const dangling = path.join(boundary, 'dangling'); fs.symlinkSync(path.join(root, 'missing'), dangling);
  fs.symlinkSync(outside, path.join(boundary, 'linked'));
  let committed = false;
  for (const target of [dangling, path.join(boundary, 'linked', 'keep'), outside]) {
    assert.throws(() => removeManagedExtensionPaths([{ target, boundary }], () => { committed = true; }), error => error.code === 'UNSAFE_MANAGED_PATH');
  }
  assert.equal(committed, false); assert.equal(fs.readFileSync(path.join(outside, 'keep'), 'utf8'), 'keep');
  assert.equal(fs.lstatSync(dangling).isSymbolicLink(), true);
});

test('an actual SQLite COMMIT rejection restores DB metadata and every staged managed path', async t => {
  const f = await fixture(t), originalRemove = f.db.removeExtension, originalExec = f.db.db.exec;
  let removing = false, commits = 0;
  f.db.removeExtension = function(id) { originalRemove.call(this, id); if (id === f.stableId) removing = true; };
  f.db.db.exec = function(sql) {
    if (removing && sql === 'COMMIT') { commits++; throw new Error('injected SQLite COMMIT failure'); }
    return originalExec.call(this, sql);
  };
  try { await assert.rejects(studio.removeStudioExtension(f.stableId, f.cwd, { preserveData: false }), /SQLite COMMIT failure/); }
  finally { f.db.removeExtension = originalRemove; f.db.db.exec = originalExec; }
  assert.equal(commits, 1); assert.ok(f.db.getExtension(f.stableId));
  assert.equal(f.service.getInstalled(f.id, 'project', f.cwd).version, '1.0.0');
  assert.equal(fs.readFileSync(path.join(f.installed.dataPath, 'keep.txt'), 'utf8'), 'original data');
  assert.equal(tombstones(path.dirname(f.code)).length, 0);
});

test('cleanup does not traverse a parent replaced with an external symlink after commit', t => {
  const root = fs.mkdtempSync(path.join(userRoot, 'parent-replacement-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const parent = path.join(root, 'managed'), outside = path.join(root, 'outside');
  fs.mkdirSync(parent); fs.mkdirSync(outside);
  const target = path.join(parent, 'extension'); fs.mkdirSync(target); fs.writeFileSync(path.join(target, 'original'), 'old');
  let hidden;
  removeManagedExtensionPaths([{ target, boundary: root }], () => {
    hidden = tombstones(parent)[0];
    fs.renameSync(parent, path.join(root, 'saved-managed'));
    fs.mkdirSync(path.join(outside, hidden)); fs.writeFileSync(path.join(outside, hidden, 'keep'), 'user replacement');
    fs.symlinkSync(outside, parent);
  });
  assert.equal(fs.readFileSync(path.join(outside, hidden, 'keep'), 'utf8'), 'user replacement');
  assert.equal(fs.readFileSync(path.join(root, 'saved-managed', hidden, 'original'), 'utf8'), 'old');
});

test('bare uninstall accepts an explicit workspace alias while preserving managed-child symlink checks', async t => {
  const f = await fixture(t, false), alias = path.join(f.root, 'workspace-alias');
  fs.symlinkSync(f.cwd, alias);
  const result = await studio.removeStudioExtension(f.stableId, alias);
  assert.equal(result.removed, true); assert.equal(fs.existsSync(f.code), false); assert.equal(f.db.getExtension(f.stableId), undefined);
  assert.equal(fs.lstatSync(alias).isSymbolicLink(), true);
});

for (const installed of [true, false]) {
  test(`restart ${installed ? 'rolls back' : 'finishes cleanup of'} a crash between staging and metadata commit`, t => {
    const root = fs.mkdtempSync(path.join(userRoot, `crash-${installed}-`));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const id = `crash.fixture.${installed}`;
    const files = directInstall(root, id);
    const child = crashAfterStaging(root, id);
    assert.equal(child.status, 73, child.stderr);
    const journalRoot = path.join(root, 'extension-state', '.uninstall-journal');
    assert.equal(fs.readdirSync(journalRoot).filter(name => name.endsWith('.json')).length, 1);
    assert.equal(fs.existsSync(files.code), false);
    assert.equal(fs.existsSync(files.state), false);

    const service = distributionFor(root, installed);
    assert.deepEqual(service.recoverPendingUninstalls(), []);
    assert.deepEqual(service.recoverPendingUninstalls(), []);
    assert.equal(fs.readdirSync(journalRoot).filter(name => name.endsWith('.json')).length, 0);
    if (installed) {
      assert.equal(fs.readFileSync(path.join(files.code, 'original.txt'), 'utf8'), 'original code');
      assert.equal(fs.readFileSync(path.join(files.data, 'keep.txt'), 'utf8'), 'original data');
      assert.equal(service.getInstalled(id, 'user').version, '1.0.0');
    } else {
      assert.equal(fs.existsSync(files.code), false);
      assert.equal(fs.existsSync(files.state), false);
      assert.equal(service.getInstalled(id, 'user'), undefined);
    }
  });
}

test('restart recovery preserves a replacement at an interrupted tombstone', t => {
  const root = fs.mkdtempSync(path.join(userRoot, 'crash-replacement-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const id = 'crash.fixture.replaced';
  directInstall(root, id);
  const child = crashAfterStaging(root, id);
  assert.equal(child.status, 73, child.stderr);
  const journalRoot = path.join(root, 'extension-state', '.uninstall-journal');
  const [journalName] = fs.readdirSync(journalRoot).filter(name => name.endsWith('.json'));
  const journalFile = path.join(journalRoot, journalName);
  const journal = JSON.parse(fs.readFileSync(journalFile, 'utf8'));
  const entry = journal.entries.find(item => item.target.endsWith(`${id}.json`));
  fs.renameSync(entry.tombstone, `${entry.tombstone}.saved`);
  fs.writeFileSync(entry.tombstone, 'user replacement');

  const errors = distributionFor(root, false).recoverPendingUninstalls();
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /恢复未完成/);
  assert.equal(fs.readFileSync(entry.tombstone, 'utf8'), 'user replacement');
  assert.ok(fs.existsSync(journalFile));
});
