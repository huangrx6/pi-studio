import { TriangleAlert, X } from 'lucide-react';

/** Immediate, dismissible feedback anchored above a composer. */
export function ComposerFeedback({ message, onDismiss }: { message: string; onDismiss: () => void }) {
  return <div className="composer-feedback" role="alert" aria-live="assertive">
    <TriangleAlert aria-hidden="true" />
    <span>{message}</span>
    <button type="button" className="composer-feedback-dismiss" aria-label="关闭输入提示" onClick={onDismiss}><X /></button>
  </div>;
}
