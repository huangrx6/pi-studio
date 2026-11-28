import { Folder, FolderOpen, GitCommitHorizontal } from 'lucide-react';
import { BranchIcon, worktreeIcon } from '../features/git/git-icons';
import type { WorkspaceTree } from '../types/workspace';

export function SidebarWorkspaceLabel({ name, worktree, open }: {
  name: string;
  worktree?: WorkspaceTree;
  open: boolean;
}) {
  const Icon = worktree ? (worktree.detached ? GitCommitHorizontal : BranchIcon) : open ? FolderOpen : Folder;
  const TreeIcon = worktreeIcon(!!worktree?.main);
  return <>
    <Icon aria-hidden="true" />
    <span className="workspace-label worktree-ref-label">
      <span className={worktree ? 'workspace-name' : 'workspace-name project-name'}>{worktree ? worktree.branch || '分支未知' : name}</span>
      {worktree && <TreeIcon className="workspace-tree-icon" aria-hidden="true" />}
    </span>
  </>;
}
