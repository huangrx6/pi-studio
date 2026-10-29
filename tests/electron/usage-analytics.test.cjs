const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { after, before, test } = require('node:test');

const {
  SCHEMA_VERSION,
  USAGE_REQUEST_LEDGER_LIMIT,
  closeStudioDatabase,
  createStudioDatabase,
  getStudioDatabase,
} = require('../../electron/core/studio-db.cjs');
const {
  currentStreak,
  longestStreak,
  usageAnalyticsSnapshot,
} = require('../../electron/services/usage-analytics.cjs');

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-studio-usage-'));
const previousDatabase = process.env.PI_STUDIO_DB;

before(() => {
  process.env.PI_STUDIO_DB = path.join(temporary, 'analytics.sqlite');
});

after(() => {
  closeStudioDatabase();
  if (previousDatabase === undefined) delete process.env.PI_STUDIO_DB;
  else process.env.PI_STUDIO_DB = previousDatabase;
  fs.rmSync(temporary, { recursive: true, force: true });
});

test('records each Durable request once and persists daily rollups', () => {
  const filename = path.join(temporary, 'requests.sqlite');
  let database = createStudioDatabase(filename);
  const request = {
    requestId: 'trace-1.1',
    day: '2026-10-30',
    at: Date.parse('2026-10-30T10:00:00+08:00'),
    providerId: 'deepseek',
    modelId: 'deepseek-flash',
    input: 1_000,
    output: 240,
    cacheRead: 300,
    cacheWrite: 40,
    cost: 0.00125,
  };
  assert.equal(database.recordUsageRequest(request), true);
  assert.equal(database.recordUsageRequest(request), false);
  assert.equal(database.usageTotals().requests, 1);
  assert.equal(database.usageTotals().totalTokens, 1_580);
  assert.equal(database.usageDaily()[0].day, '2026-10-30');
  assert.equal(database.usageModels()[0].modelId, 'deepseek-flash');
  assert.deepEqual(
    database.db.prepare('PRAGMA table_info(usage_request_ledger)').all().map((row) => row.name),
    ['request_id', 'recorded_at'],
  );
  assert.equal(
    database.db.prepare(`
      SELECT COUNT(*) AS count FROM sqlite_master
      WHERE type = 'table' AND name = 'usage_requests'
    `).get().count,
    0,
  );
  database.close();

  database = createStudioDatabase(filename);
  assert.equal(database.usageTotals().requests, 1);
  assert.equal(database.usageDaily()[0].output, 240);
  database.close();
});

test('rolls many same-day model calls into one compact daily row', () => {
  const filename = path.join(temporary, 'same-day.sqlite');
  const database = createStudioDatabase(filename);
  const at = Date.parse('2026-10-30T10:00:00+08:00');
  for (let index = 0; index < 500; index += 1) {
    assert.equal(database.recordUsageRequest({
      requestId: `same-day-${index}`,
      day: '2026-10-30',
      at,
      providerId: 'deepseek',
      modelId: 'deepseek-flash',
      input: 10,
      output: 2,
    }), true);
  }
  assert.equal(database.usageTotals().requests, 500);
  assert.equal(database.usageTotals().totalTokens, 6_000);
  assert.equal(
    database.db.prepare('SELECT COUNT(*) AS count FROM usage_daily').get().count,
    1,
  );
  assert.equal(
    database.db.prepare('SELECT COUNT(*) AS count FROM usage_request_ledger').get().count,
    500,
  );
  database.close();
});

test('caps the replay ledger while preserving daily analytics', () => {
  const filename = path.join(temporary, 'bounded-ledger.sqlite');
  const database = createStudioDatabase(filename);
  const insert = database.db.prepare(`
    INSERT INTO usage_request_ledger(request_id, recorded_at) VALUES (?, ?)
  `);
  database.transaction(() => {
    for (let index = 0; index < USAGE_REQUEST_LEDGER_LIMIT + 321; index += 1) {
      insert.run(`bounded-${index}`, index);
    }
  });
  database.pruneUsageRequestLedger();
  assert.equal(
    database.db.prepare('SELECT COUNT(*) AS count FROM usage_request_ledger').get().count,
    USAGE_REQUEST_LEDGER_LIMIT,
  );
  assert.equal(
    database.db.prepare(`
      SELECT COUNT(*) AS count FROM usage_request_ledger WHERE request_id = 'bounded-0'
    `).get().count,
    0,
  );
  assert.equal(
    database.db.prepare(`
      SELECT COUNT(*) AS count
      FROM usage_request_ledger
      WHERE request_id = ?
    `).get(`bounded-${USAGE_REQUEST_LEDGER_LIMIT + 320}`).count,
    1,
  );
  database.close();
});

test('migrates detailed request rows into the compact replay ledger', () => {
  const filename = path.join(temporary, 'legacy-details.sqlite');
  const legacy = new DatabaseSync(filename);
  legacy.exec(`
    CREATE TABLE usage_requests (
      request_id TEXT PRIMARY KEY,
      day TEXT NOT NULL,
      at INTEGER NOT NULL,
      provider_id TEXT NOT NULL,
      model_id TEXT NOT NULL,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      cache_read_tokens INTEGER NOT NULL DEFAULT 0,
      cache_write_tokens INTEGER NOT NULL DEFAULT 0,
      cost REAL NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE usage_daily (
      day TEXT NOT NULL,
      provider_id TEXT NOT NULL,
      model_id TEXT NOT NULL,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      cache_read_tokens INTEGER NOT NULL DEFAULT 0,
      cache_write_tokens INTEGER NOT NULL DEFAULT 0,
      cost REAL NOT NULL DEFAULT 0,
      requests INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (day, provider_id, model_id)
    );
    INSERT INTO usage_requests VALUES (
      'legacy-request', '2026-10-30', 1793325600000,
      'deepseek', 'deepseek-flash', 120, 30, 10, 2, 0.001, 1793325600000
    );
    INSERT INTO usage_daily VALUES (
      '2026-10-30', 'deepseek', 'deepseek-flash',
      120, 30, 10, 2, 0.001, 1, 1793325600000
    );
    PRAGMA user_version = 8;
  `);
  legacy.close();

  const database = createStudioDatabase(filename);
  assert.equal(
    database.db.prepare('PRAGMA user_version').get().user_version,
    SCHEMA_VERSION,
  );
  assert.equal(database.usageTotals().requests, 1);
  assert.deepEqual(
    database.db.prepare('SELECT request_id FROM usage_request_ledger').all()
      .map((row) => row.request_id),
    ['legacy-request'],
  );
  assert.equal(
    database.db.prepare(`
      SELECT COUNT(*) AS count FROM sqlite_master
      WHERE type = 'table' AND name = 'usage_requests'
    `).get().count,
    0,
  );
  database.close();
});

test('keeps used models available after their catalog entry is deleted', () => {
  const filename = path.join(temporary, 'deleted-model.sqlite');
  const database = createStudioDatabase(filename);
  database.upsertProvider({
    id: 'removed-provider',
    name: 'Removed Provider',
    baseUrl: 'https://removed.example.test/v1',
    api: 'openai-completions',
    enabled: true,
  });
  database.upsertModel({
    providerId: 'removed-provider',
    modelId: 'removed-model',
    name: 'Removed Model',
    api: 'openai-completions',
    enabled: true,
  });
  database.recordUsageRequest({
    requestId: 'removed-model-request',
    day: '2026-10-30',
    at: Date.parse('2026-10-30T12:00:00+08:00'),
    providerId: 'removed-provider',
    modelId: 'removed-model',
    input: 80,
    output: 20,
  });
  database.deleteModel('removed-provider', 'removed-model');

  const snapshot = usageAnalyticsSnapshot({
    database,
    days: 30,
    now: Date.parse('2026-10-30T18:00:00+08:00'),
  });
  assert.deepEqual(
    snapshot.filterModels.map((model) => ({
      id: model.modelId,
      enabled: model.enabled,
      inUse: model.inUse,
    })),
    [{ id: 'removed-model', enabled: false, inUse: true }],
  );
  assert.equal(snapshot.dailyModels[0].totalTokens, 100);
  database.close();
});

test('separates models while keeping all-time and range totals', () => {
  const database = getStudioDatabase();
  database.upsertProvider({
    id: 'deepseek',
    name: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com',
    api: 'openai-completions',
    enabled: true,
  });
  database.upsertProvider({
    id: 'zhipu',
    name: '智谱 AI',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    api: 'openai-completions',
    enabled: true,
  });
  database.upsertModel({
    providerId: 'deepseek',
    modelId: 'deepseek-flash',
    name: 'DeepSeek V4.1 Flash',
    api: 'openai-completions',
    enabled: true,
  });
  database.upsertModel({
    providerId: 'zhipu',
    modelId: 'glm-5.3-flash',
    name: 'GLM-5.3 Flash',
    api: 'openai-completions',
    enabled: true,
  });
  database.recordUsageRequest({
    requestId: 'request-a',
    day: '2026-10-29',
    at: Date.parse('2026-10-29T12:00:00+08:00'),
    providerId: 'deepseek',
    modelId: 'deepseek-flash',
    input: 100,
    output: 50,
  });
  database.recordUsageRequest({
    requestId: 'request-b',
    day: '2026-10-30',
    at: Date.parse('2026-10-30T12:00:00+08:00'),
    providerId: 'zhipu',
    modelId: 'glm-5.3-flash',
    input: 200,
    output: 80,
  });
  database.recordUsageRequest({
    requestId: 'request-c',
    day: '2026-10-30',
    at: Date.parse('2026-10-30T13:00:00+08:00'),
    providerId: 'deepseek',
    modelId: 'deepseek-flash',
    input: 60,
    output: 20,
  });
  database.upsertModel({
    providerId: 'zhipu',
    modelId: 'glm-5.3-flash',
    enabled: false,
  });

  const snapshot = usageAnalyticsSnapshot({
    days: 30,
    now: Date.parse('2026-10-30T18:00:00+08:00'),
  });
  assert.equal(snapshot.allTime.totalTokens, 510);
  assert.equal(snapshot.allTime.activeDays, 2);
  assert.equal(snapshot.range.requests, 3);
  assert.equal(snapshot.daily.length, 2);
  assert.equal(snapshot.dailyModels.length, 3);
  assert.deepEqual(
    snapshot.filterModels.map((model) => [model.modelId, model.enabled, model.inUse]),
    [
      ['deepseek-flash', true, true],
      ['glm-5.3-flash', false, true],
    ],
  );
  assert.deepEqual(
    snapshot.models.map((model) => [model.modelId, model.displayName, model.totalTokens]),
    [
      ['glm-5.3-flash', 'GLM-5.3 Flash', 280],
      ['deepseek-flash', 'DeepSeek V4.1 Flash', 230],
    ],
  );
});

test('calculates current and longest local-day streaks', () => {
  const activeDays = new Set(['2026-10-27', '2026-10-28', '2026-10-30']);
  assert.equal(currentStreak(activeDays, Date.parse('2026-10-30T20:00:00+08:00')), 1);
  assert.equal(longestStreak(activeDays), 2);
  assert.equal(currentStreak(new Set(), Date.now()), 0);
});
