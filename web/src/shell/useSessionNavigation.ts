import { useEffect, useRef, useState } from 'react';
import type { AppFoundation } from './useAppFoundation';
import type { ConversationController } from './useConversationController';
import { sidebarSections, type SidebarSection } from './app-shell-config';
import { worktreeLayoutOwner } from './session-layout';
import { errorText } from '../shared/error-text';

export function useSessionNavigation(foundation: AppFoundation, conversation: ConversationController) {
  const latest = useRef({ foundation, conversation });
  latest.current = { foundation, conversation };
  const [ready, setReady] = useState(false);
  const canRestore = foundation.workspacesLoaded && foundation.composerPersistenceReady;
  useEffect(() => {
    if (!canRestore) return;
    let cancelled = false;
    let interacted = false;
    const onInteraction = () => {
      interacted = true;
    };
    window.addEventListener('pointerdown', onInteraction, true);
    window.addEventListener('keydown', onInteraction, true);
    async function restore() {
      const saved = await window.piApi.readLayout?.('studio', 'navigation');
      if (cancelled || interacted || !saved || typeof saved !== 'object') return;
      const { foundation: f, conversation: c } = latest.current;
      const cwd = 'cwd' in saved && typeof saved.cwd === 'string' ? saved.cwd : '';
      const workspace = f.workspaces.find(row => row.cwd === cwd);
      if (workspace && 'worktree' in saved && typeof saved.worktree === 'string' && saved.worktree !== worktreeLayoutOwner(cwd, workspace.worktree))
        await c.openWorktree(cwd);
      else if ('sessionId' in saved && typeof saved.sessionId === 'string')
        await c.openSession({ id: saved.sessionId }, false, false);
      else if (
        'cwd' in saved &&
        typeof saved.cwd === 'string' &&
        f.workspaces.some((row) => row.cwd === saved.cwd)
      )
        c.selectDraftWorkspace(saved.cwd, false);
      if (cancelled || interacted) return;
      if ('temporaryId' in saved && typeof saved.temporaryId === 'string') {
        const id = saved.temporaryId;
        const rows = await window.piApi.temporaryHistory();
        if (cancelled || interacted) return;
        if (rows?.some((row) => row.id === id)) f.temporary.open(id);
        else if (await window.piApi.readLayout?.('temporary:' + id, 'center')) {
          if (cancelled || interacted) return;
          f.temporary.resumeDraft(id);
        }
      }
      if (
        'teamRoute' in saved &&
        saved.teamRoute &&
        typeof saved.teamRoute === 'object' &&
        'view' in saved.teamRoute
      ) {
        const route = saved.teamRoute;
        if (route.view === 'members' || route.view === 'board') f.setTeamRoute({ view: route.view });
        else if (
          route.view === 'workspace' &&
          'cwd' in route &&
          typeof route.cwd === 'string' &&
          f.workspaces.some((row) => row.cwd === route.cwd)
        ) {
          const roomId = 'roomId' in route && typeof route.roomId === 'string' ? route.roomId : undefined;
          const room = f.workspaces
            .find((item) => item.cwd === route.cwd)
            ?.rooms?.find((item) => item.id === roomId);
          f.setTeamRoute({ view: 'workspace', cwd: route.cwd, roomId: room?.id });
        }
      }
      if (
        'section' in saved &&
        typeof saved.section === 'string' &&
        Object.hasOwn(sidebarSections, saved.section)
      )
        f.setSection(saved.section as SidebarSection);
    }
    void restore()
      .catch((cause) => {
        if (!cancelled) latest.current.foundation.setError(errorText(cause));
      })
      .finally(() => {
        if (!cancelled) setReady(true);
      });
    return () => {
      cancelled = true;
      window.removeEventListener('pointerdown', onInteraction, true);
      window.removeEventListener('keydown', onInteraction, true);
    };
  }, [canRestore]);
  const { section, workspace, session, teamRoute, temporary } = foundation;
  const sessionId = session?.id;
  const worktree = workspace ? worktreeLayoutOwner(workspace, foundation.workspaces.find(row => row.cwd === workspace)?.worktree) : undefined;
  useEffect(() => {
    if (ready)
      void window.piApi
        .writeLayout?.('studio', 'navigation', {
          section,
          cwd: workspace,
          sessionId, worktree,
          teamRoute,
          temporaryId: temporary.activeId,
        })
        .catch((cause) => latest.current.foundation.setError(errorText(cause)));
  }, [ready, section, workspace, sessionId, worktree, teamRoute, temporary.activeId]);
  return ready;
}
