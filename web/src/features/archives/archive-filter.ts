import type { ConversationSummary } from '../../types/durable-types';

export type ArchivedWorkspace = { cwd: string; name: string; sessions: ConversationSummary[] };
const normalize = (value: string) => value.normalize('NFKC').toLocaleLowerCase().trim();

/** Search only archived projections, retaining original workspace/session order and identity. */
export function filterArchivedWorkspaces<T extends ArchivedWorkspace>(workspaces: T[], query: string): T[] {
  const terms = normalize(query).split(/\s+/).filter(Boolean);
  return workspaces.flatMap(workspace => {
    const sessions = workspace.sessions.filter(session => session.archived && terms.every(term =>
      normalize(`${session.title || '未命名会话'} ${session.cwd} ${workspace.name} ${workspace.cwd}`).includes(term)));
    return sessions.length ? [{ ...workspace, sessions }] : [];
  });
}
