import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import ts from 'typescript';

// Execute the real mutation/read boundary with independently delayed IPC calls.
const source = [
  fs.readFileSync(new URL('../../web/src/shell/useSidebarActions.ts', import.meta.url), 'utf8'),
  fs.readFileSync(new URL('../../web/src/shell/useConversationController.ts', import.meta.url), 'utf8'),
].join('\n');
const tree = ts.createSourceFile('sidebar-action-recovery.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const wanted = new Set(['sidebarAction', 'refreshConversationList', 'runNotificationAction']);
const functions = [];
function visit(node) {
  if (ts.isFunctionDeclaration(node) && wanted.has(node.name?.text)) functions.push(node.getText(tree));
  else ts.forEachChild(node, visit);
}
visit(tree);
assert.equal(functions.length, 3);
const code = ts.transpileModule(functions.join('\n') + '\nglobalThis.action = sidebarAction; globalThis.retry = refreshConversationList; globalThis.runAction = runNotificationAction;', { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
function harness() {
  const calls = { writes: [], reads: 0, navigation: [], notifications: [], drafts: [], queues: [] };
  const h = {
    sidebarMutationRef: { current: false }, conversationListNeedsRefreshRef: { current: false },
    conversationListRetryRef: { current: false }, stateRequestRef: { current: 0 },
    sessionLoadRef: { current: 0 }, sessionRef: { current: null }, workspaceRef: { current: '/A' },
    queuedEditContextsRef: { current: {} }, composerDraftsRef: { current: {} },
    workspaces: [{ cwd: '/A', sessions: [{ id: 'A', archived: true }] }],
    setSidebarMutating(value) { h.busy = value; },
    setConversationListRefreshError(value) { h.refreshError = value; },
    clearSessionQueuedPrompts(id) { calls.queues.push(id); },
    clearComposerDraft(_store, key) { calls.drafts.push(key); },
    composerDraftKeyForSession: id => `session:${id}`, composerDraftKeyForNew: cwd => `new:${cwd}`,
    setSession(update) { h.sessionRef.current = update(h.sessionRef.current); },
    pushNotification(...args) { calls.notifications.push(args); },
    setNotifications(update) { h.notificationItems = update(h.notificationItems || []); },
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
  assert.equal(calls.notifications.length, 0);
  assert.equal(calls.drafts.length, 0);
});

test('a newly archived conversation exposes one recoverable notification', async () => {
  const { h, calls } = harness();
  h.workspaces[0].sessions[0].archived = false;
  h.workspaces[0].sessions[0].title = '可撤销归档';
  await h.action('session', 'A', 'archive');

  const archiveNotice = calls.notifications.find(args => args[2] === '会话已归档');
  assert.ok(archiveNotice);
  assert.equal(archiveNotice[3], 'A');
  assert.equal(JSON.stringify(archiveNotice[4]), JSON.stringify({
    kind: 'unarchive-session',
    label: '撤销归档',
    pendingLabel: '正在恢复…',
    sessionId: 'A',
    hideSessionLink: true,
  }));

  const suppressed = harness();
  suppressed.h.workspaces[0].sessions[0].archived = false;
  await suppressed.h.action('session', 'A', 'archive', undefined, {
    preserveCurrentView: true,
    notify: false,
  });
  assert.equal(
    suppressed.calls.notifications.some(args => args[2] === '会话已归档'),
    false,
  );
});

test('notification undo rechecks the archived target and removes only its recoverable notice', async () => {
  const { h, calls } = harness();
  h.workspaces[0].sessions[0].archived = true;
  h.notificationItems = [{
    id: 'archive-notice',
    sessionId: 'A',
    action: { kind: 'unarchive-session', sessionId: 'A' },
  }];
  await h.runAction(h.notificationItems[0]);

  assert.equal(calls.writes.length, 1);
  assert.equal(calls.writes[0].action, 'archive');
  assert.deepEqual(h.notificationItems, []);
  assert.equal(calls.notifications.at(-1)[2], '已撤销归档');
  assert.equal(calls.notifications.at(-1)[3], 'A');

  h.workspaces[0].sessions[0].archived = false;
  await assert.rejects(
    h.runAction({
      id: 'stale-notice',
      action: { kind: 'unarchive-session', sessionId: 'A' },
    }),
    /已经恢复/,
  );
  assert.equal(calls.writes.length, 1, 'a stale undo never toggles the conversation again');
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
});

test('late fork completion preserves new navigation and links the created conversation in its notice', async () => {
  const { h, calls } = harness();
  let release;
  h.mutation = () => new Promise(resolve => { release = resolve; });
  const pending = h.action('session', 'A', 'fork');
  h.sessionLoadRef.current += 1;
  release({ id: 'fork-A', updatedAt: 123 }); await pending;
  assert.deepEqual(calls.navigation, []);
  assert.equal(calls.notifications[0][3], 'fork-A');
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
    notify: false,
  });
  assert.deepEqual(calls.navigation, []);
  assert.equal(calls.writes.length, 1);
  assert.equal(calls.reads, 1);
  assert.equal(calls.notifications.some(args => args[2] === '会话已归档'), false);
});
