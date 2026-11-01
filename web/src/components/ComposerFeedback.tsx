import { Info, TriangleAlert, X } from 'lucide-react';

/** Immediate, dismissible feedback anchored above a composer. */
export function ComposerFeedback({
  message,
  tone = 'warning',
  onDismiss,
}: {
  message: string;
  tone?: 'info' | 'warning';
  onDismiss: () => void;
}) {
  const Icon = tone === 'info' ? Info : TriangleAlert;
  return <div
    className={`composer-feedback ${tone === 'info' ? 'is-info' : ''}`}
    role={tone === 'info' ? 'status' : 'alert'}
    aria-live={tone === 'info' ? 'polite' : 'assertive'}
  >
    <Icon aria-hidden="true" />
    <span>{message}</span>
    <button type="button" className="composer-feedback-dismiss" aria-label="关闭输入提示" onClick={onDismiss}><X /></button>
  </div>;
}
