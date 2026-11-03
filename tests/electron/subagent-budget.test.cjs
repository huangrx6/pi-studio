const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-studio-subagent-budget-'));
process.env.PI_STUDIO_DB = path.join(temporary, 'studio.sqlite');

const { evaluateSubagentBudget } = require('../../electron/core/subagent-budget.cjs');
const {
  closeStudioDatabase,
  getStudioDatabase,
  createStudioDatabase,
} = require('../../electron/core/studio-db.cjs');

test.after(() => {
  closeStudioDatabase();
  fs.rmSync(temporary, { recursive: true, force: true });
});

test('accounting survives UI history pruning, old replays and database reopen', () => {
  const filename = path.join(temporary, 'lifetime.sqlite');
  let db = createStudioDatabase(filename);
  const record = (index) => ({
    requestId: `lifetime-${index}`, conversationId: '91', at: index * 1000,
    input: 10, output: 5, cacheRead: 3, cacheWrite: 2, cost: 0.25,
  });
  try {
    for (let index = 1; index <= 20; index += 1) db.recordMetricRequest(record(index));
    assert.equal(db.listMetricRequests({ conversationId: '91' }).length, 8);
    assert.deepEqual(db.metricTotalsForConversation(91), { requests: 20, tokens: 400, cost: 5 });
    db.close();
    db = createStudioDatabase(filename);
    assert.equal(db.recordMetricRequest(record(1)), false);
    const row = db.insertConversation({ id: '91', kind: 'conversation', workspace: temporary });
    assert.deepEqual(db.metricTotalsForConversation(row.publicId), { requests: 20, tokens: 400, cost: 5 });
    db.deleteConversation(row.publicId);
    assert.deepEqual(db.metricTotalsForConversation(91), { requests: 0, tokens: 0, cost: 0 });
  } finally { db.close(); }
});

test('v17 migration seeds accounting from retained v16 telemetry exactly once', () => {
  const filename = path.join(temporary, 'migration.sqlite');
  let db = createStudioDatabase(filename);
  try {
    db.recordMetricRequest({ requestId: 'migrate-1', conversationId: '92', input: 9, cost: 0.5 });
    db.db.exec('DROP TABLE conversation_metric_ledger; PRAGMA user_version = 16');
    db.close();
    db = createStudioDatabase(filename);
    assert.deepEqual(db.metricTotalsForConversation(92), { requests: 1, tokens: 9, cost: 0.5 });
    assert.equal(db.recordMetricRequest({ requestId: 'migrate-1', conversationId: '92', input: 9 }), false);
  } finally { db.close(); }
});

test('token and cost budgets are independent and zero disables a dimension', () => {
  assert.equal(evaluateSubagentBudget(
    { budgetTokens: 1_000, budgetCostUsd: 0, budgetAction: 'warn' },
    { tokens: 1_000, costUsd: 0 },
  ).exceeded, true);
  assert.equal(evaluateSubagentBudget(
    { budgetTokens: 0, budgetCostUsd: 1, budgetAction: 'stop' },
    { tokens: 100_000, costUsd: 0 },
  ).exceeded, false);
  assert.equal(evaluateSubagentBudget(
    { budgetTokens: 0, budgetCostUsd: 1, budgetAction: 'stop' },
    { tokens: 5, costUsd: 1 },
  ).exceeded, true);
});

test('warning budget reports excess without changing the action; stop remains explicit', () => {
  const warning = evaluateSubagentBudget(
    { budgetTokens: 100, budgetAction: 'warn' },
    { tokens: 150 },
  );
  const stop = evaluateSubagentBudget(
    { budgetTokens: 100, budgetAction: 'stop' },
    { tokens: 150 },
  );
  assert.equal(warning.exceeded, true);
  assert.equal(warning.budgetAction, 'warn');
  assert.equal(stop.exceeded, true);
  assert.equal(stop.budgetAction, 'stop');
});

test('metric ledger aggregates actual child requests once without estimating cost', () => {
  const db = getStudioDatabase();
  const at = Date.UTC(2026, 10, 3, 4, 0, 0);
  db.recordMetricRequest({
    requestId: 'child-request-1',
    conversationId: '73',
    at,
    input: 120,
    output: 80,
    cost: 0,
  });
  db.recordMetricRequest({
    requestId: 'child-request-1',
    conversationId: '73',
    at: at + 1_000,
    input: 999,
    output: 999,
    cost: 99,
  });
  db.recordMetricRequest({
    requestId: 'child-request-2',
    conversationId: '73',
    at: at + 2_000,
    input: 40,
    output: 10,
    cost: 0,
  });
  assert.deepEqual(db.metricTotalsForConversation(73), {
    requests: 2,
    tokens: 250,
    cost: 0,
  });
  assert.equal(evaluateSubagentBudget(
    { budgetTokens: 0, budgetCostUsd: 1, budgetAction: 'warn' },
    db.metricTotalsForConversation(73),
  ).exceeded, false);
});
