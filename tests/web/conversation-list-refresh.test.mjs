import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import ts from 'typescript';

const source = fs.readFileSync(new URL('../../web/src/shell/useWorkspaceState.ts', import.meta.url), 'utf8');
const tree = ts.createSourceFile('useWorkspaceState.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let callback;
let changeWorkspaceSource;
function visit(node) {
  if (ts.isVariableDeclaration(node) && node.name.getText(tree) === 'loadState') callback = node.initializer.arguments[0].getText(tree);
  else if (ts.isFunctionDeclaration(node) && node.name?.getText(tree) === 'changeWorkspace') changeWorkspaceSource = node.getText(tree);
  else ts.forEachChild(node, visit);
}
visit(tree); assert(callback); assert(changeWorkspaceSource);
const code = ts.transpileModule(`globalThis.read = ${callback};`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
const changeWorkspaceCode = ts.transpileModule(`globalThis.changeWorkspace = ${changeWorkspaceSource};`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText;
function harness() {
  const waiting = []; const installed = [];
  const h = {
    workspace: '/A', workspaceRef: { current: '/A' },
    sessionLoadRef: { current: 0 }, stateRequestRef: { current: 0 },
    modelRevisionRef: { current: new Map() }, modelWritesRef: { current: new Set() },
    workspaceOrderRef: { current: [] }, sessionOrderRef: { current: {} },
    conversationListNeedsRefreshRef: { current: true },
    sessionRef: { current: null }, defaultModelWorkspaceRef: { current: '' },
    setStateLoading(value) { h.loading = value; }, setWorkspaceOrder() {}, setSessionOrder() {},
    setWorkspaces(value) { installed.push(value); }, setSession() {},
    setDefaultModelSelection() {}, setModelSelection() {},
    setConversationListRefreshError(value) { h.notice = value; },
    window: { piApi: { state() { return new Promise((resolve, reject) => waiting.push({ resolve, reject })); } } },
  };
  vm.runInNewContext(code, h);
  return { h, waiting, installed, data: { workspaces: [{ cwd: '/A', name: 'A', sessions: [] }], model: {} } };
}

test('write-invalidated and superseded list reads cannot unlock or install stale projections', async () => {
  const { h, waiting, installed, data } = harness();
  const beforeWrite = h.read();
  // sidebarAction invalidates every read begun before the successful mutation.
  h.stateRequestRef.current += 1;
  waiting[0].resolve(data); await beforeWrite;
  assert.equal(installed.length, 0); assert.equal(h.conversationListNeedsRefreshRef.current, true);
  const older = h.read(); const latest = h.read();
  waiting[1].resolve(data); await older;
  assert.equal(installed.length, 0); assert.equal(h.conversationListNeedsRefreshRef.current, true);
  waiting[2].resolve(data); await latest;
  assert.equal(installed.length, 1); assert.equal(h.conversationListNeedsRefreshRef.current, false);
  assert.equal(h.notice, false); assert.equal(h.loading, false);
});

test('scope changes retain the refresh lock; latest failed reads expose read recovery without unlocking', async () => {
  const { h, waiting, installed, data } = harness();
  const wrongScope = h.read(); h.workspaceRef.current = '/B';
  waiting[0].resolve(data); await wrongScope;
  assert.equal(installed.length, 0); assert.equal(h.conversationListNeedsRefreshRef.current, true);
  h.workspaceRef.current = '/A';
  const failed = h.read(); waiting[1].reject(new Error('read failed'));
  await assert.rejects(failed, /read failed/);
  assert.equal(h.notice, true); assert.equal(h.conversationListNeedsRefreshRef.current, true);
  assert.equal(h.loading, false);
  const retry = h.read(); waiting[2].resolve(data); await retry;
  assert.equal(installed.length, 1); assert.equal(h.conversationListNeedsRefreshRef.current, false);
});

test('workspace navigation invalidates an abandoned list read and releases its controls lock', () => {
  const h = {
    workspaceRef: { current: '/A' },
    stateRequestRef: { current: 3 },
    workspace: '/A',
    loading: true,
    setWorkspace(value) { h.workspace = value; },
    setStateLoading(value) { h.loading = value; },
  };
  vm.runInNewContext(changeWorkspaceCode, h);

  h.changeWorkspace('/B');
  assert.equal(h.workspaceRef.current, '/B');
  assert.equal(h.workspace, '/B');
  assert.equal(h.stateRequestRef.current, 4);
  assert.equal(h.loading, false);

  h.loading = true;
  h.changeWorkspace('/B');
  assert.equal(h.stateRequestRef.current, 4, 'selecting the same workspace must not invalidate a current read');
  assert.equal(h.loading, true);
});
