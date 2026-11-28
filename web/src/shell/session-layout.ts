import type { FileSearchOptions, WorkspaceTree } from '../types/workspace';
import type { GitDiffSource, GitTab } from '../types/git-types';
import type { PanelFileSource } from './app-types';

export type ReadingPosition = { entry: number; offset: number };

export type ContentTab = {
  id: string;
  title: string;
  preview?: boolean;
  scroll?: number;
  line?: number;
  column?: number;
} & (
  | { kind: 'conversation'; sessionId: string; reading?: ReadingPosition }
  | { kind: 'file'; cwd: string; path: string; source: PanelFileSource; sessionId?: string }
  | { kind: 'comparison'; cwd: string; original: string; path: string; sessionId?: never }
  | { kind: 'diff' | 'changes'; sessionId: string; turnAt: number; path: string }
  | { kind: 'git-diff'; sessionId: string; repository: string; source: GitDiffSource }
);
export type FileTreeState = {
  options?: FileSearchOptions;
  mode: 'name' | 'content';
  query: string;
  expanded: string[];
};

export type SessionLayout = {
  files?: FileTreeState;
  tabs: ContentTab[];
  active: string;
  right?: { tabs: Extract<ContentTab, { kind: 'file' }>[]; active: string };
  side: 'files' | 'git' | null;
  panelCollapsed?: boolean;
  gitPage: GitTab;
  chatScroll?: number;
  lastConversationId?: string;
};
export function emptySessionLayout(): SessionLayout {
  return { tabs: [], active: 'chat', side: null, gitPage: 'changes' };
}

export function restoreSessionLayout(raw: unknown): SessionLayout {
  const layout = emptySessionLayout();
  if (!raw || typeof raw !== 'object' || !('tabs' in raw) || !Array.isArray(raw.tabs)) return layout;
  const saved = raw as Partial<SessionLayout>;
  const validTab = (tab: Partial<ContentTab> | null): tab is ContentTab => {
    if (typeof tab?.id !== 'string' || typeof tab.title !== 'string') return false;
    if (tab.kind === 'conversation') return typeof tab.sessionId === 'string' && tab.id === 'conversation:' + tab.sessionId;
    if (tab.kind === 'file')
      return (
        typeof tab.cwd === 'string' &&
        typeof tab.path === 'string' &&
        typeof tab.source === 'string' &&
        ['workspace', 'attachment', 'external', 'diff'].includes(tab.source)
      );
    if (tab.kind === 'comparison') return typeof tab.cwd === 'string' && typeof tab.original === 'string' && typeof tab.path === 'string';
    if (typeof tab.sessionId !== 'string') return false;
    if (tab.kind === 'git-diff')
      return (
        typeof tab.repository === 'string' &&
        typeof tab.source?.path === 'string' &&
        ['commit', 'index', 'worktree'].includes(tab.source.layer)
      );
    return (
      (tab.kind === 'changes' || tab.kind === 'diff') && Number.isFinite(tab.turnAt) && typeof tab.path === 'string'
    );
  };
  const restoredIds = new Map<string, string>();
  function normalizeTab<T extends ContentTab>(tab: T): T {
    if (tab.kind !== 'file' || tab.source !== 'workspace') return tab;
    const normalized = workspaceFileTab(tab.cwd, tab.path);
    if (normalized.path === tab.path) return tab;
    restoredIds.set(tab.id, normalized.id);
    return { ...tab, path: normalized.path, id: normalized.id };
  }
  layout.tabs = Array.from(new Map(raw.tabs.filter(validTab).map(normalizeTab).map(tab => [tab.id, tab])).values());
  if (Array.isArray(saved.right?.tabs)) {
    const tabs = Array.from(new Map(saved.right.tabs.filter(tab => validTab(tab) && tab.kind === 'file').map(normalizeTab).map(tab => [tab.id, tab])).values());
    const active = restoredIds.get(saved.right.active) ?? saved.right.active;
    if (tabs.length) layout.right = { tabs, active: tabs.find(t => t.id === active)?.id ?? tabs[0].id };
  }
  if (saved.files && typeof saved.files.query === 'string' && Array.isArray(saved.files.expanded)) {
    layout.files = {
      query: saved.files.query,
      mode: saved.files.mode === 'content' ? 'content' : 'name',
      expanded: saved.files.expanded.filter((path): path is string => typeof path === 'string'),
    };
  }
  const options = saved.files?.options;
  if (layout.files && options && typeof options === 'object') {
    layout.files.options = {
      caseSensitive: options.caseSensitive === true, wholeWord: options.wholeWord === true, regex: options.regex === true,
      include: typeof options.include === 'string' ? options.include : '', exclude: typeof options.exclude === 'string' ? options.exclude : '',
    };
  }
  const active = saved.active && (restoredIds.get(saved.active) ?? saved.active);
  if (active && layout.tabs.some(tab => tab.id === active)) layout.active = active;
  if (saved.side === 'files' || saved.side === 'git') layout.side = saved.side;
  if (saved.panelCollapsed === true) layout.panelCollapsed = true;
  if (saved.gitPage === 'history' || saved.gitPage === 'sync') layout.gitPage = saved.gitPage;
  if (Number.isFinite(saved.chatScroll)) layout.chatScroll = saved.chatScroll;
  if (typeof saved.lastConversationId === 'string') layout.lastConversationId = saved.lastConversationId;
  return layout;
}

export function showContentTab(layout: SessionLayout, tab: ContentTab): SessionLayout {
  const existing = layout.tabs.find((item) => item.id === tab.id);
  if (existing)
    return {
      ...layout,
      active: tab.id,
      tabs: layout.tabs.map((item) =>
        item.id === tab.id
          ? {
              ...tab,
              scroll: tab.line ? undefined : existing.scroll,
              preview: existing.preview && tab.preview,
            }
          : item,
      ),
    };
  const replace = tab.preview ? layout.tabs.findIndex((item) => item.preview) : -1;
  const tabs = [...layout.tabs];
  if (replace >= 0) tabs[replace] = tab;
  else tabs.push(tab);
  return { ...layout, active: tab.id, tabs };
}

export function worktreeLayoutOwner(cwd: string, tree?: WorkspaceTree) {
  return 'worktree:' + JSON.stringify([cwd, tree?.detached ? 'detached' : tree ? 'branch' : 'directory', tree?.branch ?? '']);
}

export function presentConversation(layout: SessionLayout, session: { id: string; title: string } | null, focus = true): SessionLayout {
  // Restoring a conversation behind an open document must preserve that document.
  const selected = layout.tabs.find(tab => tab.id === layout.active);
  const showChat = focus || !selected || selected.kind === 'conversation';
  if (!session) return { ...layout, lastConversationId: undefined, active: showChat ? 'chat' : layout.active };
  const id = 'conversation:' + session.id;
  const existing = layout.tabs.some(tab => tab.id === id);
  const tabs: ContentTab[] = existing
    ? layout.tabs.map(tab => tab.id === id ? { ...tab, title: session.title } : tab)
    : [...layout.tabs, { kind: 'conversation', id, sessionId: session.id, title: session.title }];
  return { ...layout, tabs, lastConversationId: session.id,
    active: showChat ? id : layout.active };
}

function remainingTabs<T extends ContentTab>(group: { tabs: T[]; active: string }, closing: ReadonlySet<string>) {
  const tabs = group.tabs.filter(tab => !closing.has(tab.id));
  if (tabs.length === group.tabs.length) return;
  let active = group.active;
  if (closing.has(active)) {
    const index = group.tabs.findIndex(tab => tab.id === active);
    active = group.tabs.find((tab, i) => i > index && !closing.has(tab.id))?.id ?? tabs.at(-1)?.id ?? 'chat';
  }
  return { tabs, active };
}

export function removeContentTabs(layout: SessionLayout, closing: ReadonlySet<string>, group: EditorGroup = 'left'): SessionLayout {
  if (group === 'right') {
    const right = layout.right && remainingTabs(layout.right, closing);
    return right ? { ...layout, right: right.tabs.length ? right : undefined } : layout;
  }
  const remaining = remainingTabs(layout, closing);
  if (!remaining) return layout;
  const { tabs, active } = remaining;
  const selected = tabs.find(tab => tab.id === active);
  let lastConversationId = layout.lastConversationId;
  if (selected?.kind === 'conversation') lastConversationId = selected.sessionId;
  else if (lastConversationId && closing.has('conversation:' + lastConversationId)) lastConversationId = tabs.find(tab => tab.kind === 'conversation')?.sessionId;
  return { ...layout, tabs, active, lastConversationId };
}

export function removeContentTab(layout: SessionLayout, id: string): SessionLayout {
  return removeContentTabs(layout, new Set([id]));
}

export type FileTab = Extract<ContentTab, { kind: 'file' }>;
export type EditorGroup = 'left' | 'right';

export function workspaceFilePath(cwd: string, requested: string) {
  return /^(?:[a-z]:[\\/]|\\\\)/i.test(cwd) ? requested.replaceAll('\\', '/') : requested;
}

export function workspaceFileTab(cwd: string, requested: string): FileTab {
  const path = workspaceFilePath(cwd, requested);
  return { kind: 'file', cwd, path, source: 'workspace', title: path.split(/[\\/]/).pop() || path,
    id: JSON.stringify(['file', cwd, 'workspace', path]) };
}

export function showFileInGroup(layout: SessionLayout, file: FileTab, group: EditorGroup): SessionLayout {
  if (group === 'left') return showContentTab(layout, file);
  const current = layout.right?.tabs ?? [];
  const existing = current.find(tab => tab.id === file.id);
  const tab = existing ? { ...existing, ...file, scroll: file.line ? undefined : existing.scroll, preview: existing.preview && file.preview } : file;
  const replace = existing?.id ?? (tab.preview ? current.find(item => item.preview)?.id : undefined);
  return { ...layout, right: { tabs: replace ? current.map(item => item.id === replace ? tab : item) : [...current, tab], active: tab.id } };
}

export function removeRightTab(layout: SessionLayout, id: string): SessionLayout {
  return removeContentTabs(layout, new Set([id]), 'right');
}
