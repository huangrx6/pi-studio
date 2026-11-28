import { X } from 'lucide-react';
import { WorktreeSettings } from './WorktreeSettings';
import './styles/git-settings.css';
import { DetailDialog } from '../../shared/DetailDialog';
import { LoadingState } from '../../shared/LoadingState';
import { useGitWorkspaceStatus } from '../../shell/useGitWorkspaceStatus';

export default function WorktreesDialog({ cwd, repository = '.', activeCwd, title, onOpen, onClose }: {
  cwd: string; repository?: string; activeCwd: string; title: string; onOpen: (cwd: string) => void | Promise<void>; onClose: () => void;
}) {
  const { status, refresh } = useGitWorkspaceStatus(cwd, repository);
  return <DetailDialog label="管理工作树" onClose={onClose} className="git-worktrees-dialog">
    {close => <>
      <header><h2>{title}</h2><button className="icon-button" aria-label="关闭" onClick={close}><X /></button></header>
      <div className="detail-body git-settings">{!status ? <LoadingState>正在读取工作树…</LoadingState>
        : status.available ? <WorktreeSettings cwd={cwd} repository={repository} activeCwd={activeCwd} status={status} onOpen={async path => onOpen(path)} />
        : <div role="alert">无法读取工作树。<button onClick={() => void refresh()}>重试</button></div>}</div>
    </>}
  </DetailDialog>;
}
