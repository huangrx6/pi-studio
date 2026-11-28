import assert from 'node:assert/strict';
import test from 'node:test';
import { readDocumentFile } from '../../web/src/shell/session-file.ts';
import {
  emptySessionLayout,
  restoreSessionLayout,
  workspaceFileTab,
  showContentTab, presentConversation, removeContentTab, removeContentTabs, worktreeLayoutOwner,
} from '../../web/src/shell/session-layout.ts';
import { tabCloseActions } from '../../web/src/shared/tab-close-actions.ts';

function file(id, overrides = {}) {
  return { id, kind: 'file', title: id, path: id, cwd: '/A', source: 'workspace', ...overrides };
}

test('Windows file tree and code navigation paths reopen the same document, including a saved split', () => {
  const cwd = 'C:\\repo';
  const path = 'src\\module.ts';
  const canonical = workspaceFileTab(cwd, 'src/module.ts');
  assert.deepEqual(workspaceFileTab(cwd, path), canonical);
  const old = { ...canonical, path, id: JSON.stringify(['file', cwd, 'workspace', path]) };
  const layout = restoreSessionLayout({ tabs: [old, canonical], active: old.id, right: {tabs:[old], active:old.id} });
  assert.deepEqual(layout.tabs, [canonical]);
  assert.equal(layout.active, canonical.id);
  assert.deepEqual(layout.right, { tabs:[canonical], active:canonical.id });
});

test('a preview can be replaced until pinned, and opening it again retains its position', () => {
  let layout = showContentTab(emptySessionLayout(), file('one', { preview: true }));
  layout = showContentTab(layout, file('two', { preview: true, scroll: 170 }));
  assert.deepEqual(
    layout.tabs.map((tab) => tab.id),
    ['two'],
  );
  layout = showContentTab(layout, file('two', { preview: false }));
  layout = showContentTab(layout, file('three', { preview: true }));
  assert.equal(layout.tabs[0].scroll, 170);
  assert.equal(layout.tabs[0].preview, false);
  assert.equal(layout.active, 'three');
  assert.deepEqual(restoreSessionLayout(JSON.parse(JSON.stringify(layout))), layout);
});

test('worktrees restore separate active documents and discard unavailable tab types', () => {
  const a = showContentTab(emptySessionLayout(), file('same.txt', { scroll: 300 }));
  const b = showContentTab(emptySessionLayout(), file('same.txt', { cwd: '/B', scroll: 20 }));
  assert.equal(restoreSessionLayout(b).tabs[0].cwd, '/B');
  assert.equal(restoreSessionLayout(a).tabs[0].scroll, 300);
  assert.deepEqual(
    restoreSessionLayout({ tabs: [null, { kind: 'terminal', id: 'T', title: 'T' }], active: 'T' }),
    emptySessionLayout(),
  );
});

test('worktree conversations share documents and keep their own reading positions', () => {
  const a = {id:'a', title:'First'}, b = {id:'b', title:'Second'};
  let layout = presentConversation(emptySessionLayout(), a);
  layout.tabs[0].reading = {entry:10, offset:22};
  layout = showContentTab(layout, file('README.md', {scroll:60}));
  layout = presentConversation(layout, b);
  layout = presentConversation(layout, a);
  assert.deepEqual(layout.tabs.map(tab => tab.id), ['conversation:a','README.md','conversation:b']);
  assert.deepEqual(layout.tabs[0].reading, {entry:10, offset:22});
  assert.equal(layout.tabs[2].reading, undefined);
  assert.equal(presentConversation(layout, b, false).active, 'conversation:b');
  assert.equal(presentConversation(layout, null, false).active, 'chat');
  const saved = restoreSessionLayout({...layout, active:'README.md'});
  assert.equal(presentConversation(saved, a, false).active, 'README.md');
  const closed = removeContentTab(saved, 'conversation:a');
  assert.equal(closed.active, 'README.md');
  assert.equal(closed.lastConversationId, 'b');
  assert.equal(closed.tabs[0].scroll, 60);
  assert.notEqual(worktreeLayoutOwner('/project', {branch:'main'}), worktreeLayoutOwner('/project', {branch:'topic'}));
  assert.notEqual(worktreeLayoutOwner('/project', {branch:'main'}), worktreeLayoutOwner('/other', {branch:'main'}));
});

test('workspace and attachment reads retain the tab location and action source', async () => {
  const workspace = await readDocumentFile(file('doc.md'), {
    filePreview: async (cwd, path) => {
      assert.equal(cwd, '/A');
      return { path, text: 'hi' };
    },
  });
  assert.equal(workspace.actionPath, 'doc.md');
  assert.equal(workspace.source, 'workspace');
  const attachment = await readDocumentFile(file('scan', { source: 'attachment' }), {
    attachmentFile: async ({ path }) => ({ path, binary: true }),
  });
  assert.equal(attachment.kind, 'binary');
  assert.equal(attachment.source, 'attachment');
});

test('when a file is absent from the selected turn, ask the authorized absolute-file service', async () => {
  const tab = file('/A/notes.txt', { source: 'diff', sessionId: 'first' });
  const preview = await readDocumentFile(tab, {
    turnDiffAbsoluteFile: async ({ sessionId }) => {
      assert.equal(sessionId, 'first');
      throw Error('not a turn change');
    },
    filePreviewAbsolute: async (input) => {
      assert.deepEqual(input, { cwd: '/A', sessionId: 'first', path: '/A/notes.txt' });
      return { path: input.path, text: 'content' };
    },
  });
  assert.equal(preview.source, 'external');
  assert.equal(preview.actionPath, tab.path);
});

test('split editors retain independent tabs, previews and selections through a layout round trip', async () => {
  const { showFileInGroup, removeRightTab, workspaceFileTab } = await import('../../web/src/shell/session-layout.ts');
  const a = workspaceFileTab('/project','a.ts'), b = workspaceFileTab('/project','b.ts');
  let layout = showFileInGroup(emptySessionLayout(), a, 'left');
  layout = showFileInGroup(layout, b, 'left');
  layout = showFileInGroup(layout, { ...a, preview:true }, 'right');
  layout = showFileInGroup(layout, { ...b, preview:true, line:4, column:9 }, 'right');
  assert.deepEqual(layout.tabs.map(t => t.id),[a.id,b.id]);
  assert.deepEqual(layout.right.tabs.map(t => t.id),[b.id]);
  assert.equal(restoreSessionLayout(JSON.parse(JSON.stringify(layout))).right.tabs[0].column,9);
  const closed = removeRightTab(layout,b.id);
  assert.equal(closed.right,undefined);
  assert.equal(closed.active,b.id);
});

test('a batch close resolves the final selection and conversation once within its editor group', () => {
  const a = { kind: 'conversation', id: 'conversation:a', sessionId: 'a', title: 'A' };
  const b = { ...a, id: 'conversation:b', sessionId: 'b', title: 'B' };
  const right = { tabs: [file('two'), file('three')], active: 'two' };
  const layout = { ...emptySessionLayout(), tabs: [a, file('one'), b, file('two'), file('three')],
    active: 'one', lastConversationId: 'a', right };
  const next = removeContentTabs(layout, new Set(['one', b.id, 'two']));
  assert.deepEqual(next.tabs.map(tab => tab.id), [a.id, 'three']);
  assert.equal(next.active, 'three');
  assert.equal(next.lastConversationId, 'a');
  assert.equal(next.right, right);
  assert.equal(removeContentTabs(next, new Set(['three'])).active, a.id);
  assert.equal(removeContentTabs(layout, new Set([a.id])).lastConversationId, 'b');
  assert.equal(removeContentTabs(layout, new Set(['gone'])), layout);
  const closeRight = removeContentTabs(layout, new Set(['two', 'three']), 'right');
  assert.equal(closeRight.right, undefined);
  assert.equal(closeRight.tabs, layout.tabs);
  assert.equal(closeRight.active, 'one');
  const closeLeft = removeContentTabs(next, new Set([a.id, 'three']));
  assert.equal(closeLeft.active, 'chat');
  assert.equal(closeLeft.lastConversationId, undefined);
  assert.equal(closeLeft.right, right);
});

test('tab actions target the clicked tab and exclude the permanent chat tab from every close operation', () => {
  const tabs = ['one', 'two', 'three'].map(fileName => file(fileName));
  const closed = [];
  const actions = target => tabCloseActions(tabs, target, (...args) => closed.push(args), 'chat');
  for (const action of actions('two')) action.run();
  assert.deepEqual(closed.splice(0), [[['two']], [['one', 'three'], 'two'], [['three'], 'two'], [['one', 'two', 'three']]]);
  for (const action of actions('chat').filter(action => !action.disabled)) action.run();
  assert.equal(actions('chat')[0].disabled, true);
  assert.equal(closed.length, 3);
  for (const [ids] of closed) assert.deepEqual(ids, ['one', 'two', 'three']);
  assert.equal(actions('three').find(action => action.label === '关闭右侧标签页').disabled, true);
  assert.deepEqual(actions(undefined).filter(action => !action.disabled).map(action => action.label), ['关闭全部标签页']);
});
