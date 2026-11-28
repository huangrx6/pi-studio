const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { PlanStore } = require('../../electron/main/core/plan-store.cjs');
const { openDurableStorage } = require('../../electron/main/runtime/durable-storage.cjs');
const { getStudioDatabase, closeStudioDatabase } = require('../../electron/main/core/studio-db.cjs');

test('scheduled project runs use Durable admission, recover committed answers and release cancelled provider work', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-plan-durable-'));
  const filename = path.join(dir, 'studio.sqlite');
  process.env.PI_STUDIO_DB = filename;
  const studio = getStudioDatabase();
  studio.upsertWorkspace({ cwd: dir });
  const store = new PlanStore(studio);
  const durable = await import('@earendil-works/pi-durable');
  const { BACKGROUND_CONTEXT: context } = await import('@earendil-works/chord/context');
  const { createModels, fauxProvider, fauxAssistantMessage } = await import('@earendil-works/pi-ai');
  const faux = fauxProvider({ provider: 'faux', models: [{ id: 'project-model', name: 'Project model' }] });
  const models = createModels();
  models.setProvider(faux.provider);
  const registry = durable.createRegistry();
  const longTask = require('../../electron/main/capabilities/long-task/index.cjs').createLongTaskExtension(durable);
  registry.install(longTask);
  const released = [];
  let harness, storage;
  async function openRuntime() {
    storage = await openDurableStorage(filename, { prefix: 'durable_' });
    harness = await durable.Harness.open(storage, { models, registry }, context);
    harness.resume();
  }
  async function closeRuntime() { await harness.close(context); await storage.close(); }
  await openRuntime();
  t.after(async () => { await closeRuntime(); closeStudioDatabase(); fs.rmSync(dir, { recursive: true, force: true }); });
  const source = require('../../electron/main/runtime/durable-runtime.cjs');
  t.mock.method(source, 'getDurableRuntime', async () => ({
    durable, context, storage, harness, cleanupSessionResources: id => released.push(id),
  }));
  const reconciled = t.mock.method(source, 'reconcileRuntimeForWorkspace', async () => {});
  t.mock.method(require('../../electron/main/runtime/tool-selection.cjs'), 'runtimeSelection', async () => ({ extensions: [], tools: [] }));
  t.mock.method(require('../../electron/main/core/studio-models.cjs'), 'getStudioModelsRuntime', async () => ({ models }));
  const model = { modelRef: 'faux/project-model', thinkingLevel: 'default', effectiveThinkingLevel: 'off' };
  const service = require('../../electron/main/services/models.cjs');
  t.mock.method(service, 'modelInfo', async cwd => { assert.equal(cwd, dir); return model; });
  t.mock.method(service, 'sessionModelInfo', async () => model);

  const { executePlanRun } = require('../../electron/main/runtime/plan-run.cjs');
  const now = Date.now();
  const planId = store.save({ name: 'Weekly notes', workspace: dir, prompt: 'Summarize the project',
    schedule: { kind: 'daily', time: '09:00', zone: 'UTC' } }, now);
  const id = store.runNow(planId, now);
  const run = store.claim(now);
  const options = { signal: new AbortController().signal, bindSession: id => store.bindSession(run.id, id) };
  let calls = 0;
  faux.setResponses([() => { calls++; return fauxAssistantMessage('The build is green.'); }]);
  const answer = await executePlanRun(run, options);
  assert.deepEqual(answer, { status: 'succeeded', detail: 'The build is green.' });
  const row = studio.getConversation(id);
  assert.equal(row.archived, true);
  assert.equal(row.workspace, dir);
  assert.equal(reconciled.mock.calls.some(call => call.arguments[1]?.verifyExtensionIntegrity), true);
  assert.equal(released.length, 1);
  const providerId = released[0];
  assert.ok(typeof providerId === 'string' && providerId);

  // Reopen both sides of the Durable boundary before Studio has recorded the terminal status.
  await closeRuntime();
  await openRuntime();
  const recovered = store.claim(now + 1);
  assert.equal(recovered.session_id, id);
  assert.deepEqual(await executePlanRun(recovered, options), answer);
  assert.equal(calls, 1);
  assert.equal(studio.listConversations().length, 1);
  store.finish(id, answer.status, answer.detail, now + 1);
  assert.equal(store.history().items[0].sessionId, id);
  assert.equal(released[1], providerId);

  const next = store.runNow(planId, now + 2);
  const nextRun = store.claim(now + 2);
  const controller = new AbortController();
  const started = Promise.withResolvers();
  const stopped = Promise.withResolvers();
  faux.setResponses([async (_context, options) => {
    started.resolve();
    if (!options.signal.aborted) await new Promise(resolve => options.signal.addEventListener('abort', resolve, { once: true }));
    stopped.resolve();
    return fauxAssistantMessage('', { stopReason: 'aborted' });
  }]);
  const execution = executePlanRun(nextRun, { signal: controller.signal, bindSession: id => store.bindSession(next, id) });
  await started.promise;
  controller.abort(new Error('cancel fixture'));
  await assert.rejects(execution);
  await stopped.promise;
  assert.equal(released.length, 3);
  assert.notEqual(released.at(-1), providerId);
  const after = await harness.inspect(context);
  assert.deepEqual(after.tasks, []);
});
