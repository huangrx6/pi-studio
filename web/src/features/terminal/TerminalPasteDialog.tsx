import { useRef } from 'react';
import { ClipboardPaste, CornerDownLeft } from 'lucide-react';
import { ConfirmShell } from '../../shared/ConfirmDialog';

export function TerminalPasteDialog({ text, onConfirm, onCancel }: {
  text: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const confirmRef = useRef<HTMLButtonElement>(null);
  const lines = text.split(/\r\n?|\n/u);
  const trailingNewline = lines.at(-1) === '';
  const lineCount = lines.length - (trailingNewline ? 1 : 0);

  return <ConfirmShell label="粘贴预览" initialFocusRef={confirmRef} onCancel={onCancel}>
    {dismiss => <>
      <header className="confirm-head">
        <span className="confirm-icon is-command"><ClipboardPaste aria-hidden="true" /></span>
        <div className="confirm-heading"><h2>粘贴预览</h2></div>
        <span className="terminal-paste-meta">{lineCount} 行{trailingNewline && ' · 末尾有换行'}</span>
      </header>
      <pre className="confirm-command terminal-paste-preview" tabIndex={0}>{text}</pre>
      <footer className="confirm-actions">
        <button type="button" className="confirm-cancel" onClick={() => void dismiss(onCancel)}>取消</button>
        <button type="button" className="confirm-accept terminal-paste-accept" ref={confirmRef} onClick={onConfirm}>
          粘贴到终端<CornerDownLeft aria-hidden="true" />
        </button>
      </footer>
    </>}
  </ConfirmShell>;
}
