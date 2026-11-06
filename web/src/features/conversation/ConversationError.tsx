import { X } from 'lucide-react';
import { errorText } from '../../shared/error-text';
import { conversationErrorPresentation } from './error-presentation';
import './conversation-error.css';

/** Show the actual reason once; expansion never resubmits a task. */
export function ConversationError({
  message,
  onDismiss,
  onAction,
  actionLabel,
  actionBusy = false,
  className = '',
  announce = true,
}: {
  message: string;
  onDismiss?: () => void;
  onAction?: () => void;
  actionLabel?: string;
  actionBusy?: boolean;
  announce?: boolean;
  className?: string;
}) {
  const { summary, details } = conversationErrorPresentation(errorText(message));
  return <div className={`error-card conversation-error ${onDismiss ? 'has-dismiss' : ''} ${className}`.trim()} role={announce ? 'alert' : undefined}>
    <p>{summary}</p>
    {details && <details key={message} className="conversation-error-details">
      <summary>查看详情</summary>
      <pre>{details}</pre>
    </details>}
    {onAction && actionLabel && <button
      type="button"
      className="conversation-error-action"
      disabled={actionBusy}
      aria-busy={actionBusy || undefined}
      onClick={onAction}
    >{actionBusy ? '正在连接…' : actionLabel}</button>}
    {onDismiss && <button type="button" className="error-card-close" aria-label="关闭错误提示" title="关闭" onClick={onDismiss}><X /></button>}
  </div>;
}
