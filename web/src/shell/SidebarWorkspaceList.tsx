import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type DragEvent } from 'react';
import { ChevronDown, Folder, FolderOpen, LoaderCircle } from 'lucide-react';
import type { ConversationSummary } from '../types/durable-types';
import { SidebarActions, type SidebarAction } from './SidebarActions';
import { SessionRecency } from './SessionRecency';
import { focusNeighborIndices, sessionWindowSegments, SIDEBAR_VIRTUAL_THRESHOLD, visibleSessionIndices } from './sidebar-virtualization.mjs';
import './sidebar-workspace-list.css';

export type SidebarWorkspace = { cwd: string; name: string; sessions: ConversationSummary[]; sessionCount?: number; archivedCount?: number };
export type SidebarWorkspaceActions = {
  onToggleWorkspace: (cwd: string, isOpen: boolean) => void;
  onOpenSession: (session: ConversationSummary) => void;
  onPrefetchSession: (id: string) => void;
  onStartSession: (cwd: string) => void;
  onAction: (kind: 'workspace' | 'session', id: string, action: SidebarAction, name?: string) => Promise<void>;
  onReorderWorkspaces: (from: string, to: string) => void;
  onReorderSessions: (cwd: string, from: string, to: string) => void;
  onClearFilters: () => void;
  onMakeDragPreview: (event: DragEvent<HTMLButtonElement>, label: string, kind: '工作区' | '会话' | '标签') => void;
  onClearDragPreview: () => void;
};
export type SidebarWorkspaceListProps = {
  workspaces: SidebarWorkspace[]; loading: boolean; hasWorkspaces: boolean;
  activeWorkspace: string; activeSessionId?: string; expanded: Set<string>;
  filtering: boolean; searchCollapsed: Set<string>; filterKey: string; visible: boolean;
  actions: SidebarWorkspaceActions;
  actionsDisabled?: boolean;
};
type DragItem = { kind: 'workspace' | 'session'; cwd: string; sessionId?: string };
type LogicalRow = { key: string; cwd: string; kind: 'workspace' | 'session' | 'empty'; sessionId?: string; index?: number };
const workspaceKey = (cwd: string) => `w:${cwd}`;
const sessionKey = (id: string) => `s:${id}`;

/** Owns sidebar scrolling/keyboard/drag state; application data and writes stay in App. */
export const SidebarWorkspaceList = memo(function SidebarWorkspaceList({ workspaces, loading, hasWorkspaces, activeWorkspace, activeSessionId, expanded, filtering, searchCollapsed, filterKey, visible, actions, actionsDisabled = false }: SidebarWorkspaceListProps) {
  const root = useRef<HTMLDivElement>(null);
  const [viewport, setViewport] = useState({ top: 0, height: 600, rowHeight: 36, groups: {} as Record<string, number> });
  const [focusedKey, setFocusedKey] = useState<string | null>(null);
  const [interactionKeys, setInteractionKeys] = useState<Set<string>>(() => new Set());
  const [pendingFocus, setPendingFocus] = useState<{ key: string; edge: 'first' | 'last' | number } | null>(null);
  const focusInProgress = useRef(false);
  const lastTab = useRef({ backwards: false, active: false });
  const [dragging, setDragging] = useState<DragItem | null>(null);
  const dragRef = useRef<DragItem | null>(null);
  const [dropHint, setDropHint] = useState<string | null>(null);
  const [justDropped, setJustDropped] = useState<string | null>(null);
  const droppedTimer = useRef<number>();
  const dragPointer = useRef<number | null>(null);
  const dragFrame = useRef<number>(0);
  const scrollFrame = useRef<number>(0);
  const isOpen = (cwd: string) => filtering ? !searchCollapsed.has(cwd) : expanded.has(cwd);
  const logicalRows = useMemo(() => workspaces.flatMap((item): LogicalRow[] => {
    const rows: LogicalRow[] = [{ key: workspaceKey(item.cwd), cwd: item.cwd, kind: 'workspace' }];
    if (!(filtering ? !searchCollapsed.has(item.cwd) : expanded.has(item.cwd))) return rows;
    return [...rows, ...(item.sessions.length ? item.sessions.map((session, index): LogicalRow => ({ key: sessionKey(session.id), cwd: item.cwd, kind: 'session', sessionId: session.id, index })) : [{ key: `empty:${item.cwd}`, cwd: item.cwd, kind: 'empty' as const }])];
  }), [workspaces, filtering, searchCollapsed, expanded]);
  const rowsRef = useRef(logicalRows);
  rowsRef.current = logicalRows;

  const measure = useCallback(() => {
    const element = root.current;
    if (!element || !visible || element.clientHeight === 0) return;
    const top = element.getBoundingClientRect().top + element.clientTop;
    const groups: Record<string, number> = {};
    element.querySelectorAll<HTMLElement>('[data-session-group]').forEach((group) => { groups[group.dataset.sessionGroup!] = group.getBoundingClientRect().top - top + element.scrollTop; });
    const rowHeight = element.querySelector<HTMLElement>('.session-row')?.getBoundingClientRect().height || Number.parseFloat(getComputedStyle(element).getPropertyValue('--control')) || 36;
    setViewport((previous) => {
      const next = { top: element.scrollTop, height: element.clientHeight, rowHeight, groups };
      return previous.top === next.top && previous.height === next.height && previous.rowHeight === next.rowHeight && JSON.stringify(previous.groups) === JSON.stringify(groups) ? previous : next;
    });
  }, [visible]);
  useLayoutEffect(measure, [measure, workspaces, expanded, searchCollapsed, filtering, viewport.rowHeight]);
  useEffect(() => {
    if (!visible || !root.current) return;
    const observer = new ResizeObserver(measure);
    observer.observe(root.current);
    return () => observer.disconnect();
  }, [visible, measure]);
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => { lastTab.current = { backwards: event.key === 'Tab' && event.shiftKey, active: event.key === 'Tab' }; };
    const clearTab = () => { lastTab.current.active = false; };
    const keyup = (event: KeyboardEvent) => { if (event.key === 'Tab') clearTab(); };
    document.addEventListener('keydown', keydown, true);
    document.addEventListener('keyup', keyup, true);
    document.addEventListener('pointerdown', clearTab, true);
    return () => {
      document.removeEventListener('keydown', keydown, true);
      document.removeEventListener('keyup', keyup, true);
      document.removeEventListener('pointerdown', clearTab, true);
    };
  }, []);
  const requestFocus = useCallback((key: string, edge: 'first' | 'last' | number = 'first') => {
    setFocusedKey(key); setPendingFocus({ key, edge });
  }, []);
  const rowElement = (key: string) => [...(root.current?.querySelectorAll<HTMLElement>('[data-sidebar-key]') || [])].find((node) => node.dataset.sidebarKey === key);
  const rowButtons = (node: HTMLElement) => [...node.querySelectorAll<HTMLButtonElement>(':scope > button:not(:disabled), :scope > .sidebar-row-actions > button:not(:disabled)')];
  useLayoutEffect(() => {
    if (!pendingFocus || !visible) return;
    const node = rowElement(pendingFocus.key);
    if (!node) { if (!logicalRows.some((row) => row.key === pendingFocus.key)) setPendingFocus(null); return; }
    const buttons = rowButtons(node);
    focusInProgress.current = true;
    // Native Tab can blur the row before its hidden action receives focus.
    // Keep actions visible only during the transfer; :focus-within takes over.
    node.setAttribute('data-transferring-focus', 'true');
    buttons[0]?.focus({ preventScroll: true });
    if (pendingFocus.edge === 'last') buttons[buttons.length - 1]?.focus({ preventScroll: true });
    else if (typeof pendingFocus.edge === 'number') buttons[pendingFocus.edge]?.focus({ preventScroll: true });
    node.removeAttribute('data-transferring-focus');
    node.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' });
    focusInProgress.current = false;
    setPendingFocus(null);
    measure();
  }, [pendingFocus, visible, logicalRows, measure]);
  const retainInteraction = useCallback((key: string, active: boolean) => {
    setInteractionKeys((previous) => {
      if (previous.has(key) === active) return previous;
      const next = new Set(previous); if (active) next.add(key); else next.delete(key); return next;
    });
  }, []);
  // Called only when an action removed its own trigger. Locate the nearest
  // surviving logical neighbor rather than depending on sparse DOM siblings.
  function restoreRemovedRow(row: LogicalRow, priorIndex = logicalRows.findIndex((item) => item.key === row.key)) {
    const current = rowsRef.current;
    const sameWorkspace = current.filter((item) => item.kind === 'session' && item.cwd === row.cwd);
    const next = sameWorkspace[Math.min(row.index ?? 0, sameWorkspace.length - 1)] || current.find((item) => item.key === workspaceKey(row.cwd)) || current[Math.max(0, Math.min(priorIndex, current.length - 1))];
    if (!next) return false;
    requestFocus(next.key); return true;
  }
  const previousLogicalRows = useRef(logicalRows);
  useLayoutEffect(() => {
    const previous = previousLogicalRows.current;
    previousLogicalRows.current = logicalRows;
    // A successful archive/delete can unmount SidebarActions together with its
    // dialog before that child's promise/focus effect resumes. The list owns
    // this recovery so it survives removal of the action component itself.
    if (document.activeElement !== document.body) return;
    const removedOwner = previous.find((row) => (interactionKeys.has(row.key) || focusedKey === row.key) && !logicalRows.some((current) => current.key === row.key));
    if (removedOwner && !restoreRemovedRow(removedOwner, previous.indexOf(removedOwner))) document.querySelector<HTMLButtonElement>('.new-chat')?.focus();
  }, [logicalRows]);
  // Selection changes may arrive from notifications. Locate without taking focus
  // from the composer; ordinary row refreshes must not pull the user back.
  const located = useRef<{ id?: string; visible: boolean }>({ visible: false });
  useLayoutEffect(() => {
    const changed = located.current.id !== activeSessionId || (!located.current.visible && visible);
    located.current = { id: activeSessionId, visible };
    if (!changed || !visible || !activeSessionId || !root.current) return;
    const row = logicalRows.find((item) => item.sessionId === activeSessionId);
    if (!row || row.index === undefined) return;
    const group = [...root.current.querySelectorAll<HTMLElement>('[data-session-group]')].find((element) => element.dataset.sessionGroup === row.cwd);
    if (!group) return;
    const element = root.current;
    const groupTop = group.getBoundingClientRect().top - element.getBoundingClientRect().top - element.clientTop + element.scrollTop;
    const rowTop = groupTop + row.index * viewport.rowHeight;
    if (rowTop < element.scrollTop) element.scrollTop = rowTop;
    else if (rowTop + viewport.rowHeight > element.scrollTop + element.clientHeight) element.scrollTop = rowTop + viewport.rowHeight - element.clientHeight;
    measure();
  }, [activeSessionId, visible, logicalRows, viewport.rowHeight, measure]);
  const previousFilter = useRef(filterKey);
  useLayoutEffect(() => {
    if (previousFilter.current === filterKey) return;
    previousFilter.current = filterKey;
    if (root.current) root.current.scrollTop = 0;
    measure();
  }, [filterKey, measure]);

  function clearDrag() {
    dragRef.current = null; setDragging(null); setDropHint(null);
    dragPointer.current = null; cancelAnimationFrame(dragFrame.current); dragFrame.current = 0;
    actions.onClearDragPreview();
  }
  function markDropped(key: string) {
    clearTimeout(droppedTimer.current); setJustDropped(key);
    droppedTimer.current = window.setTimeout(() => setJustDropped(null), 300);
  }
  function startDrag(event: DragEvent<HTMLButtonElement>, item: DragItem, label: string) {
    dragRef.current = item; setDragging(item);
    actions.onMakeDragPreview(event, label, item.kind === 'workspace' ? '工作区' : '会话');
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', item.sessionId || item.cwd);
  }
  function trackDrag(event: DragEvent<HTMLDivElement>) {
    if (!dragRef.current) return;
    event.preventDefault(); dragPointer.current = event.clientY;
    if (dragFrame.current) return;
    const step = () => {
      const element = root.current;
      if (!element || !dragRef.current || dragPointer.current === null) { dragFrame.current = 0; return; }
      const box = element.getBoundingClientRect();
      const offset = dragPointer.current < box.top + 44 ? -Math.min(18, (box.top + 44 - dragPointer.current) / 2) : dragPointer.current > box.bottom - 44 ? Math.min(18, (dragPointer.current - box.bottom + 44) / 2) : 0;
      if (offset) { element.scrollTop += offset; measure(); }
      dragFrame.current = requestAnimationFrame(step);
    };
    dragFrame.current = requestAnimationFrame(step);
  }
  useEffect(() => () => { cancelAnimationFrame(dragFrame.current); cancelAnimationFrame(scrollFrame.current); clearTimeout(droppedTimer.current); }, []);

  return <div ref={root} className="workspace-list" onScroll={() => {
    if (!visible || scrollFrame.current) return;
    scrollFrame.current = requestAnimationFrame(() => { scrollFrame.current = 0; measure(); });
  }} onDragOver={trackDrag} onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node)) dragPointer.current = null; }} onDrop={clearDrag} onDragEnd={clearDrag}
    onBlurCapture={(event) => {
      if (event.relatedTarget instanceof Node && root.current?.contains(event.relatedTarget)) return;
      // Portal menus/dialogs retain their owner through onInteractionChange;
      // the keyboard-only neighbor retention ends when focus leaves the list.
      setFocusedKey(null);
    }}
    onFocusCapture={(event) => {
      if (focusInProgress.current || !root.current?.contains(event.target)) return;
      const target = event.target as HTMLElement;
      if (target.closest('dialog, [role="menu"]')) return;
      const row = target.closest<HTMLElement>('[data-sidebar-key]');
      if (!row) return;
      setFocusedKey(row.dataset.sidebarKey!);
      const fromPortal = event.relatedTarget instanceof Element && Boolean(event.relatedTarget.closest('dialog, [role="dialog"], [role="menu"]'));
      const fromOutside = !fromPortal && (!(event.relatedTarget instanceof Node) || !root.current.contains(event.relatedTarget));
      if (fromOutside && lastTab.current.active && lastTab.current.backwards) {
        const last = logicalRows[logicalRows.length - 1];
        if (last && (row.dataset.sidebarKey !== last.key || target !== rowButtons(row).at(-1))) requestFocus(last.key, 'last');
      }
    }} onKeyDown={(event) => {
      if (event.key !== 'Tab' || event.nativeEvent.isComposing || !root.current?.contains(event.target as Node)) return;
      const target = event.target as HTMLElement;
      if (target.closest('dialog, [role="menu"]')) return;
      const row = target.closest<HTMLElement>('[data-sidebar-key]');
      if (!row) return;
      const buttons = rowButtons(row);
      const buttonIndex = buttons.indexOf(target as HTMLButtonElement);
      const nextButton = buttonIndex + (event.shiftKey ? -1 : 1);
      if (buttonIndex >= 0 && nextButton >= 0 && nextButton < buttons.length) {
        event.preventDefault(); requestFocus(row.dataset.sidebarKey!, nextButton); return;
      }
      const atBoundary = event.shiftKey ? target === buttons[0] : target === buttons.at(-1);
      if (!atBoundary) return;
      const index = logicalRows.findIndex((item) => item.key === row.dataset.sidebarKey);
      const next = logicalRows[index + (event.shiftKey ? -1 : 1)];
      if (!next) return;
      event.preventDefault(); requestFocus(next.key, event.shiftKey ? 'last' : 'first');
    }}>
    {loading && !hasWorkspaces && <div className="workspace-skeleton" role="status" aria-live="polite" aria-label="正在加载工作区"><span className="sr-only">正在加载工作区…</span>{[0, 1, 2].map((group) => <div className="skeleton-group" key={group} style={{ animationDelay: `${group * 90}ms` }}><div className="skeleton-workspace-head"><span className="skeleton-icon" /><span className="skeleton-line" style={{ width: `${[46, 60, 38][group]}%` }} /><span className="skeleton-chevron" /></div><div className="skeleton-sessions"><span className="skeleton-session-line" style={{ width: `${[74, 58][group % 2]}%` }} /><span className="skeleton-session-line" style={{ width: `${[53, 67][group % 2]}%` }} /></div></div>)}</div>}
    {!(loading && !hasWorkspaces) && workspaces.map((item) => {
      const open = isOpen(item.cwd);
      const active = activeWorkspace === item.cwd && open;
      const key = workspaceKey(item.cwd);
      const focused = logicalRows.find((row) => row.key === focusedKey && row.cwd === item.cwd);
      const retained = focused?.index !== undefined ? focusNeighborIndices(focused.index, item.sessions.length) : [];
      for (const pinnedKey of interactionKeys) { const index = item.sessions.findIndex((session) => sessionKey(session.id) === pinnedKey); if (index >= 0) retained.push(index); }
      if (dragging?.kind === 'session' && dragging.cwd === item.cwd) { const index = item.sessions.findIndex((session) => session.id === dragging.sessionId); if (index >= 0) retained.push(index); }
      const indices = visibleSessionIndices(item.sessions.length, viewport.top, viewport.height, viewport.groups[item.cwd] ?? 0, viewport.rowHeight, retained);
      const virtual = item.sessions.length > SIDEBAR_VIRTUAL_THRESHOLD;
      return <div className="workspace" key={item.cwd} data-workspace-cwd={item.cwd}>
        <div className="sidebar-row-shell workspace-row-shell" data-sidebar-key={key}>
          <button className={`workspace-row ${active ? 'is-active' : ''} ${dropHint === key ? 'drop-before' : ''} ${dragging?.kind === 'workspace' && dragging.cwd === item.cwd ? 'is-dragging' : ''} ${justDropped === key ? 'just-dropped' : ''}`} title={item.name && item.name !== item.cwd ? `${item.name}\n${item.cwd}` : item.cwd} aria-expanded={open} draggable
            onDragStart={(event) => startDrag(event, { kind: 'workspace', cwd: item.cwd }, item.name)}
            onDragOver={(event) => { if (dragRef.current?.kind !== 'workspace' || dragRef.current.cwd === item.cwd) return; event.preventDefault(); event.dataTransfer.dropEffect = 'move'; setDropHint(key); }}
            onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node)) setDropHint(null); }}
            onDrop={(event) => { event.preventDefault(); if (dragRef.current?.kind === 'workspace') { actions.onReorderWorkspaces(dragRef.current.cwd, item.cwd); markDropped(key); } clearDrag(); }}
            onClick={() => actions.onToggleWorkspace(item.cwd, open)}>
            {open ? <FolderOpen size={15} /> : <Folder size={15} />}<span className="workspace-label">{item.name}</span><ChevronDown size={13} className={open ? 'chevron open' : 'chevron'} />
          </button>
          <SidebarActions disabled={actionsDisabled} kind="workspace" id={item.cwd} name={item.name} sessionCount={item.sessionCount} archivedCount={item.archivedCount} onNew={() => actions.onStartSession(item.cwd)} onAction={(action, name) => actions.onAction('workspace', item.cwd, action, name)} onInteractionChange={(active) => retainInteraction(key, active)} onRestoreFocusFallback={() => restoreRemovedRow({ key, kind: 'workspace', cwd: item.cwd })} />
        </div>
        {open && <div className={`sessions ${virtual ? 'is-virtualized' : ''}`} style={virtual ? { height: item.sessions.length * viewport.rowHeight } : undefined} data-session-group={item.cwd} role="list" aria-label={`${item.name}的会话`}>
          {sessionWindowSegments(indices, item.sessions.length).map((segment) => {
            if (segment.kind === 'gap') return <div key={`gap:${segment.from}`} className="sidebar-session-gap" style={{ height: segment.count * viewport.rowHeight }} aria-hidden="true" />;
            const index = segment.index; const session = item.sessions[index]; const sessionRowKey = sessionKey(session.id);
            const logicalRow: LogicalRow = { key: sessionRowKey, kind: 'session', cwd: item.cwd, sessionId: session.id, index };
            const inViewport = (viewport.groups[item.cwd] ?? 0) + (index + 1) * viewport.rowHeight > viewport.top && (viewport.groups[item.cwd] ?? 0) + index * viewport.rowHeight < viewport.top + viewport.height;
            return <div className={`sidebar-row-shell session-row-shell ${session.pinned ? 'is-pinned' : ''}`} key={session.id} data-sidebar-key={sessionRowKey} data-session-id={session.id} data-session-index={index} role="listitem" aria-posinset={index + 1} aria-setsize={item.sessions.length}>
              <button className={`session-row ${activeSessionId === session.id ? 'is-active' : ''} ${dropHint === sessionRowKey ? 'drop-before' : ''} ${dragging?.sessionId === session.id ? 'is-dragging' : ''} ${justDropped === sessionRowKey ? 'just-dropped' : ''}`} title={`${session.title}${session.pinned ? ' · 已置顶' : ''}`} aria-current={activeSessionId === session.id ? 'page' : undefined} draggable
                onDragStart={(event) => startDrag(event, { kind: 'session', cwd: item.cwd, sessionId: session.id }, session.title)}
                onDragOver={(event) => { const drag = dragRef.current; if (drag?.kind !== 'session' || drag.cwd !== item.cwd || drag.sessionId === session.id) return; event.preventDefault(); event.dataTransfer.dropEffect = 'move'; setDropHint(sessionRowKey); }}
                onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node)) setDropHint(null); }}
                onDrop={(event) => { const drag = dragRef.current; event.preventDefault(); event.stopPropagation(); if (drag?.kind === 'session' && drag.cwd === item.cwd && drag.sessionId) { actions.onReorderSessions(item.cwd, drag.sessionId, session.id); markDropped(sessionRowKey); } clearDrag(); }}
                onClick={() => actions.onOpenSession(session)} onMouseEnter={() => actions.onPrefetchSession(session.id)} onFocus={() => actions.onPrefetchSession(session.id)}>
                <span className="session-title">{session.title}</span><span className="session-meta">{session.running ? <span className="session-running" role="status" aria-label="会话正在运行" title="会话正在运行"><LoaderCircle className="spin" aria-hidden="true" /></span> : session.pinned ? <span className="session-pin-mark" title="已置顶">置顶</span> : <SessionRecency timestamp={session.updatedAt} durationMs={session.lastDurationMs} visible={visible && inViewport} />}</span>
              </button>
              <SidebarActions disabled={actionsDisabled} kind="session" id={session.id} name={session.title} pinned={session.pinned} archived={session.archived} onAction={(action, name) => actions.onAction('session', session.id, action, name)} onInteractionChange={(active) => retainInteraction(sessionRowKey, active)} onRestoreFocusFallback={() => restoreRemovedRow(logicalRow)} />
            </div>;
          })}
          {!item.sessions.length && <div className="sidebar-row-shell" data-sidebar-key={`empty:${item.cwd}`} role="listitem"><button className="session-row empty" onClick={() => actions.onStartSession(item.cwd)}>新会话</button></div>}
        </div>}
      </div>;
    })}
    {!loading && !workspaces.length && <div className="sidebar-empty" role="status" aria-live="polite"><span>{filtering ? '没有匹配的会话' : '还没有工作区'}</span>{filtering && <button type="button" className="sidebar-empty-reset" onClick={actions.onClearFilters}>清除筛选</button>}</div>}
  </div>;
});
