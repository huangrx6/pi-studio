import { useEffect, useMemo, useRef, useState } from 'react';
import type { Dispatch, MutableRefObject, SetStateAction } from 'react';
import type { PiWorkspace } from './app-types';
import { filterSidebarWorkspaces, type SidebarSessionFilter } from './sidebar-filter';
import {
  STORED_UI_KEYS,
  loadStoredExpandedWorkspaces,
  loadStoredSessionOrder,
  loadStoredWorkspaceOrder,
} from '../shared/stored-ui-state';

type Setter<T> = Dispatch<SetStateAction<T>>;

type SidebarWorkspaceDependencies = {
  workspaces: PiWorkspace[];
  setWorkspaces: Setter<PiWorkspace[]>;
  workspace: string;
};

/** Writes UI state; private-mode storage failures are intentionally ignored. */
function writeStored(key: string, value: unknown): void {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage unavailable */ }
}

export function useSidebarWorkspace({
  workspaces,
  setWorkspaces,
  workspace,
}: SidebarWorkspaceDependencies) {
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(loadStoredExpandedWorkspaces()));
  const [workspaceOrder, setWorkspaceOrder] = useState<string[]>(loadStoredWorkspaceOrder);
  const [sessionOrder, setSessionOrder] = useState<Record<string, string[]>>(loadStoredSessionOrder);
  const [workspaceSearchOpen, setWorkspaceSearchOpen] = useState(false);
  const [workspaceQuery, setWorkspaceQuery] = useState('');
  const [sidebarSessionFilter, setSidebarSessionFilter] = useState<SidebarSessionFilter>('all');
  const [searchCollapsed, setSearchCollapsed] = useState<Set<string>>(() => new Set());
  const workspaceOrderRef = useRef(workspaceOrder);
  const sessionOrderRef = useRef(sessionOrder);
  const workspaceSearchTrigger = useRef<HTMLButtonElement>(null);
  const dragPreviewRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    workspaceOrderRef.current = workspaceOrder;
    writeStored(STORED_UI_KEYS.workspaceOrder, workspaceOrder);
  }, [workspaceOrder]);

  useEffect(() => {
    sessionOrderRef.current = sessionOrder;
    writeStored(STORED_UI_KEYS.sessionOrder, sessionOrder);
  }, [sessionOrder]);

  useEffect(() => {
    writeStored(STORED_UI_KEYS.expanded, [...expanded]);
  }, [expanded]);

  const activeWorkspace = useMemo(
    () => workspaces.find((item) => item.cwd === workspace),
    [workspaces, workspace],
  );
  const sidebarFiltering = Boolean(workspaceQuery.trim()) || sidebarSessionFilter !== 'all';
  const visibleWorkspaces = useMemo(
    () => filterSidebarWorkspaces(workspaces, workspaceQuery, sidebarSessionFilter),
    [workspaces, workspaceQuery, sidebarSessionFilter],
  );
  const allExpanded = visibleWorkspaces.length > 0 && visibleWorkspaces.every((item) => (
    sidebarFiltering ? !searchCollapsed.has(item.cwd) : expanded.has(item.cwd)
  ));

  function changeWorkspaceQuery(value: string) {
    setWorkspaceQuery(value);
    setSearchCollapsed(new Set());
  }

  function changeSidebarFilter(value: SidebarSessionFilter) {
    setSidebarSessionFilter(value);
    setSearchCollapsed(new Set());
  }

  function clearSidebarFilters() {
    changeWorkspaceQuery('');
    changeSidebarFilter('all');
  }

  function closeSidebarSearch() {
    setWorkspaceSearchOpen(false);
    clearSidebarFilters();
    workspaceSearchTrigger.current?.focus();
  }

  function toggleAllExpanded() {
    if (sidebarFiltering) {
      setSearchCollapsed(allExpanded ? new Set(visibleWorkspaces.map(item => item.cwd)) : new Set());
    } else {
      setExpanded(allExpanded ? new Set() : new Set(workspaces.map((item) => item.cwd)));
    }
  }

  function expandWorkspace(cwd: string) {
    setExpanded((current) => {
      if (current.has(cwd)) return current;
      const next = new Set(current);
      next.add(cwd);
      return next;
    });
  }

  function makeDragPreview(event: React.DragEvent, label: string, kind: '工作区' | '会话' | '标签') {
    dragPreviewRef.current?.remove();
    const ghost = document.createElement('div');
    ghost.className = 'drag-preview';
    const tag = document.createElement('span');
    tag.className = 'drag-preview-kind';
    tag.textContent = kind;
    const text = document.createElement('span');
    text.className = 'drag-preview-label';
    text.textContent = label;
    ghost.append(tag, text);
    document.body.appendChild(ghost);
    dragPreviewRef.current = ghost;
    event.dataTransfer.setDragImage(ghost, 14, 18);
  }

  function reorderWorkspaces(source: string, target: string) {
    if (source === target) return;
    const order = workspaces.map((item) => item.cwd);
    const from = order.indexOf(source);
    const to = order.indexOf(target);
    if (from < 0 || to < 0) return;
    order.splice(to, 0, ...order.splice(from, 1));
    setWorkspaceOrder(order);
    setWorkspaces(current => {
      const byCwd = new Map(current.map(item => [item.cwd, item]));
      return order.flatMap(cwd => byCwd.get(cwd) ?? []);
    });
  }

  function reorderSessions(cwd: string, source: string, target: string) {
    if (source === target) return;
    const workspaceEntry = workspaces.find((item) => item.cwd === cwd);
    if (!workspaceEntry) return;
    const order = workspaceEntry.sessions.map((item) => item.id);
    const from = order.indexOf(source);
    const to = order.indexOf(target);
    if (from < 0 || to < 0) return;
    order.splice(to, 0, ...order.splice(from, 1));
    setSessionOrder((current) => ({ ...current, [cwd]: order }));
    setWorkspaces(current => current.map(item => {
      if (item.cwd !== cwd) return item;
      const byId = new Map(item.sessions.map(entry => [entry.id, entry]));
      return { ...item, sessions: order.flatMap(id => byId.get(id) ?? []) };
    }));
  }

  return {
    expanded,
    setExpanded,
    workspaceOrder,
    setWorkspaceOrder,
    sessionOrder,
    setSessionOrder,
    workspaceOrderRef,
    sessionOrderRef,
    workspaceSearchOpen,
    setWorkspaceSearchOpen,
    workspaceQuery,
    setWorkspaceQuery,
    sidebarSessionFilter,
    searchCollapsed,
    setSearchCollapsed,
    workspaceSearchTrigger,
    dragPreviewRef,
    activeWorkspace,
    sidebarFiltering,
    visibleWorkspaces,
    allExpanded,
    changeWorkspaceQuery,
    changeSidebarFilter,
    clearSidebarFilters,
    closeSidebarSearch,
    toggleAllExpanded,
    expandWorkspace,
    makeDragPreview,
    reorderWorkspaces,
    reorderSessions,
  };
}
