import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import ts from 'typescript';

// Execute the real ownership functions, with only state and IPC substituted.
const source = [
  fs.readFileSync(new URL('../../web/src/shell/useSettingsWorkspace.ts', import.meta.url), 'utf8'),
  fs.readFileSync(new URL('../../web/src/shell/useAppSettings.ts', import.meta.url), 'utf8'),
].join('\n');
const tree = ts.createSourceFile('mcp-detail-actions.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const names = new Set(['openMcpDetail', 'closeMcpDetail', 'refreshMcpDetail']);
const functions = [];
function visit(node) {
  if (ts.isFunctionDeclaration(node) && names.has(node.name?.text)) functions.push(node.getText(tree));
  else ts.forEachChild(node, visit);
}
visit(tree);
assert.equal(functions.length, names.size, 'all MCP ownership functions must be extracted');
const code = ts.transpileModule(functions.join('\n') + '\nObject.assign(globalThis, { openMcpDetail, closeMcpDetail, refreshMcpDetail });', { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
function harness(initialSettings = null) {
  const reads = [], snapshots = [];
  const h = {
    settingsRequestRef: { current: 0 }, settings: initialSettings,
    workspaceRef: { current: '/A' }, mcpDetailRef: { current: null }, mcpDetailGenerationRef: { current: 0 },
    setMcpDetailState(value) { h.detail = value; },
    setSettingsData(update) {
      h.settings = typeof update === 'function' ? update(h.settings) : update;
      snapshots.push(h.settings);
    },
    window: { piApi: { settings: (...args) => new Promise((resolve, reject) => reads.push({ args, resolve, reject })) } },
  };
  vm.runInNewContext(code, h);
  const callback = () => {
    const name = h.mcpDetailRef.current.name, generation = h.mcpDetailGenerationRef.current, workspace = h.workspaceRef.current;
    return () => h.refreshMcpDetail(name, generation, workspace);
  };
  return { h, reads, snapshots, callback };
}
const a = { name: 'A', target: 'https://a.example/mcp' }, b = { name: 'B', target: 'https://b.example/mcp' };

test('a refresh completing after close never reopens the MCP detail or updates settings', async () => {
  const { h, reads, snapshots, callback } = harness();
  h.openMcpDetail(a); const pending = callback()(); h.closeMcpDetail();
  reads[0].resolve({ mcp: [{ ...a, connected: true }] }); assert.equal(await pending, undefined);
  assert.equal(h.detail, null); assert.equal(h.mcpDetailRef.current, null); assert.equal(snapshots.length, 0);
});

test('A to B and close/reopen A invalidate the prior detail generation', async () => {
  for (const next of [b, { ...a, description: 'new A instance' }]) {
    const { h, reads, snapshots, callback } = harness(); h.openMcpDetail(a);
    const pending = callback()(); h.closeMcpDetail(); h.openMcpDetail(next);
    reads[0].resolve({ mcp: [{ ...a, description: 'old response' }] }); assert.equal(await pending, undefined);
    assert.equal(h.detail, next); assert.equal(h.mcpDetailRef.current, next); assert.equal(snapshots.length, 0);
  }
});

test('a workspace transition rejects late snapshots and stale callbacks issue no settings read', async () => {
  const { h, reads, snapshots, callback } = harness(); h.openMcpDetail(a); const refresh = callback();
  const pending = refresh(); assert.deepEqual(reads[0].args, ['/A']); h.workspaceRef.current = '/B';
  reads[0].resolve({ mcp: [{ ...a, description: 'wrong workspace' }] }); assert.equal(await pending, undefined);
  assert.equal(await refresh(), undefined); assert.equal(reads.length, 1); assert.equal(snapshots.length, 0); assert.equal(h.detail, a);
});

test('closed, replaced and reopened owners cannot start a new settings read', async () => {
  for (const next of [null, b, a]) {
    const { h, reads, callback } = harness(); h.openMcpDetail(a); const refresh = callback();
    h.closeMcpDetail(); if (next) h.openMcpDetail(next);
    assert.equal(await refresh(), undefined); assert.equal(reads.length, 0);
  }
});

test('current read failures reject for recovery; obsolete read failures are ignored', async () => {
  const { h, reads, callback } = harness(); h.openMcpDetail(a);
  let pending = callback()(); reads[0].reject(new Error('current read failed'));
  await assert.rejects(pending, /current read failed/); assert.equal(h.detail, a);
  pending = callback()(); h.openMcpDetail(b); reads[1].reject(new Error('obsolete read failed'));
  assert.equal(await pending, undefined); assert.equal(h.detail, b);
});

test('current successful refresh updates the projection and detail without changing ownership', async () => {
  const { h, reads, snapshots, callback } = harness(); h.openMcpDetail(a);
  const generation = h.mcpDetailGenerationRef.current, refresh = callback();
  const updated = { ...a, connected: true }, snapshot = { mcp: [b, updated] };
  let pending = refresh(); reads[0].resolve(snapshot); assert.equal(await pending, true);
  assert.equal(snapshots[0], snapshot); assert.equal(h.detail, updated); assert.equal(h.mcpDetailRef.current, updated);
  assert.equal(h.mcpDetailGenerationRef.current, generation);
  pending = refresh(); reads[1].resolve({ mcp: [b] }); assert.equal(await pending, true);
  assert.equal(h.detail, null); assert.equal(h.mcpDetailRef.current, null);
});


test('a settings revision change invalidates both late detail data and errors; a fresh read can recover', async () => {
  for (const rejected of [false, true]) {
    const initial = { mcp: [a], skills: [{ name: 'current skill' }] };
    const { h, reads, snapshots, callback } = harness(initial);
    h.openMcpDetail(a);
    const refresh = callback(), pending = refresh();
    h.settingsRequestRef.current += 1;
    if (rejected) reads[0].reject(new Error('obsolete settings read'));
    else reads[0].resolve({ mcp: [{ ...a, description: 'obsolete' }] });
    assert.equal(await pending, undefined);
    assert.equal(h.settings, initial);
    assert.equal(snapshots.length, 0);
    assert.equal(h.detail, a);
    assert.equal(h.mcpDetailRef.current, a);
    const recovered = { ...a, connected: true };
    const next = refresh();
    reads[1].resolve({ mcp: [recovered] });
    assert.equal(await next, true);
    assert.equal(h.settings.mcp[0], recovered);
    assert.equal(h.detail, recovered);
    assert.equal(h.settingsRequestRef.current, 1, 'a detail read does not invalidate other settings reads');
  }
});

test('detail refresh merges only MCP into the latest settings state, preserving other domains', async () => {
  const { h, reads, snapshots, callback } = harness({ mcp: [a], skills: [], providers: [] });
  h.openMcpDetail(a);
  const pending = callback()();
  // An independent domain may change while the detail read is in flight.
  const latest = {
    mcp: [a], skills: [{ name: 'new skill' }], providers: [{ id: 'new provider' }],
    enabledModels: ['new-provider/new-model'], runtimeRefresh: { status: 'ready' },
  };
  h.settings = latest;
  const updated = { ...a, connected: true };
  reads[0].resolve({
    mcp: [updated], skills: [{ name: 'stale skill' }], providers: [{ id: 'stale provider' }],
    enabledModels: ['stale/model'], runtimeRefresh: { status: 'error' },
  });
  assert.equal(await pending, true);
  assert.equal(snapshots.length, 1);
  assert.notEqual(h.settings, latest, 'React updater returns a new object');
  assert.equal(h.settings.mcp[0], updated);
  for (const key of ['skills', 'providers', 'enabledModels', 'runtimeRefresh']) {
    assert.equal(h.settings[key], latest[key], `${key} remains owned by its own updater`);
  }
  assert.equal(h.detail, updated);
});
