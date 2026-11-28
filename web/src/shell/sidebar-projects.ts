import type { WorkspaceTree } from '../types/workspace';
import { worktreeHint } from '../features/git/worktree-label.ts';

type TreeWorkspace = { cwd: string; name: string; worktree?: WorkspaceTree; missing?: boolean };

export type SidebarProject<T extends TreeWorkspace> = {
  key: string;
  name: string;
  nested: boolean;
  workspaces: T[];
};

export function sidebarProjectKey(root: string) {
  return 'project:' + root;
}

function folderName(path: string) {
  return path.split(/[\\/]/).filter(Boolean).at(-1);
}

export function groupSidebarProjects<T extends TreeWorkspace>(items: T[], visibleItems?: T[]): SidebarProject<T>[] {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const root = item.worktree?.projectRoot;
    const key = root ? sidebarProjectKey(root) : item.cwd;
    const members = groups.get(key);
    if (!members) groups.set(key, [item]);
    else if (item.worktree?.main) members.unshift(item);
    else members.push(item);
  }

  // Establish the heading and depth before search hides any sibling checkouts.
  const visibleByCwd = visibleItems && new Map(visibleItems.map(item => [item.cwd, item]));
  const projects: SidebarProject<T>[] = [];
  for (const [key, members] of groups) {
    const first = members[0];
    const tree = first.worktree;
    const nested = Boolean(tree);
    const name = tree && !tree.main ? folderName(tree.projectRoot) || tree.projectRoot : first.name;
    const workspaces = visibleByCwd ? members.flatMap(item => visibleByCwd.get(item.cwd) ?? []) : members;
    if (workspaces.length) projects.push({ key, name, nested, workspaces });
  }
  return projects;
}

export function workspaceRowTitle({ cwd, name, worktree }: TreeWorkspace) {
  if (!worktree) return [name, cwd].join('\n');
  const ref = worktree.detached ? '游离提交' : '当前分支';
  return [worktreeHint(cwd, worktree.main, name), worktree.branch && ref + ' · ' + worktree.branch].filter(Boolean).join('\n');
}
