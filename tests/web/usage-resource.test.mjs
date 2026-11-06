import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import ts from 'typescript';

// Execute the actual hook with a small effect lifecycle driver. No DOM or new dependency.
function harness() {
  let state;
  let previousDeps;
  let cleanup;
  let effect;
  const react = {
    useState(initial) { state ??= initial; return [state, update => { state = typeof update === 'function' ? update(state) : update; }]; },
    useEffect(next, deps) {
      if (!previousDeps || deps.some((dep, index) => !Object.is(dep, previousDeps[index]))) {
        effect = next;
        previousDeps = deps;
      }
    },
  };
  const module = { exports: {} };
  const source = fs.readFileSync(new URL('../../web/src/features/usage/use-usage-resource.ts', import.meta.url), 'utf8');
  vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, {
    Error, module, exports: module.exports, require(name) { assert.equal(name, 'react'); return react; },
  });
  return {
    render(active, key, retry, load) { return module.exports.useUsageResource(active, key, retry, load); },
    commit() { if (effect) { cleanup?.(); cleanup = effect(); effect = null; } },
    unmount() { cleanup?.(); },
  };
}
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const flush = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };

test('new range immediately hides old numbers and ignores old completion even after new failure', async () => {
  const h = harness();
  const a = deferred(), b = deferred();
  const loadA = () => a.promise, loadB = () => b.promise;
  h.render(true, 'all', 0, loadA); h.commit();
  const next = h.render(true, '30', 0, loadB);
  assert.equal(next.value, null); assert.equal(next.pending, true);
  h.commit();
  b.reject(new Error('offline')); await flush();
  a.resolve({ total: 999 }); await flush();
  const failed = h.render(true, '30', 0, loadB);
  assert.equal(failed.value, null); assert.equal(failed.error, 'offline'); assert.equal(failed.pending, false);
});

test('same-range refresh keeps explicitly stale data and preserves it after failure; retry replaces it', async () => {
  const h = harness();
  let call = deferred();
  const load = () => call.promise;
  h.render(true, '90', 0, load); h.commit(); call.resolve({ total: 10 }); await flush();
  assert.equal(h.render(true, '90', 0, load).value.total, 10);
  call = deferred(); h.render(true, '90', 1, load); h.commit();
  assert.equal(h.render(true, '90', 1, load).pending, true);
  call.reject(new Error('refresh failed')); await flush();
  const old = h.render(true, '90', 1, load);
  assert.equal(old.value.total, 10); assert.equal(old.error, 'refresh failed');
  call = deferred(); h.render(true, '90', 2, load); h.commit(); call.resolve({ total: 20 }); await flush();
  const current = h.render(true, '90', 2, load);
  assert.equal(current.value.total, 20); assert.equal(current.error, null);
});

test('deactivation and unmount invalidate results without starting background reads', async () => {
  const h = harness();
  const pending = deferred(); let calls = 0;
  const load = () => { calls++; return pending.promise; };
  h.render(false, 'all', 0, load); h.commit(); assert.equal(calls, 0);
  h.render(true, 'all', 0, load); h.commit(); assert.equal(calls, 1);
  h.render(false, 'all', 0, load); h.commit(); pending.resolve({ total: 5 }); await flush();
  assert.equal(h.render(false, 'all', 0, load).value, null);
  h.unmount();
});
