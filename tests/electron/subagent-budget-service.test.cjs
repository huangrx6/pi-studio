const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-studio-budget-service-'));
process.env.PI_STUDIO_DB = path.join(temporary, 'studio.sqlite');
const { getStudioDatabase, closeStudioDatabase } = require('../../electron/core/studio-db.cjs');
const { setSubagentConfig } = require('../../electron/core/app-settings.cjs');
test.after(() => { closeStudioDatabase(); fs.rmSync(temporary, { recursive: true, force: true }); });

test('budget endpoint resolves public IDs and uses the stored workspace scope', async () => {
  const durable = await import('@earendil-works/pi-durable');
  const db = getStudioDatabase();
  const workspace = path.join(temporary, 'workspace');
  const parent = db.insertConversation({ id: '100', workspace, kind: 'conversation' });
  db.recordMetricRequest({ requestId: 'child-1', conversationId: '200', input: 40, cost: 0.25 });
  setSubagentConfig('user', '', { budgetTokens: 100 });
  setSubagentConfig('project', workspace, { budgetTokens: 30 });
  const original = Module._load;
  let requestedId;
  Module._load = function load(request, ...rest) {
    if (request === './durable-runtime.cjs') return { getDurableRuntime: async () => ({
      durable, context: {}, harness: { snapshot: async (_doc, id) => {
        requestedId = id;
        return { agents: { first: { conversationId: 200 }, alias: { conversationId: 200 } } };
      } },
    }) };
    return original.call(this, request, ...rest);
  };
  let service;
  try { service = require('../../electron/services/subagent-settings.cjs'); }
  finally { Module._load = original; }
  const result = await service.subagentBudgetSnapshot(parent.publicId, '/unrelated-workspace');
  assert.equal(requestedId, 100);
  assert.equal(result.parentConversationId, parent.publicId);
  assert.equal(result.tokens, 40);
  assert.equal(result.requests, 1);
  assert.equal(result.budgetTokens, 30);
  assert.equal(result.exceeded, true);
});
