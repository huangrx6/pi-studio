const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test, after } = require('node:test');
const { installElectronSafeStorage } = require('./helpers/electron-safe-storage.cjs');
installElectronSafeStorage({ after });
const { createStudioDatabase, SCHEMA_VERSION } = require('../../electron/main/core/studio-db.cjs');

function openDb(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-studio-ownership-'));
  const db = createStudioDatabase(path.join(directory, 'studio.sqlite'));
  t.after(() => {
    db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return db;
}

test('schema v25 stores ownership columns and defaults user-origin MCP rows', (t) => {
  const db = openDb(t);
  assert.ok(SCHEMA_VERSION >= 25);
  const version = Number(db.db.prepare('PRAGMA user_version').get().user_version);
  assert.equal(version, SCHEMA_VERSION);
  const created = db.upsertMcpServer({
    name: 'manual',
    transport: 'stdio',
    command: 'echo',
    args: [],
    enabled: true,
  });
  assert.equal(created.origin, 'user');
  assert.equal(created.ownerPluginId, '');
  assert.equal(created.managed, false);
  assert.equal(created.userOverride, false);
});

test('setMcpOwnership and upsert preserve plugin ownership round-trip', (t) => {
  const db = openDb(t);
  db.upsertMcpServer({ name: 'draw', transport: 'stdio', command: 'npx', args: ['-y', 'demo'] });
  const owned = db.setMcpOwnership('draw', {
    origin: 'plugin',
    ownerPluginId: 'com.example.excalidraw',
    managed: true,
    userOverride: false,
  });
  assert.equal(owned.origin, 'plugin');
  assert.equal(owned.ownerPluginId, 'com.example.excalidraw');
  assert.equal(owned.managed, true);

  const updated = db.upsertMcpServer({
    name: 'draw',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', 'demo', '--flag'],
    description: 'updated',
  });
  assert.equal(updated.origin, 'plugin');
  assert.equal(updated.ownerPluginId, 'com.example.excalidraw');
  assert.equal(updated.managed, true);
  assert.equal(updated.description, 'updated');

  const listed = db.listMcpServers().find((item) => item.name === 'draw');
  assert.equal(listed.ownerPluginId, 'com.example.excalidraw');
});

test('metadata-only MCP updates retain both encrypted credential envelopes', t => {
  const db = openDb(t);
  const row = { name: 'bundled', transport: 'stdio', command: 'node' };
  db.upsertMcpServer({ ...row, env: { TOKEN: 'test-only' }, headers: { Authorization: 'test-only' } });
  const read = () => db.db.prepare('SELECT env, headers FROM mcp_servers WHERE name = ?').get(row.name);
  const before = read();
  assert.equal(JSON.parse(before.env).format, 'safeStorage-v1');
  db.upsertMcpServer({ ...row, description: 'Updated metadata' });
  assert.deepEqual(read(), before);
});

test('extensions and skill installations accept ownership fields', (t) => {
  const db = openDb(t);
  const extension = db.upsertExtension({
    id: 'user.draw-panel',
    name: 'Draw Panel',
    version: '1.0.0',
    scope: 'user',
    source: '/tmp/draw-panel',
    manifest: { id: 'user.draw-panel', name: 'Draw Panel' },
    origin: 'plugin',
    ownerPluginId: 'com.example.excalidraw',
    managed: true,
  });
  assert.equal(extension.origin, 'plugin');
  assert.equal(extension.ownerPluginId, 'com.example.excalidraw');
  assert.equal(extension.managed, true);

  const skillPath = path.join(os.tmpdir(), `pi-skill-${Date.now()}`);
  const skill = db.upsertSkillInstallation({
    path: skillPath,
    sourceId: 'source',
    listingId: 'listing',
    name: 'draw-skill',
    version: '0.1.0',
    sha256: 'abc',
    origin: 'plugin',
    ownerPluginId: 'com.example.excalidraw',
    managed: true,
  });
  assert.equal(skill.origin, 'plugin');
  assert.equal(skill.ownerPluginId, 'com.example.excalidraw');
  assert.equal(db.setSkillInstallationOwnership(skillPath, { userOverride: true }).userOverride, true);

  const builtin = db.upsertExtension({
    id: 'builtin.core',
    name: 'Core',
    version: '1.0.0',
    scope: 'builtin',
    source: 'builtin',
    manifest: { id: 'builtin.core' },
  });
  assert.equal(builtin.origin, 'builtin');
  assert.equal(builtin.managed, false);
});
