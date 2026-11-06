import { useMemo, useRef } from 'react';
import type { Dispatch, MutableRefObject, SetStateAction } from 'react';
import type { PiWorkspace } from './app-types';
import type { SidebarAction } from './SidebarActions';
import type { SidebarWorkspaceActions } from './SidebarWorkspaceList';

type SidebarWorkspaceActionsOptions = {
  workspaces: PiWorkspace[];
  isNewConversation: boolean;
  sidebarFiltering: boolean;
  dragPreviewRef: MutableRefObject<HTMLDivElement | null>;
  setExpanded: Dispatch<SetStateAction<Set<string>>>;
  setSearchCollapsed: Dispatch<SetStateAction<Set<string>>>;
  selectDraftWorkspace: (cwd: string) => void;
  openSession: (item: PiWorkspace['sessions'][number]) => Promise<boolean>;
  prefetchSession: (sessionId: string) => void;
  startSession: (cwd: string) => Promise<void>;
  sidebarAction: (
    kind: 'workspace' | 'session',
    id: string,
    action: SidebarAction,
    name?: string,
    options?: { preserveCurrentView?: boolean; notify?: boolean },
  ) => Promise<void>;
  reorderWorkspaces: (source: string, target: string) => void;
  reorderSessions: (cwd: string, source: string, target: string) => void;
  clearSidebarFilters: () => void;
  makeDragPreview: (event: React.DragEvent, label: string, kind: '工作区' | '会话' | '标签') => void;
};

export function useSidebarWorkspaceActions(options: SidebarWorkspaceActionsOptions) {
  const latest = useRef<SidebarWorkspaceActions>(null!);
  latest.current = {
    onToggleWorkspace(cwd, isOpen) {
      if (options.isNewConversation) options.selectDraftWorkspace(cwd);
      if (options.sidebarFiltering) {
        options.setSearchCollapsed((current) => {
          const next = new Set(current);
          if (isOpen) next.add(cwd); else next.delete(cwd);
          return next;
        });
      } else {
        options.setExpanded((current) => {
          const next = new Set(current);
          if (isOpen) next.delete(cwd); else next.add(cwd);
          return next;
        });
      }
    },
    onOpenSession: (item) => { void options.openSession(item); },
    onPrefetchSession: (id) => options.prefetchSession(id),
    onStartSession: (cwd) => { void options.startSession(cwd); },
    onAction: options.sidebarAction,
    onReorderWorkspaces: options.reorderWorkspaces,
    onReorderSessions: options.reorderSessions,
    onClearFilters: options.clearSidebarFilters,
    onMakeDragPreview: options.makeDragPreview,
    onClearDragPreview() {
      options.dragPreviewRef.current?.remove();
      options.dragPreviewRef.current = null;
    },
  };

  return useMemo<SidebarWorkspaceActions>(() => ({
    onToggleWorkspace: (...args) => latest.current.onToggleWorkspace(...args),
    onOpenSession: (...args) => latest.current.onOpenSession(...args),
    onPrefetchSession: (...args) => latest.current.onPrefetchSession(...args),
    onStartSession: (...args) => latest.current.onStartSession(...args),
    onAction: (...args) => latest.current.onAction(...args),
    onReorderWorkspaces: (...args) => latest.current.onReorderWorkspaces(...args),
    onReorderSessions: (...args) => latest.current.onReorderSessions(...args),
    onClearFilters: () => latest.current.onClearFilters(),
    onMakeDragPreview: (...args) => latest.current.onMakeDragPreview(...args),
    onClearDragPreview: () => latest.current.onClearDragPreview(),
  }), []);
}
