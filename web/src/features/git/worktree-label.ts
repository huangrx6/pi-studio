import type { GitWorktree } from '../../types/git-types';

export function worktreeName(path: string, mainPath?: string) {
  return path === mainPath ? '主工作树' : path.split(/[\\/]/).filter(Boolean).at(-1) || path;
}

export function worktreeHint(path: string, main: boolean, name = worktreeName(path)) {
  return (main ? '主工作树' : '链接工作树') + ' · ' + name + '\n' + path;
}

export function worktreeRef(tree: GitWorktree) {
  if (tree.branch) return tree.branch;
  return tree.detached ? '游离 HEAD' + (tree.head ? ' · ' + tree.head.slice(0, 8) : '') : '';
}

export function worktreeAvailability(tree: GitWorktree) {
  switch (tree.unavailable) {
    case 'prunable': return '登记失效';
    case 'inaccessible': return '目录不可用';
    case 'bare': return '裸仓库';
    default: return tree.locked ? '已锁定' : '';
  }
}
