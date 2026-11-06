const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const vm = require('node:vm');
const test = require('node:test');

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-studio-skill-commit-'));
const oldUserData = process.env.PI_STUDIO_USER_DATA, oldDatabase = process.env.PI_STUDIO_DB;
process.env.PI_STUDIO_USER_DATA = path.join(temporary, 'user-data');
process.env.PI_STUDIO_DB = path.join(temporary, 'studio.sqlite');
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'node:os') return { ...os, homedir: () => path.join(temporary, 'isolated-home') };
  if (request === 'electron') return { safeStorage: { isEncryptionAvailable: () => true, encryptString: value => Buffer.from(value), decryptString: value => value.toString() } };
  return originalLoad.call(this, request, parent, isMain);
};
const { getStudioDatabase, closeStudioDatabase } = require('../../electron/core/studio-db.cjs');
const skills = require('../../electron/capabilities/skills/index.cjs');
const cleanup = require('../../electron/capabilities/skills/cleanup.cjs');
const workspace = path.join(temporary, 'project'); fs.mkdirSync(workspace, { recursive: true });
test.after(() => {
  closeStudioDatabase(); Module._load = originalLoad;
  if (oldUserData === undefined) delete process.env.PI_STUDIO_USER_DATA; else process.env.PI_STUDIO_USER_DATA = oldUserData;
  if (oldDatabase === undefined) delete process.env.PI_STUDIO_DB; else process.env.PI_STUDIO_DB = oldDatabase;
  fs.rmSync(temporary, { recursive: true, force: true });
});
function writeSkill(directory, name, version = '1.0.0') {
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'SKILL.md'), `---\nname: ${name}\ndescription: Synthetic commit fixture\nmetadata:\n  version: ${version}\n---\nVersion ${version}\n`);
}
async function prepared(name, scope = 'project', version = '1.0.0') {
  const root = path.join(temporary, `source-${name}`), directory = path.join(root, name); writeSkill(directory, name, version);
  const source = skills.listSkillSources().find(source => source.location === root) || skills.saveSkillSource({ name, type: 'directory', location: root });
  await skills.refreshSkillCatalog();
  return skills.prepareSkillInstall({ sourceId: source.id, listingId: `directory:${name}`, scope, cwd: workspace });
}
function ipcHarness() {
  const calls = [], state = { fail: '', selected: '', canceled: false };
  const failure = phase => { if (state.fail === phase) throw new Error('raw-private-diagnostic'); };
  const source = fs.readFileSync(path.resolve(__dirname, '../../electron/ipc/settings.cjs'), 'utf8'), handlers = new Map(), module = { exports: {} };
  const dependencies = {
    electron: { ipcMain: { handle: (key, fn) => handlers.set(key, fn) }, dialog: { showOpenDialog: async () => ({ canceled: state.canceled, filePaths: [state.selected] }) }, webContents: { getAllWebContents: () => [{ isDestroyed: () => false, send() { failure('notify'); } }] } },
    '../core/state.cjs': { DEFAULT_CWD: workspace }, '../core/studio-db.cjs': { getStudioDatabase },
    '../runtime/durable-runtime.cjs': { refreshExtensionRuntime: async () => { failure('runtime'); } },
    '../services/settings.cjs': { settingsSnapshot: async cwd => { failure('snapshot'); return { cwd, skills: skills.discoverSkills(cwd).skills }; } },
    '../services/extension-install-recovery.cjs': { createExtensionInstallRecovery: () => ({}) },
    '../capabilities/skills/index.cjs': { ...skills, ...Object.fromEntries(['importSkill', 'removeSkill', 'setSkillTrusted', 'installPreparedSkill'].map(name => [name, (...args) => { calls.push({ name, args }); return skills[name](...args); }])) },
  };
  vm.runInNewContext(source, { module, exports: module.exports, require: id => dependencies[id] || (id.startsWith('node:') ? require(id) : {}) });
  module.exports.registerSettingsIpc();
  return { calls, state, call: (name, ...args) => handlers.get(name)({}, ...args) };
}

test('skill IPCs preserve committed state when notify/runtime/snapshot fails and retry never repeats the mutation', async () => {
  const h = ipcHarness(); let index = 0;
  for (const phase of ['notify', 'runtime', 'snapshot']) {
    for (const kind of ['add', 'install', 'trust', 'remove']) {
      const name = `fixture-${index++}`; let invocation;
      if (kind === 'add') {
        const directory = path.join(temporary, `import-${name}`); writeSkill(directory, name); h.state.selected = directory;
        invocation = () => h.call('pi:add-skill', { scope: 'project', cwd: workspace });
      } else {
        const preview = await prepared(name);
        if (kind === 'install') invocation = () => h.call('pi:install-prepared-skill', { token: preview.token, cwd: workspace });
        else {
          const installed = skills.installPreparedSkill({ token: preview.token, cwd: workspace });
          invocation = kind === 'trust' ? () => h.call('pi:skill-trust', { path: installed.path, trusted: true, cwd: workspace }) : () => h.call('pi:remove-skill', installed.path, workspace);
        }
      }
      h.state.fail = phase; const result = await invocation();
      assert.equal(result.committed, true); assert.equal(result.projection.status, 'error'); assert.doesNotMatch(JSON.stringify(result), /raw-private-diagnostic/);
      if (kind === 'install') assert.equal(result.installed.name, name);
      const writes = h.calls.length;
      await assert.rejects(h.call('pi:skills-refresh', workspace), /技能运行时与列表刷新未完成/);
      h.state.fail = ''; const refreshed = await h.call('pi:skills-refresh', workspace);
      assert.equal(refreshed.cwd, workspace); assert.equal(h.calls.length, writes);
      const found = refreshed.skills.find(skill => skill.name === name);
      if (kind === 'remove') assert.equal(found, undefined);
      else { assert.ok(found); assert.equal(found.available, kind === 'trust'); }
    }
  }
});

test('cancelled folder pick and validation failures do not report a committed mutation', async () => {
  const h = ipcHarness(); h.state.canceled = true;
  assert.equal(await h.call('pi:add-skill', { scope: 'project', cwd: workspace }), undefined); assert.equal(h.calls.length, 0);
  await assert.rejects(h.call('pi:skill-trust', { path: path.join(temporary, 'outside', 'SKILL.md'), trusted: true, cwd: workspace }), /只能信任/);
  await assert.rejects(h.call('pi:install-prepared-skill', { token: 'missing-token' }), /重新预览/);
});

test('removal restores original files and both metadata records if its database transaction fails', async t => {
  const preview = await prepared('remove-rollback'), installed = skills.installPreparedSkill({ token: preview.token, cwd: workspace });
  skills.setSkillTrusted(installed.path, workspace, true);
  const db = getStudioDatabase(), receipt = db.getSkillInstallation(installed.baseDir);
  db.db.exec("CREATE TRIGGER fail_skill_remove BEFORE DELETE ON project_resource_trust BEGIN SELECT RAISE(ABORT, 'fixture'); END;");
  t.after(() => db.db.exec('DROP TRIGGER IF EXISTS fail_skill_remove'));
  assert.throws(() => skills.removeSkill(installed.path, workspace), /fixture/);
  assert.ok(fs.existsSync(installed.path)); assert.deepEqual(db.getSkillInstallation(installed.baseDir), receipt);
  assert.equal(skills.discoverSkills(workspace).skills.find(skill => skill.name === 'remove-rollback').available, true);
});

test('trust result read and installation receipt read failures roll back their writes', async t => {
  const preview = await prepared('receipt-rollback'), db = getStudioDatabase();
  const readReceipt = db.getSkillInstallation; db.getSkillInstallation = () => { throw new Error('receipt read failed'); };
  assert.throws(() => skills.installPreparedSkill({ token: preview.token, cwd: workspace }), /receipt read failed/); db.getSkillInstallation = readReceipt;
  const target = path.join(workspace, '.pi-studio', 'skills', 'receipt-rollback'); assert.equal(fs.existsSync(target), false); assert.equal(db.getSkillInstallation(target), undefined);
  const installed = skills.installPreparedSkill({ token: preview.token, cwd: workspace });
  const readTrust = db.getProjectResourceTrust; db.getProjectResourceTrust = (...args) => { const value = readTrust.apply(db, args); if (value?.trusted) throw new Error('trust read failed'); return value; };
  t.after(() => { db.getSkillInstallation = readReceipt; db.getProjectResourceTrust = readTrust; });
  assert.throws(() => skills.setSkillTrusted(installed.path, workspace, true), /trust read failed/); db.getProjectResourceTrust = readTrust;
  assert.equal(skills.discoverSkills(workspace).skills.find(skill => skill.name === 'receipt-rollback').available, false);
});

test('postcommit cleanup failure consumes install token and retries only registered unchanged directories', async t => {
  let preview = await prepared('cleanup-fixture'); const first = skills.installPreparedSkill({ token: preview.token, cwd: workspace });
  preview = await prepared('cleanup-fixture', 'project', '2.0.0');
  const originalRemove = fs.rmSync, failed = new Set();
  fs.rmSync = (directory, options) => { if (String(directory).includes('.backup') || String(directory).includes('skill-prepared')) { failed.add(String(directory)); throw new Error('cleanup denied'); } return originalRemove(directory, options); };
  t.after(() => { fs.rmSync = originalRemove; });
  const updated = skills.installPreparedSkill({ token: preview.token, cwd: workspace });
  assert.equal(updated.version, '2.0.0'); assert.match(fs.readFileSync(first.path, 'utf8'), /2.0.0/); assert.throws(() => skills.installPreparedSkill({ token: preview.token, cwd: workspace }), /重新预览/);
  assert.ok(failed.size > 0); fs.rmSync = originalRemove; skills.pruneSkillPrepared(); for (const directory of failed) assert.equal(fs.existsSync(directory), false);
  const owned = path.join(temporary, '.owned.removed'); fs.mkdirSync(owned);
  fs.rmSync = (directory, options) => { if (directory === owned) throw new Error('held'); return originalRemove(directory, options); };
  cleanup.cleanupCommittedSkillDirectory(owned); fs.rmSync = originalRemove;
  fs.renameSync(owned, `${owned}.original`); fs.mkdirSync(owned); fs.writeFileSync(path.join(owned, 'user-file'), 'preserve');
  cleanup.retryCommittedSkillCleanup(); assert.equal(fs.readFileSync(path.join(owned, 'user-file'), 'utf8'), 'preserve');
});

test('postcommit removal cleanup remains invisible to discovery and is retried on the next scan', async t => {
  const preview = await prepared('remove-cleanup'), installed = skills.installPreparedSkill({ token: preview.token, cwd: workspace });
  const originalRemove = fs.rmSync, tombstones = new Set();
  fs.rmSync = (directory, options) => { if (String(directory).endsWith('.removed')) { tombstones.add(directory); throw new Error('temporary permission issue'); } return originalRemove(directory, options); };
  t.after(() => { fs.rmSync = originalRemove; });
  skills.removeSkill(installed.path, workspace);
  assert.equal(fs.existsSync(installed.baseDir), false); assert.equal(getStudioDatabase().getSkillInstallation(installed.baseDir), undefined);
  assert.equal(skills.discoverSkills(workspace).skills.some(skill => skill.name === 'remove-cleanup'), false); assert.equal(tombstones.size, 1);
  fs.rmSync = originalRemove; skills.discoverSkills(workspace); for (const directory of tombstones) assert.equal(fs.existsSync(directory), false);
});

test('removal still rejects external paths and symlink skill roots without touching their targets', () => {
  const outside = path.join(temporary, 'outside-skill'); writeSkill(outside, 'outside-fixture');
  assert.throws(() => skills.removeSkill(path.join(outside, 'SKILL.md'), workspace), /不能删除这个位置/);
  const link = path.join(workspace, '.pi-studio', 'skills', 'linked-removal'); fs.symlinkSync(outside, link, 'dir');
  assert.throws(() => skills.removeSkill(path.join(link, 'SKILL.md'), workspace), /符号链接/);
  assert.ok(fs.existsSync(path.join(outside, 'SKILL.md'))); assert.ok(fs.lstatSync(link).isSymbolicLink());
});
