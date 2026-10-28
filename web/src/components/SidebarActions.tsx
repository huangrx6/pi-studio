/**
 * 侧边栏行内操作：会话/工作区的「更多」菜单，以及会话的归档、置顶快捷按钮。
 *
 * 交互流程：
 * 1. 点「更多」在触发按钮旁弹出 portal 菜单（固定定位、视口内夹取）；
 * 2. 重命名 → 打开 SettingsDialog 输入名称；
 * 3. 归档/分叉/删除工作区 → 先弹 SettingsDialog 二次确认；
 * 4. 确认后调用 onAction，由 App 发 `piApi.sidebarAction({ kind, id, action, name })`
 *    到主进程，成功后 App 会重新拉取侧边栏状态。
 *
 * 状态说明：position 控制菜单，renaming / confirming 控制两个弹窗，三者互斥；
 * busy 期间禁用按钮以免重复提交；error 在弹窗内展示，弹窗关闭后改用浮动错误条。
 */
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Archive, Copy, GitFork, MoreHorizontal, Pencil, Pin, PinOff, SquarePen, Trash2, Undo2 } from 'lucide-react';
import { SettingsDialog } from './SettingsDialog';

/** 侧边栏支持的操作类型，与主进程 pi:sidebar-action 的 action 参数一致。 */
export type SidebarAction = 'rename' | 'remove' | 'pin' | 'archive' | 'fork';

/**
 * 侧边栏行操作组件。
 *
 * @param kind 操作对象是工作区还是会话，决定菜单项与文案
 * @param id 工作区路径或会话 id，也是「复制 SessionId」复制的内容
 * @param name 展示名，用于 aria-label、确认弹窗与重命名初始值
 * @param pinned 会话是否已置顶（决定按钮图标与文案）
 * @param archived 会话是否已归档（决定归档/恢复）
 * @param onAction 实际执行动作；返回 Promise，失败信息会展示给用户
 * @param onNew 工作区行「新建对话」回调；仅工作区使用
 */
export function SidebarActions({ kind, id, name, pinned, archived, onAction, onNew }: {
  kind: 'workspace' | 'session'; id: string; name: string; pinned?: boolean; archived?: boolean;
  onAction: (action: SidebarAction, name?: string) => Promise<void>; onNew?: () => void;
}) {
  /** 菜单的 fixed 坐标；为 null 时菜单关闭。 */
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);
  /** 重命名弹窗是否打开。 */
  const [renaming, setRenaming] = useState(false);
  /** 二次确认弹窗要确认的动作；三种破坏性操作互斥。 */
  const [confirming, setConfirming] = useState<'archive' | 'fork' | 'remove' | null>(null);
  /** 重命名输入草稿；每次打开弹窗时用最新的 name 重置。 */
  const [value, setValue] = useState(name);
  /** 动作执行中：禁用所有入口，避免重复提交。 */
  const [busy, setBusy] = useState(false);
  /** 最近一次动作失败的信息；弹窗内展示，或退化为浮动错误条。 */
  const [error, setError] = useState<string | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);

  // 菜单打开后聚焦第一项，并监听点击外部 / 尺寸或滚动变化来关闭。
  // scroll 用捕获阶段，才能覆盖侧边栏等嵌套滚动容器；菜单是 fixed 定位，
  // 滚动后会脱离触发按钮，直接关闭比重新计算位置更稳。
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

  /**
   * 执行侧边栏动作。
   * 先关闭菜单并进入 busy；只有成功后才关闭重命名/确认弹窗，
   * 失败时保留弹窗，把错误交给 SettingsDialog 展示，方便用户修正重试。
   */
  async function run(action: SidebarAction, nextName?: string) {
    setBusy(true); setError(null); setPosition(null);
    try { await onAction(action, nextName); setRenaming(false); setConfirming(null); }
    catch (error) { setError(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  }
  const pinLabel = pinned ? '取消置顶' : '置顶会话';
  const archiveLabel = archived ? '恢复会话' : '归档会话';
  // 破坏性操作先收起菜单，再交给确认弹窗，避免两层浮层叠加。
  function confirm(action: 'archive' | 'fork' | 'remove') {
    setPosition(null); setError(null); setConfirming(action);
  }
  // 根据动作和当前归档状态生成确认文案：归档与恢复共用同一个入口。
  const confirmation = confirming === 'archive'
    ? { title: archived ? '恢复这个会话？' : '归档这个会话？', action: archived ? '恢复会话' : '归档会话', description: archived ? '会话将回到工作区的会话列表。' : '归档后会从当前列表隐藏，历史记录会保留，可在“查看归档会话”中恢复。' }
    : confirming === 'fork'
      ? { title: '分叉这个会话？', action: '创建分叉', description: '将复制当前历史记录，创建并打开一个独立的新会话。原会话保持不变。' }
      : { title: '删除这个工作区？', action: '从侧边栏移除', description: '仅从侧边栏移除，磁盘文件和会话记录都会保留。重新打开该文件夹可恢复显示。' };
  return <div className={`sidebar-row-actions ${position || confirming || renaming ? 'is-open' : ''}`}>
    <button ref={trigger} type="button" disabled={busy} aria-label={`${name}的更多操作`} title="更多" aria-haspopup="menu" aria-expanded={Boolean(position)} onClick={() => {
      const rect = trigger.current!.getBoundingClientRect();
      // 菜单宽 200px（CSS）+ 右侧 8px 余量；高度按菜单项数估算
      // （会话 5 项约 205px、工作区 2 项约 90px），据此把 top 夹在视口内。
      setPosition(position ? null : { left: Math.min(rect.left, window.innerWidth - 208), top: Math.max(8, Math.min(rect.bottom + 5, window.innerHeight - (kind === 'session' ? 205 : 90))) });
    }}><MoreHorizontal /></button>
    {/* 工作区只提供「新建对话」；会话额外提供归档与置顶的快捷入口。 */}
    {kind === 'workspace' ? <button type="button" title="在此工作区新建对话" aria-label={`在${name}中新建对话`} onClick={onNew}><SquarePen /></button> : <>
      <button type="button" disabled={busy} title={archiveLabel} aria-label={`${archiveLabel}：${name}`} onClick={() => confirm('archive')}>{archived ? <Undo2 /> : <Archive />}</button>
      <button type="button" disabled={busy} className={pinned ? 'is-pinned' : ''} title={pinLabel} aria-label={`${pinLabel}：${name}`} onClick={() => void run('pin')}>{pinned ? <PinOff /> : <Pin />}</button>
    </>}
    {/* 更多操作菜单：portal 到 body，避免被侧边栏的 overflow 裁剪；
        菜单容器统一处理键盘循环，Esc 关闭并把焦点还给触发按钮。 */}
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
    {/* 重命名复用设置弹框骨架：提交失败时错误显示在弹框内，不丢输入。 */}
    {renaming && <SettingsDialog title={kind === 'workspace' ? '重命名工作区' : '重命名会话'} description={kind === 'workspace' ? '修改显示名称，磁盘文件夹名称保持不变。' : undefined} action="保存" busy={busy} loading={false} error={error} onClose={() => setRenaming(false)} onSubmit={() => void run('rename', value)}>
      <label className="sidebar-rename-field">名称<input required maxLength={80} value={value} onChange={event => setValue(event.target.value)} /></label>
    </SettingsDialog>}
    {/* 二次确认：确认后才真正调用 onAction；关闭时把焦点还回触发按钮。 */}
    {confirming && createPortal(<SettingsDialog title={confirmation.title} description={confirmation.description} action={confirmation.action} busy={busy} loading={false} error={error} onClose={() => { setConfirming(null); setError(null); trigger.current?.focus(); }} onSubmit={() => void run(confirming)}>
      <p className="sidebar-confirm-name">{name}</p>
    </SettingsDialog>, document.body)}
    {/* 两个弹窗都关闭时，动作错误退化为浮动提示，避免失败信息被悄悄丢掉。 */}
    {error && !renaming && !confirming && createPortal(<div className="sidebar-action-error" role="alert">{error}<button onClick={() => setError(null)} aria-label="关闭错误提示">关闭</button></div>, document.body)}
  </div>;
}
