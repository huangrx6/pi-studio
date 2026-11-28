import { previews, documentDrafts } from '../session-file';
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { forgetEditorView } from '../../shared/editor-state';
import type { CodeLocation, PiWorkspace } from '../../types/workspace';
import type { TurnDiff, TurnDiffFile } from '../../types/chat-types';
import type { GitDiffSource, GitTab } from '../../types/git-types';
import type { PanelFileSource } from '../app-types';
import { errorText } from '../../shared/error-text';
import type { MenuAction } from '../../shared/ActionMenu';
import {
  emptySessionLayout,
  restoreSessionLayout,
  showContentTab, showFileInGroup, presentConversation, removeContentTab, removeContentTabs, worktreeLayoutOwner, workspaceFileTab,
  type EditorGroup, type FileTab,
  type ReadingPosition,
  type ContentTab,
  type FileTreeState,
  type SessionLayout,
} from '../session-layout';
import { useLayoutStores } from '../layout-store';
import { usePanelWidth } from './usePanelWidth';

export function useAppWorkbenchController({
  owner,
  cwd,
  sessionId,
  workspaces,
  sidebarCollapsed,
  setError,
}: {
  owner: string;
  cwd: string;
  sessionId?: string;
  workspaces: PiWorkspace[];
  sidebarCollapsed: boolean;
  setError: (message: string) => void;
}) {
  const { stores, getStore } = useLayoutStores('center', emptySessionLayout, restoreSessionLayout, setError);
  const workspaceOwner = (path: string) => worktreeLayoutOwner(path, workspaces.find(row => row.cwd === path)?.worktree);
  const shared = owner.startsWith('conversation:') || owner.startsWith('draft:');
  const layoutOwner = shared && cwd ? workspaceOwner(cwd) : owner;
  const store = useMemo(() => getStore(layoutOwner), [getStore, layoutOwner]);
  const layout = useSyncExternalStore(store.subscribe, store.snapshot);
  useEffect(() => {
    store.read();
  }, [store]);
  const update = useCallback((change: (layout: SessionLayout) => SessionLayout) => store.update(change), [store]);
  function showConversation(path: string, session: {id: string; title: string} | null, focus = true) {
    getStore(path ? workspaceOwner(path) : 'draft:').update(x => presentConversation(x, session, focus));
  }
  const focusTemporaryDraft = useCallback((id: string) => {
    getStore('temporary:' + id).update(layout => layout.active === 'chat' ? layout : { ...layout, active: 'chat' });
  }, [getStore]);
  async function workspaceConversation(path: string) {
    const target = getStore(workspaceOwner(path));
    await target.read();
    return target.snapshot().lastConversationId;
  }
  function forgetConversations(ids: string[]) {
    if (!ids.length) return;
    const removed = new Set(ids);
    for (const [key, group] of stores.current) {
      if (!key.startsWith('worktree:')) continue;
      group.update(x => x.tabs.reduce((next, tab) =>
        tab.sessionId && removed.has(tab.sessionId) && !(tab.kind === 'file' && tab.source === 'workspace')
          ? removeContentTab(next, tab.id) : next, x));
    }
  }
  const widths = usePanelWidth(sidebarCollapsed);
  const panelAvailable = owner.startsWith('conversation:') || owner.startsWith('draft:') || (owner.startsWith('room:') && Boolean(cwd));
  const filesOpen = panelAvailable && !layout.panelCollapsed && Boolean(layout.side);
  const closePanel = useCallback(() => update(x => ({ ...x, panelCollapsed: true })), [update]);
  const openPanel = useCallback(() => {
    if (panelAvailable) update(x => ({ ...x, panelCollapsed: false, side: x.side ?? 'files' }));
  }, [panelAvailable, update]);
  const drawerOpen = widths.panelOverlay && filesOpen;
  useEffect(() => {
    if (!drawerOpen) return;
    // A narrow window has room for one overlay. The most recently opened one wins.
    void window.piApi.hideToolWindow().catch(cause => setError(errorText(cause)));
    return window.piApi.onToolWindowVisibility(visible => {
      if (visible) closePanel();
    });
  }, [drawerOpen, closePanel, setError]);
  const selected = layout.tabs.find(tab => tab.id === layout.active);
  const activeTab = selected?.kind === 'conversation' ? undefined : selected;
  const sessionTab = layout.tabs.find(tab => tab.kind === 'conversation' && tab.sessionId === sessionId);
  const updateFiles = (change: Partial<FileTreeState>) =>
    update((layout) => ({
      ...layout,
      files: { mode: 'name', query: '', expanded: [], ...layout.files, ...change },
    }));
  const openFilesTab = () => update((x) => ({ ...x, panelCollapsed: false, side: 'files' }));
  const openGitTab = (page?: GitTab) =>
    update((x) => ({ ...x, panelCollapsed: false, side: 'git', gitPage: page ?? x.gitPage }));
  const activate = useCallback((id: string) => update(x => {
    const active = id === 'chat' && shared && sessionId ? 'conversation:' + sessionId : id;
    return { ...x, active };
  }), [shared, sessionId, update]);
  function show(tab: ContentTab) {
    update((x) => showContentTab(x, tab));
  }
  const jumps = useRef(new Map<string, number>());
  const fileJump = (id: string, group: EditorGroup) => jumps.current.get(JSON.stringify([layoutOwner, group, id]));
  const [comparison, setComparison] = useState<{ owner: string; file: FileTab }>();
  const comparisonSource = comparison?.owner === layoutOwner ? comparison.file : undefined;
  useEffect(() => { setComparison(undefined); }, [layoutOwner]);
  function compareWith(path: string) {
    if (!comparisonSource) return;
    const { cwd, path: original, title } = comparisonSource;
    const target = workspaceFileTab(cwd, path);
    if (original === target.path) return;
    show({ kind: 'comparison', id: JSON.stringify(['comparison', cwd, original, target.path]),
      cwd, original, path: target.path, title: title + ' ↔ ' + target.title });
    setComparison(undefined);
  }
  const [history, setHistory] = useState<{ owner: string; cwd: string; location: CodeLocation; group: EditorGroup }[]>([]);
  const canGoBack = history.some(item => item.owner === layoutOwner);

  async function openFile(
    path: string,
    accessSessionId = sessionId,
    source: PanelFileSource = path.startsWith('/') && accessSessionId
      ? 'diff'
      : /^([/~]|file:)/.test(path)
        ? 'external'
        : 'workspace',
    options?: { cwd?: string; preview?: boolean; line?: number; column?: number; title?: string; group?: EditorGroup },
  ) {
    const root = options?.cwd ?? cwd;
    if (source === 'workspace' && !root) return false;
    const file = source === 'workspace' ? workspaceFileTab(root, path) : {
      id: JSON.stringify(['file', root, source, path, accessSessionId]),
      path, source, cwd: root, sessionId: accessSessionId,
    };
    const tab: FileTab = {
      ...file,
      kind: 'file',
      title: options?.title || path.split(/[\\/]/).pop() || path,
      preview: options?.preview,
      ...(options?.line && { line: options.line, column: options.column }),
    };
    const current = store.snapshot();
    const group = options?.group ?? (!current.tabs.some(t => t.id === tab.id) && current.right?.tabs.some(t => t.id === tab.id) ? 'right' : 'left');
    if (options?.line) {
      const key = JSON.stringify([layoutOwner, group, tab.id]);
      jumps.current.set(key, (jumps.current.get(key) ?? 0) + 1);
    }
    update(x => showFileInGroup(x, tab, group));
    return true;
  }
  function openRight(tab: FileTab) {
    update(layout => {
      const pinned = { ...tab, preview: false };
      const tabs = layout.tabs.map(item => item.id === tab.id && item.preview ? { ...item, preview: false } : item);
      return showFileInGroup({ ...layout, tabs }, pinned, 'right');
    });
  }
  function navigateCode(tab: FileTab, group: EditorGroup, origin: CodeLocation, target: CodeLocation, side: boolean) {
    setHistory(items => [...items.slice(-99), { owner: layoutOwner, cwd: tab.cwd, group, location: { ...origin, path: tab.path } }]);
    void openFile(target.path, undefined, 'workspace', { cwd: tab.cwd, line: target.line, column: target.column, group: side ? 'right' : group });
  }
  function goBack() {
    const index = history.map(item => item.owner).lastIndexOf(layoutOwner);
    if (index < 0) return;
    const entry = history[index];
    setHistory(items => items.filter(item => item !== entry));
    void openFile(entry.location.path, undefined, 'workspace', { cwd: entry.cwd, line: entry.location.line, column: entry.location.column, group: entry.group });
  }
  function fileActions(tab: FileTab, currentGroup?: EditorGroup) {
    const actions: MenuAction[] = [];
    const openLeft = () => update(x => showFileInGroup(x, { ...tab, preview: false }, 'left'));
    if (!currentGroup) {
      actions.push({ label: '在新标签中打开', run: openLeft }, { label: '在右侧打开', run: () => openRight(tab) });
    } else {
      if (tab.preview) actions.push({ label: '保留此标签', run: () => pin(tab.id, currentGroup) });
      if (currentGroup === 'right') actions.push({ label: '在左侧打开', run: openLeft });
    }
    if (tab.source === 'workspace') {
      actions.push({ label: '与文件比较…', run: () => setComparison({ owner: layoutOwner, file: tab }) });
    }
    return actions;
  }
  function openChangesTab(file: TurnDiffFile | undefined, turn: TurnDiff, session: { id: string }) {
    show({
      id: JSON.stringify(['changes', session.id, turn.at]),
      kind: 'changes',
      sessionId: session.id,
      turnAt: turn.at,
      path: file?.path ?? '',
      title: '回合变更',
    });
  }
  function openDiffTab(file: TurnDiffFile, turnAt: number, id: string) {
    show({
      id: JSON.stringify(['diff', id, turnAt, file.path]),
      kind: 'diff',
      sessionId: id,
      turnAt,
      path: file.path,
      title: file.label.split('/').pop() || file.path,
    });
  }
  function openGitDiff(repository: string, source: GitDiffSource) {
    if (sessionId)
      show({
        id: JSON.stringify(['git', repository, source]),
        kind: 'git-diff',
        title: source.path.split('/').pop()!,
        sessionId,
        source,
        repository,
      });
  }
  function closeTabs(ids: string[], group: EditorGroup, keepId?: string) {
    const current = store.snapshot();
    const tabs = group === 'left' ? current.tabs : current.right?.tabs;
    if (!tabs || (keepId !== undefined && !tabs.some(tab => tab.id === keepId))) return;
    const requested = new Set(ids);
    const targets = tabs.filter(tab => requested.has(tab.id) && tab.id !== keepId);
    if (!targets.length) return;
    const other = group === 'left' ? current.right?.tabs : current.tabs;
    const stillOpen = new Set(other?.map(tab => tab.id));
    const lastViews = targets.filter(tab => !stillOpen.has(tab.id));
    const unsaved = lastViews.filter(tab => {
      const draft = documentDrafts.get(JSON.stringify([layoutOwner, tab.id]));
      return draft && draft.text !== draft.base.text;
    });
    if (unsaved.length) {
      const names = unsaved.slice(0, 5).map(tab => tab.kind === 'file' ? tab.path : tab.title).join('\n');
      const more = unsaved.length > 5 ? '\n…' : '';
      if (!window.confirm(`关闭标签页并放弃以下 ${unsaved.length} 个文件的未保存修改？\n\n${names}${more}`)) return;
    }
    for (const tab of lastViews) {
      const key = JSON.stringify([layoutOwner, tab.id]);
      documentDrafts.delete(key);
      previews.drop(key);
    }
    for (const tab of targets) {
      const viewKey = JSON.stringify([layoutOwner, group, tab.id]);
      forgetEditorView(viewKey);
      jumps.current.delete(viewKey);
    }
    const closing = new Set(targets.map(tab => tab.id));
    update(layout => removeContentTabs(layout, closing, group));
    return store.snapshot();
  }
  function reorder(from: string, to: string, group: EditorGroup = 'left') {
    update((x) => {
      const tabs = [...(group === 'right' ? x.right?.tabs ?? [] : x.tabs)];
      const source = tabs.findIndex((t) => t.id === from);
      const target = tabs.findIndex((t) => t.id === to);
      if (source < 0 || target < 0) return x;
      tabs.splice(target, 0, ...tabs.splice(source, 1));
      return group === 'right' && x.right ? { ...x, right: { ...x.right, tabs: tabs.filter((tab): tab is FileTab => tab.kind === 'file') } } : { ...x, tabs };
    });
  }
  const pin = (id: string, group: EditorGroup = 'left') => update(x => {
    const tabs = group === 'right' ? x.right?.tabs : x.tabs;
    if (!tabs?.some(t => t.id === id && t.preview)) return x;
    if (group === 'right' && x.right) return { ...x, right: { ...x.right, tabs: x.right.tabs.map(t => t.id === id ? { ...t, preview: false } : t) } };
    return { ...x, tabs: x.tabs.map(t => t.id === id ? { ...t, preview: false } : t) };
  });
  const scroll = useCallback(
    (id: string, top: number, group: EditorGroup = 'left') => {
      const saved = store.snapshot();
      if (group === 'right') {
        const tab = saved.right?.tabs.find(t => t.id === id);
        if (tab && tab.scroll !== top) update(x => !x.right ? x : { ...x, right: { ...x.right, tabs: x.right.tabs.map(t => t.id === id ? { ...t, scroll: top } : t) } });
        return;
      }
      if (id === 'chat' ? saved.chatScroll === top : saved.tabs.find((t) => t.id === id)?.scroll === top)
        return;
      update((x) =>
        id === 'chat'
          ? { ...x, chatScroll: top }
          : { ...x, tabs: x.tabs.map((t) => (t.id === id ? { ...t, scroll: top } : t)) },
      );
    },
    [store, update],
  );
  const saveReading = useCallback(
    (reading: ReadingPosition | undefined) => {
      if (!shared || !sessionId) return;
      update(x => {
        const tab = x.tabs.find(t => t.kind === 'conversation' && t.sessionId === sessionId);
        if (tab?.kind !== 'conversation' || (tab.reading?.entry === reading?.entry && tab.reading?.offset === reading?.offset)) return x;
        return { ...x, tabs: x.tabs.map(item => item.id === tab.id ? { ...tab, reading } : item) };
      });
    }, [shared, sessionId, update],
  );
  return {
    ...widths,
    owner, layoutOwner, shared, showConversation, focusTemporaryDraft,
    workspaceConversation, forgetConversations,
    reading: sessionTab?.kind === 'conversation' ? sessionTab.reading : undefined,
    sessionId, cwd,
    layout,
    updateFiles,
    ready: store.ready(),
    saveReading,
    panelAvailable,
    filesOpen,
    activeTab,
    openFile,
    comparisonSource, compareWith, cancelComparison: () => setComparison(undefined),
    fileJump, openRight, fileActions, navigateCode, goBack, canGoBack,
    treeActions: (path: string) => fileActions(workspaceFileTab(cwd, path)),
    activateRight: (id: string) => update(x => x.right ? { ...x, right: { ...x.right, active: id } } : x),
    openChangesTab,
    openDiffTab,
    openGitDiff,
    activate,
    closeTabs,
    reorder,
    pin,
    scroll,
    openPanel,
    closePanel,
    openFilesTab,
    openGitTab,
  };
}

export type SessionWorkbench = ReturnType<typeof useAppWorkbenchController>;
