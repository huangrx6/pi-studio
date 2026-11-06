import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import ts from 'typescript';

const source = fs.readFileSync(new URL('../../web/src/shell/AppDialogs.tsx', import.meta.url), 'utf8');
const ast = ts.createSourceFile('AppDialogs.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const callbacks = {};
function visit(node) {
  if (ts.isJsxSelfClosingElement(node) && node.tagName.getText(ast) === 'McpDetailDialog') {
    for (const name of ['onCommitted', 'onRecovered', 'onRefresh']) {
      callbacks[name] = node.attributes.properties.find(prop => ts.isJsxAttribute(prop) && prop.name.getText(ast) === name)?.initializer.expression.getText(ast);
    }
  }
  ts.forEachChild(node, visit);
}
visit(ast); assert.ok(callbacks.onCommitted); assert.ok(callbacks.onRecovered); assert.ok(callbacks.onRefresh);
const code = ts.transpileModule(`globalThis.committed = ${callbacks.onCommitted};\nglobalThis.recovered = ${callbacks.onRecovered};\nglobalThis.refresh = ${callbacks.onRefresh};`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
function harness() {
  const errors = [], summaries = [];
  const h = {
    workspace: '/A', mcpDetail: { name: 'fixture MCP' },
    workspaceRef: { current: '/A' },
    mcpDetailGenerationRef: { current: 3 }, mcpRefreshRequestRef: { current: 5 },
    mcpOAuthRecoveryRef: { current: null }, resourcePendingRef: { current: { mcp: false, models: true, skills: true } },
    invalidateResourceReads() { h.mcpRefreshRequestRef.current++; },
    controller: {
      invalidateResourceReads: () => h.invalidateResourceReads(),
      refreshMcpDetail: (...args) => h.refreshMcpDetail(...args),
    },
    setMcpRefreshSummary: value => summaries.push(value), setMcpRefreshError: value => errors.push(value),
  };
  h.mcp = {
    server: h.mcpDetail,
    workspace: h.workspace,
    workspaceRef: h.workspaceRef,
    ownerGeneration: 3,
    ownerGenerationRef: h.mcpDetailGenerationRef,
    recoveryRef: h.mcpOAuthRecoveryRef,
    requestRef: h.mcpRefreshRequestRef,
    pendingRef: h.resourcePendingRef,
    setSummary: h.setMcpRefreshSummary,
    setError: h.setMcpRefreshError,
  };
  vm.runInNewContext(code, h);
  return { h, errors, summaries };
}
const committed = projection => ({ committed: true, projection });

test('an OAuth commit after changing workspace or closing detail retains a recovery notice without applying old data', () => {
  for (const projection of [{ status: 'ready', value: { mcp: ['old A'] } }, { status: 'error', message: 'refresh failed' }]) {
    const { h, errors, summaries } = harness();
    h.workspaceRef.current = '/B'; h.mcpDetailGenerationRef.current = 4;
    h.committed(committed(projection), '/A');
    assert.equal(h.resourcePendingRef.current.mcp, true);
    assert.equal(h.mcpOAuthRecoveryRef.current.cwd, '/A');
    assert.equal(h.mcpOAuthRecoveryRef.current.request, 6);
    assert.equal(h.mcpOAuthRecoveryRef.current.generation, 3);
    assert.deepEqual(summaries, ['MCP 授权状态已更新']);
    assert.deepEqual(errors, ['请刷新当前 MCP 状态。']);
  }
});

test('a recovery from an obsolete scope, detail generation or read revision cannot clear a pending notice', () => {
  for (const invalidate of [
    h => { h.workspaceRef.current = '/B'; },
    h => { h.mcpDetailGenerationRef.current++; },
    h => { h.mcpRefreshRequestRef.current++; },
  ]) {
    const { h, errors } = harness();
    h.committed(committed({ status: 'error', message: 'needs refresh' }), '/A');
    const owner = h.mcpOAuthRecoveryRef.current;
    invalidate(h); h.recovered({ mcp: [] }, '/A');
    assert.equal(h.resourcePendingRef.current.mcp, true);
    assert.equal(h.mcpOAuthRecoveryRef.current, owner);
    assert.equal(errors.includes(null), false);
  }
  const { h } = harness(); h.committed(committed({ status: 'ready', value: {} }), '/A');
  h.recovered({}, '/other'); assert.equal(h.resourcePendingRef.current.mcp, true);
});

test('a current ready recovery clears only MCP pending state and is idempotent', () => {
  const { h, errors } = harness();
  h.committed(committed({ status: 'ready', value: { mcp: [] } }), '/A');
  h.recovered({ mcp: [] }, '/A');
  assert.equal(h.mcpOAuthRecoveryRef.current, null);
  assert.deepEqual(h.resourcePendingRef.current, { mcp: false, models: true, skills: true });
  assert.equal(errors.at(-1), null);
  const count = errors.length; h.recovered({ mcp: [] }, '/A'); assert.equal(errors.length, count);
});


test('the actual refresh prop rejects discarded reads so they cannot complete OAuth recovery', async () => {
  const { h, errors } = harness(), calls = [];
  h.committed(committed({ status: 'ready', value: { mcp: [] } }), '/A');
  h.refreshMcpDetail = async (...args) => { calls.push(args); return undefined; };
  await assert.rejects(h.refresh().then(() => h.recovered({ mcp: [] }, '/A')), /页面状态已变化，请重试刷新/);
  assert.deepEqual(calls, [['fixture MCP', 3, '/A']]);
  assert.equal(h.resourcePendingRef.current.mcp, true);
  assert.equal(errors.includes(null), false);
});

test('the actual refresh prop completes only an applied read and propagates read failures', async () => {
  const { h } = harness();
  h.committed(committed({ status: 'ready', value: { mcp: [] } }), '/A');
  h.refreshMcpDetail = async () => { throw new Error('detail read failed'); };
  await assert.rejects(h.refresh(), /detail read failed/);
  assert.equal(h.resourcePendingRef.current.mcp, true);
  h.refreshMcpDetail = async () => true;
  await h.refresh().then(() => h.recovered({ mcp: [] }, '/A'));
  assert.equal(h.resourcePendingRef.current.mcp, false);
  assert.equal(h.mcpOAuthRecoveryRef.current, null);
});
