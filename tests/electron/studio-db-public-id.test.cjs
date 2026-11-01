const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { DatabaseSync } = require('node:sqlite');

const {
  createStudioDatabase,
} = require('../../electron/core/studio-db.cjs');

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-studio-public-id-'));
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

test.after(() => {
  fs.rmSync(temporary, { recursive: true, force: true });
});

test('conversation projections expose a stable UUID while Durable keeps its numeric ID', () => {
  const db = createStudioDatabase(path.join(temporary, 'current.sqlite'));
  try {
    const inserted = db.insertConversation({
      id: '44',
      workspace: temporary,
      kind: 'durable',
      title: 'UUID projection',
    });
    assert.equal(inserted.id, '44');
    assert.match(inserted.publicId, uuidPattern);
    assert.equal(db.getConversation(inserted.publicId).id, '44');
    assert.equal(db.getConversation('44').publicId, inserted.publicId);

    const updated = db.updateConversation(inserted.publicId, {
      title: 'Updated through public ID',
      lastDurationMs: 12_345,
    });
    assert.equal(updated.id, '44');
    assert.equal(updated.publicId, inserted.publicId);
    assert.equal(updated.title, 'Updated through public ID');
    assert.equal(updated.lastDurationMs, 12_345);
  } finally {
    db.close();
  }
});

test('the v10 migration backfills UUIDs and moves legacy session keys', () => {
  const filename = path.join(temporary, 'legacy.sqlite');
  const legacy = new DatabaseSync(filename);
  legacy.exec(`
    CREATE TABLE conversations (
      id TEXT PRIMARY KEY,
      workspace TEXT NOT NULL,
      kind TEXT NOT NULL,
      title TEXT NOT NULL,
      title_source TEXT NOT NULL DEFAULT 'auto',
      goal TEXT NOT NULL DEFAULT '',
      pinned INTEGER NOT NULL DEFAULT 0,
      archived INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      last_request_id TEXT NOT NULL DEFAULT '',
      last_error TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE turn_diffs (
      conversation_id TEXT NOT NULL,
      at INTEGER NOT NULL,
      payload TEXT NOT NULL,
      PRIMARY KEY (conversation_id, at)
    );
    CREATE TABLE conversation_metric_requests (
      request_id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      started_at INTEGER NOT NULL,
      finished_at INTEGER NOT NULL,
      status TEXT NOT NULL,
      provider_id TEXT NOT NULL,
      model_id TEXT NOT NULL,
      tps REAL NOT NULL,
      ttft_ms REAL,
      duration_ms REAL NOT NULL,
      input_tokens INTEGER NOT NULL,
      output_tokens INTEGER NOT NULL,
      cache_read_tokens INTEGER NOT NULL,
      cache_write_tokens INTEGER NOT NULL,
      cost REAL NOT NULL
    );
    INSERT INTO conversations(
      id, workspace, kind, title, created_at, updated_at
    ) VALUES ('44', '${temporary.replaceAll("'", "''")}', 'durable', 'Legacy', 1, 1);
    INSERT INTO turn_diffs(conversation_id, at, payload)
      VALUES ('44', 1, '{"at":1,"files":[]}');
    INSERT INTO settings(key, value, updated_at)
      VALUES (
        'studio.permissions.policy',
        '{"version":1,"sessions":{"44":{"preset":"full"}}}',
        1
      );
    INSERT INTO conversation_metric_requests(
      request_id, conversation_id, started_at, finished_at, status,
      provider_id, model_id, tps, ttft_ms, duration_ms,
      input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost
    ) VALUES (
      'request-1', '44', 1, 6000, 'done',
      'test', 'model', 10, 500, 5900,
      1, 1, 0, 0, 0
    );
    PRAGMA user_version = 9;
  `);
  legacy.close();

  const db = createStudioDatabase(filename);
  try {
    const row = db.getConversation('44');
    assert.match(row.publicId, uuidPattern);
    assert.equal(db.getConversation(row.publicId).id, '44');
    assert.equal(db.getConversation(row.publicId).lastDurationMs, 5_900);
    assert.equal(db.readTurnDiffs(row.publicId).length, 1);
    assert.equal(db.readTurnDiffs('44').length, 0);
    assert.equal(
      db.getSetting('studio.permissions.policy').sessions[row.publicId].preset,
      'full',
    );
    assert.equal(db.getSetting('studio.permissions.policy').sessions['44'], undefined);
  } finally {
    db.close();
  }
});
