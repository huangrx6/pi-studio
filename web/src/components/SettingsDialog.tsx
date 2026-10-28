/**
 * 设置类弹框的通用骨架：原生 <dialog> + showModal()。
 *
 * 统一提供：标题/说明、loading 占位、错误条、取消/提交按钮、保存中禁用整个
 * 表单（fieldset disabled），以及关闭时的焦点归还。所有设置表单和
 * SidebarActions 的重命名/确认弹窗都复用它。
 *
 * 与主进程的关系：本组件只负责弹框交互与提交时机；实际的 IPC 调用（保存设置、
 * 重命名、删除等）由父组件在 onSubmit / onClose 里执行，错误通过 error 回传。
 */
import { useEffect, useId, useRef, type ReactNode } from 'react';
import { LoaderCircle, X } from 'lucide-react';

/**
 * @param title 弹框标题（同时作为 aria-labelledby）
 * @param description 可选说明，作为 aria-describedby
 * @param action 主按钮文案（提交中会替换成「正在保存…」）
 * @param busy 提交中：禁用关闭与所有字段，防止重复提交
 * @param loading 正在拉取配置：用 loading 占位替代表单内容
 * @param unavailable 可选；为 true 时禁用提交（如配置未就绪）
 * @param error 错误信息；非空时在底部显示 role="alert"
 * @param onClose 关闭回调；Esc、遮罩点击、取消按钮都会走这里
 * @param onSubmit 表单提交回调；已做 busy/loading/unavailable 守卫
 * @param children 表单字段
 */
export function SettingsDialog({ title, description, action, busy, loading, unavailable, error, onClose, onSubmit, children }: {
  title: string;
  description?: string;
  action: string;
  busy: boolean;
  loading: boolean;
  unavailable?: boolean;
  error: string | null;
  onClose: () => void;
  onSubmit: () => void;
  children: ReactNode;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const descriptionId = useId();

  // 原生 showModal() 自带顶层渲染、焦点陷阱与惰性背景；
  // 记录打开前的焦点，卸载时归还给触发按钮，避免焦点丢到 body。
  useEffect(() => {
    const dialog = dialogRef.current!;
    const previous = document.activeElement as HTMLElement | null;
    dialog.showModal();
    return () => { dialog.close(); previous?.focus(); };
  }, []);

  // 配置读取完成后自动聚焦第一个可编辑字段；等一帧让 fieldset 真正挂载。
  useEffect(() => {
    if (loading) return;
    const frame = requestAnimationFrame(() => {
      dialogRef.current?.querySelector<HTMLElement>('input:not(:disabled), select:not(:disabled), textarea:not(:disabled)')?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [loading]);

  return <dialog ref={dialogRef} className="settings-dialog" aria-labelledby={titleId} aria-describedby={description ? descriptionId : undefined}
    // 阻止 Esc 冒泡到全局快捷键；真正的关闭逻辑交给 onCancel（保存中不允许关闭）。
    onKeyDown={(event) => { if (event.key === 'Escape') event.stopPropagation(); }}
    onCancel={(event) => { event.preventDefault(); if (!busy) onClose(); }}
    // 原生 dialog 点击遮罩时 target 是 dialog 本身；再判断坐标是否落在内容矩形外，
    // 防止点在 dialog 的内边距上也被当作“点击外部”。
    onClick={(event) => {
      if (event.target !== event.currentTarget || busy) return;
      const bounds = event.currentTarget.getBoundingClientRect();
      if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) onClose();
    }}>
    <form onSubmit={(event) => { event.preventDefault(); if (!busy && !loading && !unavailable) onSubmit(); }}>
      <header className="dialog-header"><div><h2 id={titleId}>{title}</h2>{description && <p id={descriptionId}>{description}</p>}</div><button className="icon-button" type="button" disabled={busy} aria-label="关闭弹框" onClick={onClose}><X /></button></header>
      <div className="dialog-body">
        {/* loading 时不渲染 children：部分字段可能依赖异步配置，提前挂载会闪空值。 */}
        {loading ? <div className="dialog-loading" role="status"><LoaderCircle className="spin" />正在读取配置…</div> : <fieldset disabled={busy}>{children}</fieldset>}
      </div>
      {error && <div className="dialog-error" role="alert">{error}</div>}
      <footer className="dialog-footer"><button type="button" className="settings-outline" disabled={busy} onClick={onClose}>取消</button><button type="submit" className="settings-save" disabled={busy || loading || unavailable}>{busy && <LoaderCircle className="spin" />}{busy ? '正在保存…' : action}</button></footer>
    </form>
  </dialog>;
}
