import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import ts from 'typescript';

// Execute the real mutation/read boundary with independently delayed IPC calls.
const source = fs.readFileSync(new URL('../../web/src/shell/useSidebarActions.ts', import.meta.url), 'utf8');
const tree = ts.createSourceFile('sidebar-action-recovery.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const wanted = new Set(['sidebarAction', 'refreshConversationList']);
const functions = [];
function visit(node) {
  if (ts.isFunctionDeclaration(node) && wanted.has(node.name?.text)) functions.push(node.getText(tree));
  else ts.forEachChild(node, visit);
}
visit(tree);
assert.equal(functions.length, 2);
const code = ts.transpileModule(functions.join('\n') + '\nglobalThis.action = sidebarAction; globalThis.retry = refreshConversationList;', { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
function harness() {
  const calls = { writes: [], reads: 0, navigation: [], toasts: [], drafts: [], queues: [], closedTabs: [] };
  const h = {
    sidebarMutationRef: { current: false }, conversationListNeedsRefreshRef: { current: false },
    conversationListRetryRef: { current: false }, stateRequestRef: { current: 0 },
    sessionLoadRef: { current: 0 }, sessionRef: { current: null }, workspaceRef: { current: '/A' },
    queuedEditContextsRef: { current: {} }, composerDraftsRef: { current: {} },
    workspaces: [{ cwd: '/A', sessions: [{ id: 'A', archived: true }] }],
    setSidebarMutating(value) { h.busy = value; },
    setConversationListRefreshError(value) { h.refreshError = value; },
    forgetConversations(ids) { calls.closedTabs.push(...ids); },
    removeWorkspaceFromList(cwd) { h.workspaces = h.workspaces.filter(item => item.cwd !== cwd); },
    clearSessionQueuedPrompts(id) { calls.queues.push(id); },
    persistDeletedComposerSessions: async () => {},
    clearComposerDraft(_store, key) { calls.drafts.push(key); },
    composerDraftKeyForSession: id => `session:${id}`, composerDraftKeyForNew: cwd => `new:${cwd}`,
    setSession(update) { h.sessionRef.current = update(h.sessionRef.current); },
    showToast(...args) { calls.toasts.push(args); },
    mutation: async () => ({ ok: true }), refresh: async () => {},
    conversationNavigationRef: { current: {
      start: async cwd => { calls.navigation.push(['start', cwd]); },
      open: async item => { calls.navigation.push(['open', item.id]); return true; },
    } },
    window: { piApi: { conversationAction: async input => { calls.writes.push(input); return h.mutation(input); } } },
    loadStateRef: { current: async () => {
      calls.reads += 1;
      await h.refresh();
      h.conversationListNeedsRefreshRef.current = false;
      h.refreshError = false;
    } },
  };
  vm.runInNewContext(code, h);
  return { h, calls };
}

test('committed archive followed by failed refresh only retries reading; stale rows cannot toggle again', async () => {
  const { h, calls } = harness();
  h.refresh = async () => { throw new Error('offline'); };
  await h.action('session', 'A', 'archive');
  assert.equal(h.refreshError, true);
  assert.equal(h.busy, false);
  await assert.rejects(h.action('session', 'A', 'archive'), /刷新会话列表/);
  assert.equal(calls.writes.length, 1);
  await h.retry();
  assert.equal(calls.reads, 2);
  assert.equal(h.refreshError, true);
  h.refresh = async () => {};
  await h.retry();
  assert.equal(calls.reads, 3);
  assert.equal(calls.writes.length, 1);
  assert.equal(h.refreshError, false);
  assert.equal(h.conversationListNeedsRefreshRef.current, false);
});

test('failed mutation retains retry semantics and does not claim committed success', async () => {
  const { h, calls } = harness();
  h.mutation = async () => { throw new Error('write rejected'); };
  await assert.rejects(h.action('session', 'A', 'remove'), /write rejected/);
  assert.equal(h.sidebarMutationRef.current, false);
  assert.equal(h.conversationListNeedsRefreshRef.current, false);
  assert.equal(calls.reads, 0);
  assert.equal(calls.toasts.length, 0);
  assert.equal(calls.drafts.length, 0);
});

test('one synchronous mutation lock survives view remount and suppresses duplicate toggles', async () => {
  const { h, calls } = harness();
  let release;
  h.mutation = () => new Promise(resolve => { release = resolve; });
  const pending = h.action('session', 'A', 'archive');
  await assert.rejects(h.action('session', 'A', 'archive'), /正在完成/);
  assert.equal(calls.writes.length, 1);
  release({ ok: true }); await pending;
  assert.equal(h.sidebarMutationRef.current, false);
});

test('late workspace deletion leaves a newly selected workspace in place and clears only deleted drafts', async () => {
  const { h, calls } = harness();
  let release;
  h.mutation = () => new Promise(resolve => { release = resolve; });
  const pending = h.action('workspace', '/A', 'remove');
  h.workspaceRef.current = '/B'; h.sessionRef.current = { id: 'B', cwd: '/B' };
  release({ ok: true, deletedSessions: 1 }); await pending;
  assert.deepEqual(calls.navigation, []);
  assert.deepEqual(calls.drafts, ['session:A', 'new:/A']);
  assert.deepEqual(calls.queues, ['A']);
  assert.deepEqual(calls.closedTabs, ['A']);
});

test('a committed empty workspace deletion removes its row even when the list refresh fails', async () => {
  const { h, calls } = harness();
  h.workspaces = [{ cwd: '/A', sessions: [] }, { cwd: '/B', sessions: [] }];
  h.mutation = async () => ({ ok: true, deletedSessions: 0 });
  h.refresh = async () => { throw new Error('offline'); };
  await h.action('workspace', '/A', 'remove');
  assert.deepEqual(h.workspaces.map(item => item.cwd), ['/B']);
  assert.deepEqual(calls.navigation, [['start', '']]);
  assert.equal(h.refreshError, true);
  assert.equal(calls.writes.length, 1);
});

test('late fork completion preserves new navigation instead of replacing the current view', async () => {
  const { h, calls } = harness();
  let release;
  h.mutation = () => new Promise(resolve => { release = resolve; });
  const pending = h.action('session', 'A', 'fork');
  h.sessionLoadRef.current += 1;
  release({ id: 'fork-A', updatedAt: 123 }); await pending;
  assert.deepEqual(calls.navigation, []);
  assert.equal(calls.writes.length, 1);
});


test('committed archive or deletion cannot cancel a newer navigation whose detail is still loading', async () => {
  for (const [kind, id, action] of [['session', 'A', 'archive'], ['session', 'A', 'remove'], ['workspace', '/A', 'remove']]) {
    const { h, calls } = harness();
    h.workspaces[0].sessions[0].archived = false;
    h.sessionRef.current = { id: 'A', cwd: '/A' };
    let release;
    h.mutation = () => new Promise(resolve => { release = resolve; });
    const pending = h.action(kind, id, action);
    // openSession(B) increments the generation immediately; A remains rendered
    // until B's transcript read resolves. Do not start another draft over it.
    h.sessionLoadRef.current += 1;
    release({ ok: true }); await pending;
    assert.deepEqual(calls.navigation, []);
    assert.equal(calls.writes.length, 1);
    assert.equal(calls.reads, 1);
  }
});

test('restoring from the archive list keeps the settings view even if its source summary is stale', async () => {
  const { h, calls } = harness();
  h.workspaces[0].sessions[0].archived = false;
  h.sessionRef.current = { id: 'A', cwd: '/A' };
  await h.action('session', 'A', 'archive', undefined, {
    preserveCurrentView: true,
  });
  assert.deepEqual(calls.navigation, []);
  assert.equal(calls.writes.length, 1);
  assert.equal(calls.reads, 1);
  assert.equal(calls.toasts.length, 0);
});
