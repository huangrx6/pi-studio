import type { ConversationSummary } from '../../types/durable-types';

export type ArchivedWorkspace = { cwd: string; name: string; sessions: ConversationSummary[] };
const normalize = (value: string) => value.normalize('NFKC').toLocaleLowerCase().trim();

export type PinFilter = 'all' | 'pinned' | 'unpinned';
export function workspaceLabel(workspace: ArchivedWorkspace) {
  return workspace.name || workspace.cwd.split(/[\\/]/).filter(Boolean).at(-1) || '未指定工作区';
}

/** Search only archived projections, retaining original workspace/session order and identity. */
export function filterArchivedWorkspaces<T extends ArchivedWorkspace>(workspaces: T[], query: string, pins: PinFilter = 'all', cwd?: string): T[] {
  const terms = normalize(query).split(/\s+/).filter(Boolean);
  return workspaces.flatMap(workspace => {
    if (cwd !== undefined && workspace.cwd !== cwd) return [];
    const sessions = workspace.sessions.filter(session => session.archived
      && (pins === 'all' || Boolean(session.pinned) === (pins === 'pinned'))
      && terms.every(term =>
        normalize(`${session.title || '未命名会话'} ${session.cwd} ${workspace.name} ${workspace.cwd}`).includes(term)));
    return sessions.length ? [{ ...workspace, sessions }] : [];
  });
}
