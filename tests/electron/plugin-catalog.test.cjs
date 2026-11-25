const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test, after } = require('node:test');
const { installElectronSafeStorage } = require('./helpers/electron-safe-storage.cjs');
installElectronSafeStorage({ after });

const repoRoot = path.resolve(__dirname, '../..');
const officialRoot = path.join(repoRoot, 'assets/official-plugins');

test('official registry installs both workbench plugins and loads their declared UI and AI tools', async (t) => {
  process.env.PI_STUDIO_OFFICIAL_PLUGINS = officialRoot;
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-studio-plugin-market-'));
  process.env.PI_STUDIO_USER_DATA = directory;
  const { closeStudioDatabase } = require('../../electron/main/core/studio-db.cjs');
  closeStudioDatabase();
  t.after(() => {
    closeStudioDatabase();
    delete process.env.PI_STUDIO_USER_DATA;
    delete process.env.PI_STUDIO_OFFICIAL_PLUGINS;
    fs.rmSync(directory, { recursive: true, force: true });
  });

  const {
    pluginMarketSnapshot,
    resolveMarketInstallSource,
    officialPluginsRoot,
  } = require('../../electron/main/services/plugin-catalog.cjs');
  const {
    preparePluginInstall,
    installPreparedPlugin,
    uninstallPlugin,
  } = require('../../electron/main/services/plugin-distribution.cjs');

  assert.equal(officialPluginsRoot(), officialRoot);
  const snapshot = await pluginMarketSnapshot();
  assert.ok(snapshot.sources.some((item) => item.id === 'official'));
  const item = snapshot.plugins.find(plugin => plugin.id === 'studio.excalidraw');
  assert.ok(item);
  assert.equal(item.provides.mcp, 0);
  assert.equal(item.provides.extension, true);
  assert.match(item.iconDataUrl, /^data:image\/png;base64,/);
  assert.equal(item.installed, false);

  const resolved = await resolveMarketInstallSource(item.id);
  assert.ok(fs.existsSync(resolved.source));
  assert.match(resolved.expectedSha256, /^[a-f0-9]{64}$/);
  const preview = await preparePluginInstall(resolved.source, { expectedSha256: resolved.expectedSha256 });
  assert.equal(preview.version, resolved.version);
  assert.equal(preview.canInstall, true);
  const installed = installPreparedPlugin(preview.token);
  assert.equal(installed.plugin.id, item.id);
  assert.deepEqual(installed.installed.extension, ['user:studio.excalidraw']);
  const { getStudioDatabase } = require('../../electron/main/core/studio-db.cjs');
  const { loadRuntimeExtension } = require('../../electron/main/services/studio-extensions.cjs');
  const { readAgentToolSelection } = require('../../electron/main/runtime/tool-selection.cjs');
  const db = getStudioDatabase();
  const row = db.getExtension('user:studio.excalidraw');
  assert.ok(row.source.endsWith('/extension/pi-studio.extension.json'));
  assert.equal(row.manifest.contributes.panels[0].canvas.sourceId, 'user:studio.excalidraw/scene');
  const active = await loadRuntimeExtension(row, directory);
  assert.deepEqual(active.extension.tools.map(tool => tool.name), ['excalidraw_draw', 'excalidraw_read']);
  assert.equal(typeof active.dataSources.get('scene').writeCanvas, 'function');
  assert.ok(readAgentToolSelection(db).enabled.includes('excalidraw_draw'));

  const afterInstall = await pluginMarketSnapshot({ query: 'excalidraw' });
  const listed = afterInstall.plugins.find((plugin) => plugin.id === item.id);
  assert.equal(listed.installed, true);

  uninstallPlugin(item.id);
  assert.equal(db.getExtension(row.id), undefined);
  assert.ok(!readAgentToolSelection(db).enabled.includes('excalidraw_draw'));

  const taskBoard = snapshot.plugins.find(plugin => plugin.id === 'studio.task-board');
  assert.ok(taskBoard);
  const taskSource = await resolveMarketInstallSource(taskBoard.id);
  const taskPreview = await preparePluginInstall(taskSource.source, { expectedSha256: taskSource.expectedSha256 });
  assert.deepEqual(installPreparedPlugin(taskPreview.token).installed.extension, ['user:studio.task-board']);
  const taskRow = db.getExtension('user:studio.task-board');
  assert.equal(taskRow.manifest.contributes.panels[0].taskBoard.sourceId, 'user:studio.task-board/board-data');
  const taskRuntime = await loadRuntimeExtension(taskRow, directory);
  try {
    const provider = taskRuntime.dataSources.get('board-data');
    assert.equal(typeof provider.writeTaskBoard, 'function');
    assert.deepEqual(taskRuntime.extension.tools.map(tool => tool.name), ['task_board_list', 'task_board_get']);
    assert.ok(fs.existsSync(path.join(directory, 'plugin-data', taskBoard.id, taskBoard.id, 'tasks.sqlite')));
  } finally {
    await taskRuntime.cleanup();
  }
});

test('directory source lists nested plugin packages', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-studio-plugin-dir-src-'));
  process.env.PI_STUDIO_USER_DATA = directory;
  process.env.PI_STUDIO_OFFICIAL_PLUGINS = path.join(directory, 'empty-official');
  fs.mkdirSync(process.env.PI_STUDIO_OFFICIAL_PLUGINS, { recursive: true });
  const { closeStudioDatabase } = require('../../electron/main/core/studio-db.cjs');
  closeStudioDatabase();
  t.after(() => {
    closeStudioDatabase();
    delete process.env.PI_STUDIO_USER_DATA;
    delete process.env.PI_STUDIO_OFFICIAL_PLUGINS;
    fs.rmSync(directory, { recursive: true, force: true });
  });

  const {
    addPluginSource,
    pluginMarketSnapshot,
  } = require('../../electron/main/services/plugin-catalog.cjs');

  const examples = path.join(repoRoot, 'examples/plugins');
  addPluginSource({
    name: 'Examples',
    type: 'directory',
    location: examples,
  });
  const snapshot = await pluginMarketSnapshot({ query: 'starter' });
  assert.ok(snapshot.plugins.some((item) => item.id === 'example.toolkit-starter'));
});

test('search filters by category and keyword', async (t) => {
  process.env.PI_STUDIO_OFFICIAL_PLUGINS = officialRoot;
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-studio-plugin-search-'));
  process.env.PI_STUDIO_USER_DATA = directory;
  const { closeStudioDatabase } = require('../../electron/main/core/studio-db.cjs');
  closeStudioDatabase();
  t.after(() => {
    closeStudioDatabase();
    delete process.env.PI_STUDIO_USER_DATA;
    delete process.env.PI_STUDIO_OFFICIAL_PLUGINS;
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const { pluginMarketSnapshot } = require('../../electron/main/services/plugin-catalog.cjs');
  const hit = await pluginMarketSnapshot({ query: 'mermaid' });
  assert.ok(hit.plugins.some((item) => item.id === 'studio.excalidraw'));
  const miss = await pluginMarketSnapshot({ category: 'nonexistent-category' });
  assert.equal(miss.plugins.length, 0);
});
