const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { installElectronSafeStorage } = require('./helpers/electron-safe-storage.cjs');

installElectronSafeStorage(test);

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-studio-skill-shared-'));
// 共享技能落在 ~/.agents/skills，测试必须换一个 HOME，否则会写进真实用户目录。
process.env.HOME = path.join(temporary, 'home');
process.env.PI_STUDIO_USER_DATA = path.join(temporary, 'user-data');
process.env.PI_STUDIO_DB = path.join(temporary, 'studio.sqlite');

const { closeStudioDatabase } = require('../../electron/core/studio-db.cjs');
const {
  installPreparedSkill,
  prepareSkillInstall,
  refreshSkillCatalog,
  saveSkillSource,
  skillHubSnapshot,
} = require('../../electron/capabilities/skills/index.cjs');

test.after(() => {
  closeStudioDatabase();
  fs.rmSync(temporary, { recursive: true, force: true });
});

function writeSkill(root, name, version) {
  fs.mkdirSync(path.join(root, 'references'), { recursive: true });
  fs.writeFileSync(path.join(root, 'SKILL.md'), [
    '---',
    `name: ${name}`,
    'description: A shared skill fixture.',
    'metadata:',
    `  version: ${version}`,
    '---',
    '',
    `Use ${name}.`,
    '',
  ].join('\n'));
  fs.writeFileSync(path.join(root, 'references', 'guide.md'), `${version}\n`);
}

test('skills can be installed into the shared Agent directory', async () => {
  const sourceRoot = path.join(temporary, 'source');
  writeSkill(path.join(sourceRoot, 'shared-demo'), 'shared-demo', '1.4.0');
  const source = saveSkillSource({ type: 'directory', name: '共享测试源', location: sourceRoot });
  const hub = await refreshSkillCatalog();
  const item = hub.catalogs
    .find((catalog) => catalog.source.id === source.id)
    .items.find((entry) => entry.name === 'shared-demo');

  const preview = await prepareSkillInstall({ sourceId: source.id, listingId: item.listingId, scope: 'shared' });
  assert.equal(preview.scope, 'shared');
  // 共享目录是用户级技能，不需要项目信任。
  assert.equal(preview.requiresTrust, false);
  const installed = installPreparedSkill({ token: preview.token });
  assert.equal(installed.scope, 'shared');
  assert.equal(installed.baseDir, path.join(process.env.HOME, '.agents', 'skills', 'shared-demo'));
  assert.match(fs.readFileSync(path.join(installed.baseDir, 'SKILL.md'), 'utf8'), /Use shared-demo\./);
  assert.equal(fs.readFileSync(path.join(installed.baseDir, 'references', 'guide.md'), 'utf8'), '1.4.0\n');
});

test('an unknown install scope is rejected instead of guessing a directory', async () => {
  const sourceRoot = path.join(temporary, 'source-2');
  writeSkill(path.join(sourceRoot, 'scope-demo'), 'scope-demo', '1.0.0');
  const source = saveSkillSource({ type: 'directory', name: '范围测试源', location: sourceRoot });
  const hub = await skillHubSnapshot({ refresh: true });
  const item = hub.catalogs
    .find((catalog) => catalog.source.id === source.id)
    .items.find((entry) => entry.name === 'scope-demo');
  await assert.rejects(
    prepareSkillInstall({ sourceId: source.id, listingId: item.listingId, scope: 'root' }),
    /安装范围无效/,
  );
});
