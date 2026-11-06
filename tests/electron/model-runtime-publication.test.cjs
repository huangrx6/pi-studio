const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const vm = require('node:vm');
const test = require('node:test');

const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const tick = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
function harness() {
  const builds = [], db = { isOpen: () => true };
  const file = path.resolve(__dirname, '../../electron/core/studio-models.cjs');
  const source = fs.readFileSync(file, 'utf8');
  const module = { exports: {} }, sourceRequire = Module.createRequire(file);
  // Exercise production initialize/rebuild/close and publication state. Only the
  // expensive builder is replaced, so completions can be ordered deterministically.
  vm.runInNewContext(source + '\nbuildRuntime = globalThis.controlledBuilder;', {
    module, exports: module.exports,
    controlledBuilder() { const pending = deferred(); builds.push(pending); return pending.promise; },
    require(id) { if (id === './studio-db.cjs') return { getStudioDatabase: () => db }; if (id === './model-metadata.cjs') return {}; return sourceRequire(id); },
  }, { filename: file });
  const runtime = id => ({ id, db, models: { id }, credentials: { id } });
  return { api: module.exports, builds, runtime };
}

test('late older rebuild success cannot overwrite the newest published runtime or increment its revision', async () => {
  const { api, builds, runtime } = harness(); const old = api.rebuildStudioModels(), newer = api.rebuildStudioModels();
  const latest = runtime('latest'); builds[1].resolve(latest); assert.equal(await newer, latest.models);
  builds[0].resolve(runtime('obsolete')); assert.equal(await old, latest.models);
  assert.equal(api.getStudioModelsRuntimeSync(), latest); assert.equal(api.studioModelsRevision(), 1);
  assert.equal(await api.getStudioModelsRuntime(), latest);
});

test('an older rebuild finishing first waits for the newest request instead of reporting stale success', async () => {
  const { api, builds, runtime } = harness(); let settled = false;
  const old = api.rebuildStudioModels().then(value => { settled = true; return value; }), newer = api.rebuildStudioModels();
  builds[0].resolve(runtime('obsolete')); await tick(); assert.equal(settled, false); assert.equal(api.getStudioModelsRuntimeSync(), undefined);
  const latest = runtime('latest'); builds[1].resolve(latest);
  assert.equal(await old, latest.models); assert.equal(await newer, latest.models); assert.equal(api.studioModelsRevision(), 1);
});

test('initialization and rebuild share publication ordering and an obsolete initialization cannot clear newer pending work', async () => {
  const { api, builds, runtime } = harness(); const initial = api.initializeStudioModels(), rebuilding = api.rebuildStudioModels();
  builds[0].resolve(runtime('old-initial')); await tick();
  const getter = api.getStudioModelsRuntime(); assert.equal(builds.length, 2);
  const latest = runtime('rebuilt'); builds[1].resolve(latest);
  assert.equal(await initial, latest); assert.equal(await getter, latest); assert.equal(await rebuilding, latest.models);
  assert.equal(api.getStudioModelsRuntimeSync(), latest); assert.equal(api.studioModelsRevision(), 1);
});

test('late initialization failure follows a newer successful rebuild instead of breaking current readers', async () => {
  const { api, builds, runtime } = harness(); const initial = api.initializeStudioModels(), rebuilding = api.rebuildStudioModels();
  const latest = runtime('rebuilt'); builds[1].resolve(latest); await rebuilding;
  builds[0].reject(new Error('obsolete import failed')); assert.equal(await initial, latest);
  assert.equal(api.getStudioModelsRuntimeSync(), latest);
});

test('latest failure stays a failure for superseded callers, retains last published runtime, and allows recovery', async () => {
  const { api, builds, runtime } = harness(); const stable = runtime('stable');
  const initial = api.initializeStudioModels(); builds[0].resolve(stable); await initial;
  const old = api.rebuildStudioModels(), latest = api.rebuildStudioModels();
  const latestFailure = assert.rejects(latest, /latest failure/); const oldFailure = assert.rejects(old, /latest failure/);
  builds[2].reject(new Error('latest failure')); await latestFailure; builds[1].resolve(runtime('obsolete-success')); await oldFailure;
  assert.equal(api.getStudioModelsRuntimeSync(), stable); assert.equal(api.studioModelsRevision(), 1);
  const recovery = api.rebuildStudioModels(), recovered = runtime('recovered'); builds[3].resolve(recovered); await recovery;
  assert.equal(api.getStudioModelsRuntimeSync(), recovered); assert.equal(api.studioModelsRevision(), 2);
});

test('a failed first initialization can retry and closing invalidates pending publication', async () => {
  const { api, builds, runtime } = harness(); const initial = api.initializeStudioModels();
  const failed = assert.rejects(initial, /first failure/); builds[0].reject(new Error('first failure')); await failed;
  const retry = api.initializeStudioModels(); assert.equal(builds.length, 2); const current = runtime('retry'); builds[1].resolve(current); assert.equal(await retry, current);
  const pending = api.rebuildStudioModels(); api.closeStudioModelsRuntime();
  const closed = assert.rejects(pending, /运行时已关闭/); builds[2].resolve(runtime('after-close')); await closed;
  assert.equal(api.getStudioModelsRuntimeSync(), undefined); assert.equal(api.studioModelsRevision(), 1);
  const reopened = api.initializeStudioModels(), next = runtime('reopened'); builds[3].resolve(next); assert.equal(await reopened, next);
});
