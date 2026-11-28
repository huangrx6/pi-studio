import { createLucideIcon, Folders } from 'lucide-react';
import './styles/git-icons.css';

export const BranchIcon = createLucideIcon('Branch', [
  ['path', { d: 'M6 3.5v17M6 15c6 0 12-4 12-11.5', key: 'branch' }],
]);

const PrimaryWorktreeIcon = createLucideIcon('PrimaryWorktree', [
  ['circle', { cx: '12', cy: '12', r: '10', className: 'worktree-dot-halo', key: 'halo' }],
  ['circle', { cx: '12', cy: '12', r: '5.5', key: 'dot' }],
]);

export function worktreeIcon(primary: boolean) {
  return primary ? PrimaryWorktreeIcon : Folders;
}
