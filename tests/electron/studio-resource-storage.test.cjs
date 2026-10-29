const { after, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const { DatabaseSync } = require('node:sqlite');

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-studio-resource-storage-'));
const databaseFile = path.join(temporary, 'studio.sqlite');
process.env.PI_STUDIO_DB = databaseFile;

const originalLoad = Module._load;
Module._load = function loadWithSafeStorage(request, parent, isMain) {
  if (request === 'electron') {
    return {
      safeStorage: {
        isEncryptionAvailable: () => true,
        encryptString: (value) => Buffer.from(`sealed:${value}`, 'utf8'),
        decryptString: (value) => value.toString('utf8').replace(/^sealed:/, ''),
      },
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};

const {
  SCHEMA_VERSION,
  createStudioDatabase,
} = require('../../electron/core/studio-db.cjs');

function createV2Database() {
  const db = new DatabaseSync(databaseFile);
  db.exec(`
    CREATE TABLE mcp_servers (
      name TEXT PRIMARY KEY,
      transport TEXT NOT NULL,
      command TEXT NOT NULL DEFAULT '',
      args TEXT NOT NULL DEFAULT '[]',
      url TEXT NOT NULL DEFAULT '',
      description TEXT NOT NULL DEFAULT '',
      env TEXT NOT NULL DEFAULT '{}',
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    PRAGMA user_version = 2;
  `);
  db.prepare(`
    INSERT INTO mcp_servers(
      name, transport, command, args, url, description, env, enabled, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    'legacy',
    'stdio',
    'node',
    '["server.mjs"]',
    '',
    'Legacy server',
    JSON.stringify({ TOKEN: 'legacy-secret' }),
    1,
    1,
    1,
  );
  db.close();
}

createV2Database();
const studio = createStudioDatabase(databaseFile);

after(() => {
  studio.close();
  Module._load = originalLoad;
  fs.rmSync(temporary, { recursive: true, force: true });
});

test('v2 MCP configuration migrates to the current schema and encrypts legacy secrets', () => {
  const columns = new Set(
    studio.db.prepare('PRAGMA table_info(mcp_servers)').all().map((row) => row.name),
  );
  assert.equal(columns.has('headers'), true);
  assert.equal(columns.has('cwd'), true);
  assert.equal(columns.has('exposure'), true);
  assert.equal(studio.db.prepare('PRAGMA user_version').get().user_version, SCHEMA_VERSION);

  const raw = studio.db.prepare('SELECT env, headers FROM mcp_servers WHERE name = ?').get('legacy');
  assert.doesNotMatch(raw.env, /legacy-secret/);
  assert.equal(JSON.parse(raw.env).format, 'safeStorage-v1');
  assert.equal(JSON.parse(raw.headers).format, 'safeStorage-v1');
});

test('v4 extension trust migrates only after invalidating unbound project consent', () => {
  const legacyFile = path.join(temporary, 'legacy-v4.sqlite');
  const legacy = new DatabaseSync(legacyFile);
  legacy.exec(`
    CREATE TABLE studio_extensions (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      version TEXT NOT NULL,
      scope TEXT NOT NULL CHECK (scope IN ('builtin', 'user', 'project')),
      source TEXT NOT NULL,
      manifest TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      trusted INTEGER NOT NULL DEFAULT 0,
      installed_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    PRAGMA user_version = 4;
  `);
  legacy.prepare(`
    INSERT INTO studio_extensions(
      id, name, version, scope, source, manifest, enabled, trusted, installed_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    'project:legacy-extension',
    'Legacy',
    '1.0.0',
    'project',
    '/tmp/legacy-extension/pi-studio.extension.json',
    JSON.stringify({ id: 'legacy-extension' }),
    1,
    1,
    1,
    1,
  );
  legacy.close();

  const migrated = createStudioDatabase(legacyFile);
  try {
    assert.equal(migrated.db.prepare('PRAGMA user_version').get().user_version, SCHEMA_VERSION);
    const row = migrated.getExtension('project:legacy-extension');
    assert.equal(row.trusted, false);
    assert.equal(row.contentHash, '');
  } finally {
    migrated.close();
  }
});

test('renderer-facing MCP records expose key names but never secret values', () => {
  const renderer = studio.getMcpServer('legacy');
  assert.deepEqual(renderer.envKeys, ['TOKEN']);
  assert.equal(Object.hasOwn(renderer, 'env'), false);
  assert.equal(Object.hasOwn(renderer, 'headers'), false);
  assert.doesNotMatch(JSON.stringify(renderer), /legacy-secret/);

  const runtime = studio.getMcpServer('legacy', { includeSecrets: true });
  assert.deepEqual(runtime.env, { TOKEN: 'legacy-secret' });
});

test('updating non-secret fields keeps runtime secrets without returning them to renderer', () => {
  studio.upsertMcpServer({
    ...studio.getMcpServer('legacy', { includeSecrets: true }),
    cwd: '/tmp/legacy-cwd',
    timeoutSeconds: 90,
  });
  const runtime = studio.getMcpServer('legacy', { includeSecrets: true });
  assert.equal(runtime.cwd, '/tmp/legacy-cwd');
  assert.equal(runtime.timeoutSeconds, 90);
  assert.deepEqual(runtime.env, { TOKEN: 'legacy-secret' });

  const renderer = studio.getMcpServer('legacy');
  assert.deepEqual(renderer.envKeys, ['TOKEN']);
  assert.doesNotMatch(JSON.stringify(renderer), /legacy-secret/);
});
