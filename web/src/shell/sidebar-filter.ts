export type SidebarSessionFilter = 'all' | 'running' | 'pinned';

type WorkspaceSearchShape = {
  name: string;
  cwd: string;
  sessions: { title: string; archived?: boolean; running?: boolean; pinned?: boolean }[];
};

/** Keep source ordering and metadata; filter projections without mutating state. */
export function filterSidebarWorkspaces<T extends WorkspaceSearchShape>(workspaces: T[], query: string, filter: SidebarSessionFilter): T[] {
  const needle = query.trim().toLocaleLowerCase();
  return workspaces.flatMap(workspace => {
    const workspaceMatches = `${workspace.name} ${workspace.cwd}`.toLocaleLowerCase().includes(needle);
    const sessions = workspace.sessions.filter(session => !session.archived
      && (filter === 'all' || (filter === 'running' ? session.running : session.pinned))
      && (!needle || workspaceMatches || session.title.toLocaleLowerCase().includes(needle)));
    if (!sessions.length && (filter !== 'all' || (needle && !workspaceMatches))) return [];
    return [{ ...workspace, sessions }];
  });
}
