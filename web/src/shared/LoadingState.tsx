import { LoaderCircle } from 'lucide-react';

/** Buttons provide their own accessible name. Only standalone waits announce a status. */
export function LoadingIndicator({ className = '' }: { className?: string }) {
  return <LoaderCircle className={`loading-indicator spin ${className}`.trim()} aria-hidden="true" />;
}

type LoadingStateProps = {
  children: string;
  /** Inline in a row, section inside existing content, panel in an empty pane. */
  variant?: 'inline' | 'section' | 'panel';
  className?: string;
};

export function LoadingState({ children, variant = 'inline', className = '' }: LoadingStateProps) {
  return <span className={`loading-state loading-state--${variant} ${className}`.trim()} role="status">
    {variant === 'inline' ? <LoadingIndicator /> : <span className="loading-pi" aria-hidden="true"><span className="pi-mark" /></span>}
    <span className="loading-state-label">{children}</span>
  </span>;
}
