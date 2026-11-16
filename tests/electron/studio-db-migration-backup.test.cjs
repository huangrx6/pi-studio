const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { DatabaseSync } = require('node:sqlite');

const {
  SCHEMA_VERSION,
  createStudioDatabase,
} = require('../../electron/core/studio-db.cjs');

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-studio-migration-backup-'));

test.after(() => fs.rmSync(temporary, { recursive: true, force: true }));

function legacyDatabase(filename, { conflictingTable = false } = {}) {
  const database = new DatabaseSync(filename);
  database.exec(`
    CREATE TABLE settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
    INSERT INTO settings(key, value, updated_at)
      VALUES ('retained', '{"value":"before migration"}', 1);
    PRAGMA user_version = 17;
  `);
  if (conflictingTable) database.exec('CREATE TABLE skill_sources_v18 (wrong TEXT)');
  database.close();
}

test('existing databases receive a validated pre-migration snapshot before upgrading', () => {
  const filename = path.join(temporary, 'success.sqlite');
  legacyDatabase(filename);

  const studio = createStudioDatabase(filename);
  try {
    assert.equal(studio.db.prepare('PRAGMA user_version').get().user_version, SCHEMA_VERSION);
    assert.equal(studio.getSetting('retained').value, 'before migration');
    assert.equal(studio.migrationBackupPath, `${filename}.migration-backup-v17-to-v${SCHEMA_VERSION}.sqlite`);
    assert.equal(fs.statSync(studio.migrationBackupPath).mode & 0o777, 0o600);

    const backup = new DatabaseSync(studio.migrationBackupPath, { readOnly: true });
    try {
      assert.equal(backup.prepare('PRAGMA user_version').get().user_version, 17);
      const retained = backup.prepare('SELECT key, value FROM settings').all();
      assert.equal(retained.length, 1);
      assert.equal(retained[0].key, 'retained');
      assert.equal(retained[0].value, '{"value":"before migration"}');
      assert.equal(backup.prepare('PRAGMA quick_check').get().quick_check, 'ok');
    } finally {
      backup.close();
    }
  } finally {
    studio.close();
  }
});

test('an interrupted or failed migration rolls back and retains a usable snapshot', () => {
  const filename = path.join(temporary, 'failure.sqlite');
  legacyDatabase(filename, { conflictingTable: true });

  assert.throws(() => createStudioDatabase(filename), /skill_sources_v18/);

  const current = new DatabaseSync(filename);
  try {
    assert.equal(current.prepare('PRAGMA user_version').get().user_version, 17);
    assert.equal(
      current.prepare("SELECT value FROM settings WHERE key = 'retained'").get().value,
      '{"value":"before migration"}',
    );
  } finally {
    current.close();
  }

  const backupFile = `${filename}.migration-backup-v17-to-v${SCHEMA_VERSION}.sqlite`;
  assert.ok(fs.existsSync(backupFile));
  const backup = new DatabaseSync(backupFile, { readOnly: true });
  try {
    assert.equal(backup.prepare('PRAGMA user_version').get().user_version, 17);
    assert.equal(
      backup.prepare("SELECT value FROM settings WHERE key = 'retained'").get().value,
      '{"value":"before migration"}',
    );
    assert.equal(backup.prepare('PRAGMA quick_check').get().quick_check, 'ok');
  } finally {
    backup.close();
  }
});

test('brand-new databases do not create an empty migration snapshot', () => {
  const filename = path.join(temporary, 'new.sqlite');
  const studio = createStudioDatabase(filename);
  try {
    assert.equal(studio.migrationBackupPath, undefined);
    assert.equal(fs.existsSync(`${filename}.migration-backup-v0-to-v${SCHEMA_VERSION}.sqlite`), false);
  } finally {
    studio.close();
  }
});

test('upgrading existing sources keeps their models and leaves quota monitoring opt-in', () => {
  const filename = path.join(temporary, 'provider-v18.sqlite');
  const previous = createStudioDatabase(filename);
  try {
    previous.upsertProvider({ id: 'gateway', name: '原有来源', baseUrl: 'https://example.test/v1' });
    previous.upsertModel({ providerId: 'gateway', modelId: 'original', name: '原有模型', enabled: true });
    previous.db.exec('ALTER TABLE model_providers DROP COLUMN quota_config; PRAGMA user_version = 18;');
  } finally { previous.close(); }

  const upgraded = createStudioDatabase(filename);
  try {
    assert.equal(upgraded.getProvider('gateway').name, '原有来源');
    assert.equal(upgraded.getProvider('gateway').quota, null);
    assert.equal(upgraded.getModel('gateway', 'original').enabled, true);
    assert.equal(upgraded.migrationBackupPath, `${filename}.migration-backup-v18-to-v${SCHEMA_VERSION}.sqlite`);
  } finally { upgraded.close(); }
});
