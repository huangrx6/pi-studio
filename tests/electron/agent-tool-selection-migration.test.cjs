const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { installElectronSafeStorage } = require('./helpers/electron-safe-storage.cjs');

installElectronSafeStorage(test);

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-studio-tools-'));
process.env.PI_STUDIO_DB = path.join(temporary, 'studio.sqlite');

const { closeStudioDatabase, getStudioDatabase } = require('../../electron/main/core/studio-db.cjs');
const {
  DEFAULT_AGENT_TOOLS,
  enabledMcpMethodNames,
  readAgentToolSelection,
  saveInstalledToolSelection,
} = require('../../electron/main/runtime/tool-selection.cjs');

test.after(() => {
  closeStudioDatabase();
  fs.rmSync(temporary, { recursive: true, force: true });
});

test('defaults include browser act tools', () => {
  assert.ok(DEFAULT_AGENT_TOOLS.includes('browser_tabs'));
  assert.ok(DEFAULT_AGENT_TOOLS.includes('browser_click'));
  assert.ok(DEFAULT_AGENT_TOOLS.includes('browser_type'));
  assert.ok(DEFAULT_AGENT_TOOLS.includes('browser_wait'));
  assert.ok(DEFAULT_AGENT_TOOLS.includes('browser_highlight'));
  assert.ok(DEFAULT_AGENT_TOOLS.includes('workbench_refresh'));
  assert.ok(!DEFAULT_AGENT_TOOLS.includes('browser_evaluate'));
});

test('version 3 selections migrate through browser act tools', () => {
  const db = getStudioDatabase();
  db.setSetting('studio.agent.tools', {
    enabled: ['read', 'write', 'todo', 'mcp__*'],
    sources: {},
  });
  db.setSetting('studio.agent.tools.version', 3);
  const next = readAgentToolSelection(db);
  for (const name of [
    'browser_tabs', 'browser_open', 'browser_navigate', 'browser_snapshot', 'browser_screenshot',
    'browser_click', 'browser_type', 'browser_scroll', 'browser_wait', 'browser_select',
    'browser_dialog', 'browser_download', 'browser_highlight', 'workbench_refresh',
  ]) {
    assert.ok(next.enabled.includes(name), `missing ${name}`);
  }
  assert.ok(!next.enabled.includes('browser_evaluate'), 'evaluate must not auto-enable');
  assert.equal(db.getSetting('studio.agent.tools.version'), 7);
});

test('local saves preserve legacy MCP choices, including overlapping wildcards and offline methods', () => {
  const db = getStudioDatabase();
  const legacy = { enabled: ['read', 'mcp__docs__*', '*__inspect', 'mcp__offline__fetch'], sources: {} };
  db.setSetting('studio.agent.tools', legacy);
  const methods = ['mcp__docs__read', 'mcp__other__inspect', 'mcp__other__write', 'mcp__offline__fetch'].map(name => ({ name }));
  const effective = () => [...enabledMcpMethodNames(methods, readAgentToolSelection(db), db)];
  const expected = [methods[0].name, methods[1].name, methods[3].name];
  assert.deepEqual(effective(), expected);
  for (const local of [['*'], [], ['read', 'write']]) {
    saveInstalledToolSelection(local, db);
    assert.deepEqual(effective(), expected);
  }
  methods[0].enabledOverride = false;
  methods[2].enabledOverride = true;
  assert.deepEqual(effective(), [methods[1].name, methods[2].name, methods[3].name]);
  assert.deepEqual(saveInstalledToolSelection(['read', 'mcp__*'], db).enabled, ['read']);
  assert.deepEqual(effective(), [methods[1].name, methods[2].name, methods[3].name]);
});

test('method overrides survive independent writes, connection edits and a server rename', async () => {
  const db = getStudioDatabase();
  const server = { name: 'docs', transport: 'stdio', command: 'node', args: [] };
  db.upsertMcpServer(server);
  db.setMcpMethodEnabled('docs', 'docs.read', false);
  db.setMcpMethodEnabled('docs', 'docs_read', true);
  db.upsertMcpServer({ ...server, description: 'Updated' });
  const overrides = { 'docs.read': false, docs_read: true };
  assert.deepEqual((await db.getMcpServerAsync('docs')).methodAccess, overrides);
  db.db.exec("CREATE TRIGGER block_rename BEFORE DELETE ON mcp_servers BEGIN SELECT RAISE(ABORT, 'interrupted rename'); END");
  await assert.rejects(db.upsertMcpServerAsync({ ...server, name: 'renamed' }, 'docs'), /interrupted rename/);
  assert.equal(db.getMcpServer('renamed'), undefined);
  assert.deepEqual(db.getMcpServer('docs').methodAccess, overrides);
  db.db.exec('DROP TRIGGER block_rename');
  await db.upsertMcpServerAsync({ ...server, name: 'renamed' }, 'docs');
  assert.deepEqual(db.getMcpServer('renamed').methodAccess, overrides);
  assert.equal(db.getMcpServer('docs'), undefined);
});
