import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { Check, ChevronDown, Cloud, FilePenLine, GitBranch, Plus, Search } from 'lucide-react';
import { PopoverSurface } from '../../shared/PopoverSurface';
import { isComposingKey, menuFocusIndex } from '../../shared/keyboard-navigation';
import type { GitAction, GitWorkspaceStatus } from '../../types/git-types';
import { useGitAction, useGitRead, useGitRevision } from './useGitTools';
import { useGitRepositories } from './useWorkspaceRepositories';
import './styles/git-branch.css';

type BranchPickerProps = { status: GitWorkspaceStatus | null; sessionId?: string };
export function GitBranchPicker(props: BranchPickerProps) {
  const { selected } = useGitRepositories();
  return selected ? <BranchMenu key={selected.id} {...props} /> : null;
}

function BranchMenu({ status, sessionId }: BranchPickerProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const anchor = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const menuId = useId();
  const revision = useGitRevision();
  const { data, error, loading } = useGitRead(open ? sessionId : undefined, 'branches', {}, revision);
  const mutation = useGitAction(sessionId || '');
  const [notice, setNotice] = useState('');
  useLayoutEffect(() => {
    if (!open) return;
    const align = () => {
      if (menu.current && anchor.current) {
        const left = anchor.current.getBoundingClientRect().left;
        menu.current.style.left = Math.min(0, innerWidth - 8 - left - menu.current.offsetWidth) + 'px';
      }
    };
    align();
    window.addEventListener('resize', align);
    return () => window.removeEventListener('resize', align);
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const outside = (e: Event) => { if (!anchor.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('focusin', outside);
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('focusin', outside); };
  }, [open]);
  if (!status?.available || !sessionId) return null;
  const branch = status.branch || status.commit;
  if (!branch) return null;
  const filter = query.trim();
  const matches = data?.branches.filter(b => b.name.toLowerCase().includes(filter.toLowerCase())) || [];
  async function choose(action: GitAction) {
    if (data && await mutation.act(data, action)) { setOpen(false); trigger.current?.focus(); }
    else setNotice('error');
  }
  return <div className="git-branch-picker" ref={anchor} onKeyDown={e => {
    if (!open || isComposingKey(e.nativeEvent)) return;
    if (e.key === 'Escape') { e.stopPropagation(); setOpen(false); trigger.current?.focus(); return; }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      const buttons = Array.from(menu.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') || []);
      const index = menuFocusIndex(e.key, buttons.indexOf(document.activeElement as HTMLButtonElement), buttons.length, true);
      if (index !== null) { e.preventDefault(); buttons[index].focus(); }
    }
  }}>
    <button type="button" ref={trigger} className="git-workspace-summary git-branch-trigger" aria-label={'切换分支，当前 ' + branch}
      aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? menuId : undefined} title={branch}
      onClick={() => { setQuery(''); setNotice(''); setOpen(!open); }}>
      <GitBranch aria-hidden="true" /><span>{branch}</span><ChevronDown aria-hidden="true" />
    </button>
    {open && <PopoverSurface ref={menu} id={menuId} className="git-branch-menu" role="dialog" aria-label="切换分支">
      <label className="git-branch-search"><Search aria-hidden="true" /><input autoFocus placeholder="搜索或创建分支" aria-label="搜索或创建分支"
        value={query} onChange={e => setQuery(e.target.value)} /></label>
      <div className="git-branch-options">
        {(['本地分支', '远程分支'] as const).map((label, group) => {
          const items = matches.filter(b => b.remote === Boolean(group));
          if (!items.length) return null;
          if (group === 0) items.sort((a, b) => Number(b.name === data?.branch) - Number(a.name === data?.branch));
          const Icon = group === 0 ? GitBranch : Cloud;
          return <section key={label}><h3>{label}</h3>{items.map(b => {
            const current = !b.remote && b.name === data?.branch;
            const occupied = !!b.worktree && !current;
            return <button type="button" key={b.name} aria-current={current || undefined} disabled={mutation.busy || loading || current || occupied} title={occupied ? b.worktree : b.name}
              onClick={() => void choose({ kind: 'switch', name: b.name, remoteBranch: b.remote })}>
              <Icon aria-hidden="true" /><span>{b.name}</span>{current ? <Check aria-hidden="true" /> : occupied && <small>其他工作树</small>}
            </button>;
          })}</section>;
        })}
        {!matches.length && <p className="git-branch-empty" role={error ? 'alert' : 'status'}>{error || (loading ? '正在读取分支…' : '没有匹配的分支')}</p>}
      </div>
      {filter && !data?.branches.some(b => !b.remote && b.name === filter) && <button type="button" className="git-branch-create"
        disabled={!data || mutation.busy || loading} onClick={() => void choose({ kind: 'create', name: filter })}><Plus aria-hidden="true" /><span>创建并切换到 <b>{filter}</b></span></button>}
      {!!status.dirty.total && <p className="git-branch-dirty"><FilePenLine aria-hidden="true" />有未提交的修改，发生覆盖时会停止切换。</p>}
      {notice && mutation.error && <p role="alert">{mutation.error}</p>}
    </PopoverSurface>}
  </div>;
}
