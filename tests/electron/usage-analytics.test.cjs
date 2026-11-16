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
  usageModelMix,
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

test('project filters cover costs, streaks, daily models and removed workspaces across restart', () => {
  const filename = path.join(temporary, 'project-scopes.sqlite');
  let database = createStudioDatabase(filename);
  const a = path.join(temporary, 'a', 'app'), b = path.join(temporary, 'b', 'app');
  database.insertConversation({ id: '1', workspace: a, kind: 'conversation' });
  database.insertConversation({ id: '2', workspace: b, kind: 'conversation' });
  database.upsertWorkspace({ cwd: a, name: '历史项目' });
  database.db.exec(`CREATE TABLE durable_conversations (id INTEGER PRIMARY KEY, owner_conversation_id INTEGER);
    INSERT INTO durable_conversations VALUES (1, NULL), (3, 1), (4, 3)`);
  const now = new Date(2026, 9, 30, 12).getTime();
  const common = { at: now, providerId: 'test', modelId: 'same', input: 6, output: 4, cost: 0.25 };
  for (const [requestId, conversationId] of [['root', '1'], ['agent', '4'], ['other', '2'], ['unknown', '']]) {
    assert.equal(database.recordUsageRequest({ ...common, requestId, conversationId }), true);
  }
  assert.equal(database.recordUsageRequest({ ...common, requestId: 'agent', conversationId: '2' }), false);
  database.deleteConversation('1');
  database.removeWorkspace(a);
  database.close();
  database = createStudioDatabase(filename);
  for (const [scope, expected] of [[{}, 4], [{ workspace: a }, 2], [{ workspace: b }, 1],
    [{ workspace: '' }, 1], [{ includeRemoved: false }, 2], [{ workspace: a, includeRemoved: false }, 0]]) {
    const summary = usageAnalyticsSnapshot({ database, now, ...scope });
    const mix = usageModelMix({ database, now, all: true, ...scope });
    assert.equal(summary.allTime.requests, expected);
    assert.equal(summary.allTime.currentStreak, expected ? 1 : 0);
    assert.equal(summary.range.totalTokens, expected * 10);
    assert.equal(summary.range.cost, expected * 0.25);
    assert.equal(summary.daily[0]?.requests || 0, expected);
    assert.equal(summary.dailyModels[0]?.cost || 0, expected * 0.25);
    assert.equal(mix.totals.cost, expected * 0.25);
    assert.equal(mix.models[0]?.requests || 0, expected);
    assert.deepEqual(summary.projects.find(p => p.workspace === a), { workspace: a, name: '历史项目', removed: true });
  }
  database.upsertWorkspace({ cwd: a, name: '重开的项目' });
  assert.equal(database.usageTotals({ includeRemoved: false }).requests, 4);
  assert.deepEqual(database.usageProjects().find(p => p.workspace === a), { workspace: a, name: '重开的项目', removed: false });
  database.close();
});

test('v19 usage migrates verified request portions and retains unassignable totals exactly once', () => {
  const filename = path.join(temporary, 'project-migration.sqlite');
  let database = createStudioDatabase(filename);
  const workspace = path.join(temporary, 'recoverable');
  database.insertConversation({ id: '1', workspace, kind: 'conversation' });
  const at = new Date(2026, 9, 30, 12).getTime();
  const detail = { at, conversationId: '1', providerId: 'one', modelId: 'model', input: 5, output: 2, cost: 0.25 };
  database.recordMetricRequest({ ...detail, requestId: 'verified' });
  database.recordMetricRequest({ ...detail, requestId: 'no-replay-record' });
  database.recordMetricRequest({ ...detail, requestId: 'wrong-time' });
  database.recordMetricRequest({ ...detail, requestId: 'too-large', input: 500 });
  database.db.exec(`DROP TABLE usage_daily;
    CREATE TABLE usage_daily(day, provider_id, model_id, input_tokens, output_tokens, cache_read_tokens,
      cache_write_tokens, cost, requests, updated_at, PRIMARY KEY(day, provider_id, model_id));
    INSERT INTO usage_daily VALUES ('2026-10-30', 'one', 'model', 15, 6, 0, 0, 0.75, 3, ${at});
    INSERT INTO usage_request_ledger VALUES ('verified', ${at}), ('wrong-time', ${at + 1}), ('too-large', ${at});
    PRAGMA user_version = 19`);
  database.close();
  for (let pass = 0; pass < 2; pass++) {
    database = createStudioDatabase(filename);
    assert.equal(database.usageTotals().totalTokens, 21);
    assert.equal(database.usageTotals().cost, 0.75);
    assert.equal(database.usageTotals({ workspace }).totalTokens, 7);
    assert.equal(database.usageTotals({ workspace: '' }).totalTokens, 14);
    assert.equal(database.usageTotals({ workspace: '' }).cost, 0.5);
    assert.equal(database.recordUsageRequest({ ...detail, requestId: 'verified' }), false);
    database.close();
  }
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
    usageModelMix({ days: 30, now: Date.parse('2026-10-30T18:00:00+08:00') }).models
      .map((model) => [model.modelId, model.displayName, model.totalTokens]),
    [
      ['glm-5.3-flash', 'GLM-5.3 Flash', 280],
      ['deepseek-flash', 'DeepSeek V4.1 Flash', 230],
    ],
  );
});

test('model mix answers every window the settings page offers', () => {
  const database = createStudioDatabase(path.join(temporary, 'model-mix.sqlite'));
  database.upsertProvider({
    id: 'mix-provider',
    name: 'Mix Provider',
    baseUrl: 'https://mix.example.test/v1',
    api: 'openai-completions',
    enabled: true,
  });
  database.upsertModel({
    providerId: 'mix-provider',
    modelId: 'mix-model',
    name: 'Mix Model',
    api: 'openai-completions',
    enabled: true,
  });
  const record = (requestId, day, input) => database.recordUsageRequest({
    requestId,
    day,
    at: Date.parse(`${day}T12:00:00+08:00`),
    providerId: 'mix-provider',
    modelId: 'mix-model',
    input,
    output: 0,
  });
  record('mix-old', '2025-01-04', 1_000);
  record('mix-mid', '2026-10-15', 200);
  record('mix-today', '2026-10-30', 30);
  const now = Date.parse('2026-10-30T18:00:00+08:00');

  const all = usageModelMix({ all: true, database, now });
  assert.deepEqual(all.window, { all: true, days: null, sinceDay: null, untilDay: null });
  assert.equal(all.totals.totalTokens, 1_230);
  assert.equal(all.models.length, 1);
  assert.equal(all.models[0].totalTokens, 1_230);
  assert.equal(all.models[0].displayName, 'Mix Model');
  assert.equal(all.models[0].requests, 3);

  const today = usageModelMix({ database, now, sinceDay: '2026-10-30', untilDay: '2026-10-30' });
  assert.deepEqual(today.window, {
    all: false,
    days: 1,
    sinceDay: '2026-10-30',
    untilDay: '2026-10-30',
  });
  assert.equal(today.totals.totalTokens, 30);
  assert.equal(today.models[0].requests, 1);

  const custom = usageModelMix({ database, now, sinceDay: '2026-10-01', untilDay: '2026-10-15' });
  assert.deepEqual(custom.window, {
    all: false,
    days: 15,
    sinceDay: '2026-10-01',
    untilDay: '2026-10-15',
  });
  assert.equal(custom.totals.totalTokens, 200);
  assert.equal(custom.models[0].requests, 1);

  // A reversed or malformed range collapses onto a readable single-day window.
  const messy = usageModelMix({ database, now, sinceDay: '2026-10-30', untilDay: '2026-02-30' });
  assert.deepEqual(messy.window.sinceDay, '2026-10-30');
  assert.equal(messy.window.days, 1);
  assert.equal(messy.totals.totalTokens, 30);
  database.close();
});

test('calculates current and longest local-day streaks', () => {
  const activeDays = new Set(['2026-10-27', '2026-10-28', '2026-10-30']);
  assert.equal(currentStreak(activeDays, Date.parse('2026-10-30T20:00:00+08:00')), 1);
  assert.equal(longestStreak(activeDays), 2);
  assert.equal(currentStreak(new Set(), Date.now()), 0);
});
