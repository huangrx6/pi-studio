const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test, after } = require('node:test');
const { installElectronSafeStorage } = require('./helpers/electron-safe-storage.cjs');
installElectronSafeStorage({ after });
const { validatePluginDirectory } = require('../../electron/main/core/plugin-package.cjs');
const { createStudioDatabase } = require('../../electron/main/core/studio-db.cjs');
const {
  preparePluginInstall,
  installPreparedPlugin,
  uninstallPlugin,
  pluginPathEnvPrefixes,
  listInstalledPlugins,
} = require('../../electron/main/services/plugin-distribution.cjs');

const example = path.resolve(__dirname, '../../examples/plugins/toolkit-starter');

test('plugin preview reports the installed Studio version before parsing newer panel fields', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-studio-plugin-compatibility-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const previousUserData = process.env.PI_STUDIO_USER_DATA;
  process.env.PI_STUDIO_USER_DATA = path.join(directory, 'profile');
  t.after(() => {
    if (previousUserData === undefined) delete process.env.PI_STUDIO_USER_DATA;
    else process.env.PI_STUDIO_USER_DATA = previousUserData;
  });
  const pluginDirectory = path.join(directory, 'plugin');
  fs.cpSync(path.resolve(__dirname, '../../assets/official-plugins/packages/excalidraw'), pluginDirectory, {
    recursive: true,
  });
  const manifestPath = path.join(pluginDirectory, 'extension', 'pi-studio.extension.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  manifest.engines.piStudio = '>=100.0.0';
  manifest.contributes.panels[0].futurePanelField = true;
  fs.writeFileSync(manifestPath, JSON.stringify(manifest));

  await assert.rejects(preparePluginInstall(pluginDirectory), {
    code: 'INCOMPATIBLE_EXTENSION',
    message: `Excalidraw 需要 Pi Studio >=100.0.0，当前版本为 ${require('../../package.json').version}。`,
  });
  assert.deepEqual(fs.readdirSync(path.join(process.env.PI_STUDIO_USER_DATA, 'plugin-quarantine')), []);
});

test('example toolkit-starter plugin validates', () => {
  const result = validatePluginDirectory(example);
  assert.equal(result.manifest.id, 'example.toolkit-starter');
  assert.ok(result.manifest.provides.mcp.length >= 1);
  assert.ok(result.manifest.provides.skills.length >= 1);
  assert.ok(result.manifest.provides.cli.length >= 1);
  assert.ok(result.contentHash);
});

test('prepare and install plugin registers mcp skill cli with ownership', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-studio-plugin-'));
  process.env.PI_STUDIO_USER_DATA = directory;
  // Reset singleton db if any
  const { closeStudioDatabase, getStudioDatabase, SCHEMA_VERSION } = require('../../electron/main/core/studio-db.cjs');
  closeStudioDatabase();
  t.after(() => {
    closeStudioDatabase();
    delete process.env.PI_STUDIO_USER_DATA;
    fs.rmSync(directory, { recursive: true, force: true });
  });

  const db = getStudioDatabase();
  assert.equal(db.db.prepare('PRAGMA user_version').get().user_version, SCHEMA_VERSION);
  assert.equal(db.listPlugins().length, 0);

  const preview = await preparePluginInstall(example);
  assert.equal(preview.canInstall, true);
  assert.equal(preview.id, 'example.toolkit-starter');
  assert.ok(preview.provides.mcp.some((item) => item.name === 'toolkit-demo'));

  const installed = installPreparedPlugin(preview.token);
  assert.equal(installed.plugin.id, 'example.toolkit-starter');
  assert.deepEqual(installed.installed.mcp, ['toolkit-demo']);
  assert.ok(installed.installed.skills.some((item) => item.name === 'toolkit-demo'));
  assert.deepEqual(installed.installed.cli, ['toolkit']);

  const mcp = db.getMcpServer('toolkit-demo');
  assert.equal(mcp.origin, 'plugin');
  assert.equal(mcp.ownerPluginId, 'example.toolkit-starter');
  assert.equal(mcp.managed, true);
  assert.ok(path.isAbsolute(mcp.args[0]));
  assert.ok(mcp.args[0].endsWith('mcp-server.mjs'));

  const skill = db.listSkillInstallations().find((item) => item.name === 'toolkit-demo');
  assert.equal(skill.origin, 'plugin');
  assert.equal(skill.ownerPluginId, 'example.toolkit-starter');

  const { discoverSkills } = require('../../electron/main/capabilities/skills/index.cjs');
  const discovered = discoverSkills(directory).skills.find((item) => item.name === 'toolkit-demo');
  assert.ok(discovered);
  assert.equal(discovered.origin, 'plugin');
  assert.equal(discovered.ownerPluginId, 'example.toolkit-starter');
  assert.equal(discovered.managed, true);

  const prefixes = pluginPathEnvPrefixes();
  assert.ok(prefixes.some((item) => item.includes(path.join('plugins', 'example.toolkit-starter'))));

  assert.equal(listInstalledPlugins().length, 1);

  const removed = uninstallPlugin('example.toolkit-starter');
  assert.ok(removed.removed.mcp.includes('toolkit-demo'));
  assert.equal(db.getMcpServer('toolkit-demo'), undefined);
  assert.equal(db.getPlugin('example.toolkit-starter'), undefined);
  assert.equal(listInstalledPlugins().length, 0);
});

test('soft-disable hides plugin skills from discovery but keeps package files', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-studio-plugin-disable-'));
  process.env.PI_STUDIO_USER_DATA = directory;
  const { closeStudioDatabase, getStudioDatabase } = require('../../electron/main/core/studio-db.cjs');
  closeStudioDatabase();
  t.after(() => {
    closeStudioDatabase();
    delete process.env.PI_STUDIO_USER_DATA;
    fs.rmSync(directory, { recursive: true, force: true });
  });

  const preview = await preparePluginInstall(example);
  installPreparedPlugin(preview.token);
  const { setPluginEnabled } = require('../../electron/main/services/plugin-distribution.cjs');
  setPluginEnabled('example.toolkit-starter', false);

  const mcp = getStudioDatabase().getMcpServer('toolkit-demo');
  assert.equal(mcp.enabled, false);

  const { discoverSkills } = require('../../electron/main/capabilities/skills/index.cjs');
  const listed = discoverSkills(directory);
  const names = listed.skills.map((item) => item.name);
  assert.ok(!names.includes('toolkit-demo'), `disabled plugin skill still listed: ${JSON.stringify(names)}`);

  // Re-enable restores discovery.
  setPluginEnabled('example.toolkit-starter', true);
  const restored = discoverSkills(directory).skills.map((item) => item.name);
  assert.ok(restored.includes('toolkit-demo'), `re-enabled plugin skill missing: ${JSON.stringify(restored)}`);
});
