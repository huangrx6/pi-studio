import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Archive, Copy, GitFork, MoreHorizontal, Pencil, Pin, PinOff, SquarePen, Trash2, Undo2 } from 'lucide-react';
import { SettingsDialog } from './SettingsDialog';

export type SidebarAction = 'rename' | 'remove' | 'pin' | 'archive' | 'fork';
export function SidebarActions({ kind, id, name, pinned, archived, onAction, onNew }: {
  kind: 'workspace' | 'session'; id: string; name: string; pinned?: boolean; archived?: boolean;
  onAction: (action: SidebarAction, name?: string) => Promise<void>; onNew?: () => void;
}) {
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [confirming, setConfirming] = useState<'archive' | 'fork' | 'remove' | null>(null);
  const [value, setValue] = useState(name);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!position) return;
    menu.current?.querySelector<HTMLButtonElement>('button')?.focus();
    const outside = (event: PointerEvent) => { if (!menu.current?.contains(event.target as Node) && !trigger.current?.contains(event.target as Node)) setPosition(null); };
    const close = () => setPosition(null);
    document.addEventListener('pointerdown', outside);
    window.addEventListener('resize', close);
    window.addEventListener('scroll', close, true);
    return () => { document.removeEventListener('pointerdown', outside); window.removeEventListener('resize', close); window.removeEventListener('scroll', close, true); };
  }, [position]);
  async function run(action: SidebarAction, nextName?: string) {
    setBusy(true); setError(null); setPosition(null);
    try { await onAction(action, nextName); setRenaming(false); setConfirming(null); }
    catch (error) { setError(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  }
  const pinLabel = pinned ? '取消置顶' : '置顶会话';
  const archiveLabel = archived ? '恢复会话' : '归档会话';
  function confirm(action: 'archive' | 'fork' | 'remove') {
    setPosition(null); setError(null); setConfirming(action);
  }
  const confirmation = confirming === 'archive'
    ? { title: archived ? '恢复这个会话？' : '归档这个会话？', action: archived ? '恢复会话' : '归档会话', description: archived ? '会话将回到工作区的会话列表。' : '归档后会从当前列表隐藏，历史记录会保留，可在“查看归档会话”中恢复。' }
    : confirming === 'fork'
      ? { title: '分叉这个会话？', action: '创建分叉', description: '将复制当前历史记录，创建并打开一个独立的新会话。原会话保持不变。' }
      : { title: '删除这个工作区？', action: '从侧边栏移除', description: '仅从侧边栏移除，磁盘文件和会话记录都会保留。重新打开该文件夹可恢复显示。' };
  return <div className={`sidebar-row-actions ${position || confirming || renaming ? 'is-open' : ''}`}>
    <button ref={trigger} type="button" disabled={busy} aria-label={`${name}的更多操作`} title="更多" aria-haspopup="menu" aria-expanded={Boolean(position)} onClick={() => {
      const rect = trigger.current!.getBoundingClientRect();
      setPosition(position ? null : { left: Math.min(rect.left, window.innerWidth - 208), top: Math.max(8, Math.min(rect.bottom + 5, window.innerHeight - (kind === 'session' ? 205 : 90))) });
    }}><MoreHorizontal /></button>
    {kind === 'workspace' ? <button type="button" title="在此工作区新建对话" aria-label={`在${name}中新建对话`} onClick={onNew}><SquarePen /></button> : <>
      <button type="button" disabled={busy} title={archiveLabel} aria-label={`${archiveLabel}：${name}`} onClick={() => confirm('archive')}>{archived ? <Undo2 /> : <Archive />}</button>
      <button type="button" disabled={busy} className={pinned ? 'is-pinned' : ''} title={pinLabel} aria-label={`${pinLabel}：${name}`} onClick={() => void run('pin')}>{pinned ? <PinOff /> : <Pin />}</button>
    </>}
    {position && createPortal(<div ref={menu} className="sidebar-action-menu" role="menu" aria-label={`${name}的操作`} style={position} onKeyDown={event => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setPosition(null); trigger.current?.focus(); }
      if (event.key === 'Tab') setPosition(null);
      if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
        event.preventDefault(); const items = [...menu.current!.querySelectorAll<HTMLButtonElement>('button')];
        const index = items.indexOf(document.activeElement as HTMLButtonElement);
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
        items[next]?.focus();
      }
    }}>
      {kind === 'session' && <button role="menuitem" onClick={() => void run('pin')}><Pin />{pinLabel}</button>}
      <button role="menuitem" onClick={() => { setPosition(null); setValue(name); setError(null); setRenaming(true); }}><Pencil />{kind === 'workspace' ? '重命名工作区' : '重命名'}</button>
      {kind === 'workspace' ? <button role="menuitem" onClick={() => confirm('remove')}><Trash2 />删除工作区</button> : <>
        <button role="menuitem" onClick={() => confirm('fork')}><GitFork />分叉会话</button>
        <button role="menuitem" onClick={() => confirm('archive')}>{archived ? <Undo2 /> : <Archive />}{archiveLabel}</button>
        <button role="menuitem" onClick={() => { void navigator.clipboard.writeText(id).then(() => setPosition(null)).catch(() => setError('复制失败，请重试')); }}><Copy />复制 SessionId</button>
      </>}
    </div>, document.body)}
    {renaming && <SettingsDialog title={kind === 'workspace' ? '重命名工作区' : '重命名会话'} description={kind === 'workspace' ? '修改显示名称，磁盘文件夹名称保持不变。' : undefined} action="保存" busy={busy} loading={false} error={error} onClose={() => setRenaming(false)} onSubmit={() => void run('rename', value)}>
      <label className="sidebar-rename-field">名称<input required maxLength={80} value={value} onChange={event => setValue(event.target.value)} /></label>
    </SettingsDialog>}
    {confirming && createPortal(<SettingsDialog title={confirmation.title} description={confirmation.description} action={confirmation.action} busy={busy} loading={false} error={error} onClose={() => { setConfirming(null); setError(null); trigger.current?.focus(); }} onSubmit={() => void run(confirming)}>
      <p className="sidebar-confirm-name">{name}</p>
    </SettingsDialog>, document.body)}
    {error && !renaming && !confirming && createPortal(<div className="sidebar-action-error" role="alert">{error}<button onClick={() => setError(null)} aria-label="关闭错误提示">关闭</button></div>, document.body)}
  </div>;
}
