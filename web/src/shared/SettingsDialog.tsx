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
import { X } from 'lucide-react';
import { LoadingIndicator, LoadingState } from './LoadingState';
import { InfoHint } from './InfoHint';
import { useModalDialog, type ModalDismiss } from './useModalDialog';
import './styles/settings-dialog.css';
import './styles/settings-form.css';

/**
 * @param title 弹框标题（同时作为 aria-labelledby）
 * @param hint 标题旁的按需说明；用于格式、范围和持久化等非破坏性背景信息
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
export function SettingsDialog({
  className = '',
  wide = false,
  title,
  hint,
  description,
  action,
  closeLabel = '取消',
  busyAction = '正在保存…',
  busy,
  loading,
  unavailable,
  error,
  onClose,
  onRequestClose,
  onSubmit,
  children,
  autoFocusFirstField = true,
  scrollResetKey,
  footerHint,
  fieldsDisabled = false,
}: {
  className?: string;
  wide?: boolean;
  title: string;
  hint?: string;
  description?: string;
  action: string;
  closeLabel?: string;
  busyAction?: string;
  busy: boolean;
  loading: boolean;
  unavailable?: boolean;
  error: string | null;
  onClose: () => void;
  onRequestClose?: (dismiss: ModalDismiss) => void;
  onSubmit: (dismiss: ModalDismiss) => void;
  children: ReactNode;
  autoFocusFirstField?: boolean;
  scrollResetKey?: unknown;
  footerHint?: ReactNode | ((dismiss: ModalDismiss) => ReactNode);
  /** A committed write may need only a projection retry; its inputs are read-only. */
  fieldsDisabled?: boolean;
}) {
  const { dialogRef, onKeyDown, dismiss } = useModalDialog();
  const bodyRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const descriptionId = useId();

  useEffect(() => {
    const dialog = dialogRef.current;
    const body = bodyRef.current;
    const fields = body?.querySelector('fieldset');
    if (wide || loading || !dialog || !body || !fields) return;

    // A wider layout can remove its own overflow. Keep that width for this step
    // so editing a field never makes the dialog switch back and forth.
    const widenIfNeeded = () => {
      if (body.scrollHeight <= body.clientHeight + 1) return;
      observer.disconnect();
      dialog.dataset.formLayout = 'wide';
    };
    const observer = new ResizeObserver(widenIfNeeded);
    observer.observe(body);
    observer.observe(fields);
    widenIfNeeded();
    return () => {
      observer.disconnect();
      delete dialog.dataset.formLayout;
    };
  }, [dialogRef, loading, scrollResetKey, wide]);

  // 配置读取完成后回到内容顶部，并按需聚焦第一个可编辑字段。预览类弹框
  // 可以关闭自动聚焦，避免唯一输入控件是末尾的同意复选框时把正文滚到底部。
  useEffect(() => {
    if (loading) return;
    const frame = requestAnimationFrame(() => {
      const body = bodyRef.current;
      if (!body) return;
      body.scrollTop = 0;
      if (!autoFocusFirstField) return;
      // A disclosure may keep its fields mounted while closed. Start at an
      // editable control in the visible step, including custom select buttons.
      const fields = body.querySelectorAll<HTMLElement>('input:not([type="hidden"]), textarea, select, .pi-select-trigger, .pi-date-trigger');
      const field = [...fields].find(item => !item.matches(':disabled, [readonly]') && item.tabIndex >= 0 &&
        !item.closest('details:not([open])') && item.checkVisibility({ checkVisibilityCSS: true }) &&
        item.getBoundingClientRect().bottom <= body.getBoundingClientRect().bottom);
      // Keep explicit focus set by a field as the step loads.
      if (body.contains(document.activeElement) && document.activeElement?.checkVisibility({ checkVisibilityCSS: true })) return;
      field?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [autoFocusFirstField, loading, scrollResetKey]);

  function requestClose() {
    if (busy || dialogRef.current?.hasAttribute('data-modal-closing')) return;
    if (onRequestClose) onRequestClose(dismiss);
    else void dismiss(onClose);
  }

  return <dialog ref={dialogRef} className={`settings-dialog native-dialog-motion ${className}`.trim()} data-size={wide ? 'wide' : undefined} aria-labelledby={titleId} aria-describedby={description ? descriptionId : undefined}
    // 阻止 Esc 冒泡到全局快捷键，并在统一组件内维持完整的焦点闭环。
    onKeyDown={onKeyDown}
    onCancel={(event) => { event.preventDefault(); requestClose(); }}
    // 原生 dialog 点击遮罩时 target 是 dialog 本身；再判断坐标是否落在内容矩形外，
    // 防止点在 dialog 的内边距上也被当作“点击外部”。
    onClick={(event) => {
      if (event.target !== event.currentTarget || busy) return;
      const bounds = event.currentTarget.getBoundingClientRect();
      if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) requestClose();
    }}>
    <form onSubmit={(event) => { event.preventDefault(); if (!busy && !loading && !unavailable && !dialogRef.current?.hasAttribute('data-modal-closing')) onSubmit(dismiss); }}>
      <header className="dialog-header">
        <div>
          <div className="dialog-title-row">
            <h2 id={titleId}>{title}</h2>
            {hint && <InfoHint label={hint} />}
          </div>
          {description && <p id={descriptionId}>{description}</p>}
        </div>
        <button className="icon-button" type="button" disabled={busy} aria-label="关闭弹框" onClick={requestClose}><X /></button>
      </header>
      <div className="dialog-body" ref={bodyRef}>
        {/* loading 时不渲染 children：部分字段可能依赖异步配置，提前挂载会闪空值。 */}
        {loading ? <LoadingState variant="section">正在读取配置…</LoadingState> : <fieldset disabled={busy || fieldsDisabled}>{children}</fieldset>}
      </div>
      {error && <div className="dialog-error" role="alert">{error}</div>}
      <footer className="dialog-footer">
        {footerHint && (typeof footerHint === 'function'
          ? <div className="dialog-footer-hint">{footerHint(dismiss)}</div>
          : <div className="dialog-footer-hint" role="status" aria-live="polite">{footerHint}</div>)}
        <button type="button" className="settings-outline" disabled={busy} onClick={requestClose}>{closeLabel}</button>
        <button type="submit" className="settings-save" disabled={busy || loading || unavailable}>{busy && <LoadingIndicator />}{busy ? busyAction : action}</button>
      </footer>
    </form>
  </dialog>;
}
