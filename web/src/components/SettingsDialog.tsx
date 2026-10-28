import { useEffect, useId, useRef, type ReactNode } from 'react';
import { LoaderCircle, X } from 'lucide-react';

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
  useEffect(() => {
    const dialog = dialogRef.current!;
    const previous = document.activeElement as HTMLElement | null;
    dialog.showModal();
    return () => { dialog.close(); previous?.focus(); };
  }, []);
  useEffect(() => {
    if (loading) return;
    const frame = requestAnimationFrame(() => {
      dialogRef.current?.querySelector<HTMLElement>('input:not(:disabled), select:not(:disabled), textarea:not(:disabled)')?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [loading]);

  return <dialog ref={dialogRef} className="settings-dialog" aria-labelledby={titleId} aria-describedby={description ? descriptionId : undefined}
    onKeyDown={(event) => { if (event.key === 'Escape') event.stopPropagation(); }}
    onCancel={(event) => { event.preventDefault(); if (!busy) onClose(); }}
    onClick={(event) => {
      if (event.target !== event.currentTarget || busy) return;
      const bounds = event.currentTarget.getBoundingClientRect();
      if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) onClose();
    }}>
    <form onSubmit={(event) => { event.preventDefault(); if (!busy && !loading && !unavailable) onSubmit(); }}>
      <header className="dialog-header"><div><h2 id={titleId}>{title}</h2>{description && <p id={descriptionId}>{description}</p>}</div><button className="icon-button" type="button" disabled={busy} aria-label="关闭弹框" onClick={onClose}><X /></button></header>
      <div className="dialog-body">
        {loading ? <div className="dialog-loading" role="status"><LoaderCircle className="spin" />正在读取配置…</div> : <fieldset disabled={busy}>{children}</fieldset>}
      </div>
      {error && <div className="dialog-error" role="alert">{error}</div>}
      <footer className="dialog-footer"><button type="button" className="settings-outline" disabled={busy} onClick={onClose}>取消</button><button type="submit" className="settings-save" disabled={busy || loading || unavailable}>{busy && <LoaderCircle className="spin" />}{busy ? '正在保存…' : action}</button></footer>
    </form>
  </dialog>;
}
