import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import type { PiWorkspace } from './app-types';
import { useSettingsToast } from '../shared/SettingsToast';
import { groupSidebarProjects, sidebarProjectKey } from './sidebar-projects';
import { filterSidebarWorkspaces, type SidebarSessionFilter } from './sidebar-filter';
import {
  STORED_UI_KEYS,
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
  const showToast = useSettingsToast();
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [expandedReady, setExpandedReady] = useState(false);
  const expandedHydrated = useRef(false);

  const restoreExpanded = useCallback((keys: string[]) => {
    if (expandedHydrated.current) return;
    expandedHydrated.current = true;
    setExpanded(current => new Set([...keys, ...current]));
    setExpandedReady(true);
  }, []);
  const [workspaceOrder, setWorkspaceOrder] = useState<string[]>(loadStoredWorkspaceOrder);
  const [sessionOrder, setSessionOrder] = useState<Record<string, string[]>>(loadStoredSessionOrder);
  const [workspaceSearchOpen, setWorkspaceSearchOpen] = useState(false);
  const [workspaceQuery, setWorkspaceQuery] = useState('');
  const [sidebarSessionFilter, setSidebarSessionFilter] = useState<SidebarSessionFilter>('all');
  const [searchCollapsed, setSearchCollapsed] = useState<Set<string>>(() => new Set());
  const knownWorkspaces = useRef(workspaces);
  knownWorkspaces.current = workspaces;
  const pendingReveal = useRef('');
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
    if (expandedReady) void window.piApi.saveExpandedProjects([...expanded]).catch(() => showToast('项目展开状态保存失败', 'error'));
  }, [expandedReady, expanded, showToast]);

  const activeWorkspace = useMemo(
    () => workspaces.find((item) => item.cwd === workspace),
    [workspaces, workspace],
  );
  const sidebarFiltering = Boolean(workspaceQuery.trim()) || sidebarSessionFilter !== 'all';
  const visibleWorkspaces = useMemo(
    () => filterSidebarWorkspaces(workspaces, workspaceQuery, sidebarSessionFilter),
    [workspaces, workspaceQuery, sidebarSessionFilter],
  );
  const visibleProjects = useMemo(() => groupSidebarProjects(workspaces, visibleWorkspaces), [workspaces, visibleWorkspaces]);
  const expandableKeys = useMemo(() => visibleProjects.flatMap(project => [
    ...(project.nested ? [project.key] : []),
    ...project.workspaces.filter(item => item.sessions.length || item.rooms?.length).map(item => item.cwd),
  ]), [visibleProjects]);
  const allExpanded = expandableKeys.length > 0 && expandableKeys.every(key => (
    sidebarFiltering ? !searchCollapsed.has(key) : expanded.has(key)
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
      setSearchCollapsed(allExpanded ? new Set(expandableKeys) : new Set());
    } else {
      setExpanded(allExpanded ? new Set() : new Set(expandableKeys));
    }
  }

  const expandWorkspace = useCallback((cwd: string) => {
    const item = knownWorkspaces.current.find(entry => entry.cwd === cwd);
    pendingReveal.current = item ? '' : cwd;
    const project = item?.worktree && sidebarProjectKey(item.worktree.projectRoot);
    setExpanded(current => {
      if (current.has(cwd) && (!project || current.has(project))) return current;
      const next = new Set(current);
      next.add(cwd);
      if (project) next.add(project);
      return next;
    });
  }, []);

  useEffect(() => {
    const cwd = pendingReveal.current;
    if (cwd && workspaces.some(item => item.cwd === cwd)) expandWorkspace(cwd);
  }, [workspaces, expandWorkspace]);

  function makeDragPreview(event: React.DragEvent, label: string, kind: '工作区' | '会话') {
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
    const projects = groupSidebarProjects(workspaces);
    const from = projects.findIndex(project => project.workspaces.some(item => item.cwd === source));
    const to = projects.findIndex(project => project.workspaces.some(item => item.cwd === target));
    if (from < 0 || to < 0 || from === to) return;
    projects.splice(to, 0, ...projects.splice(from, 1));
    const order = projects.flatMap(project => project.workspaces.map(item => item.cwd));
    setWorkspaceOrder(order);
    setWorkspaces(current => {
      const byCwd = new Map(current.map(item => [item.cwd, item]));
      const listed = new Set(order);
      return [...order.flatMap(cwd => byCwd.get(cwd) ?? []), ...current.filter(item => !listed.has(item.cwd))];
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
      const listed = new Set(order);
      return { ...item, sessions: [...order.flatMap(id => byId.get(id) ?? []), ...item.sessions.filter(session => !listed.has(session.id))] };
    }));
  }

  return {
    restoreExpanded,
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
    visibleProjects,
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
