import type { ReactNode } from 'react';
import { ArrowLeft } from 'lucide-react';

export function SessionViewHeader({ title, summary, children, back, className = '' }: {
  title: string;
  summary?: ReactNode;
  children?: ReactNode;
  back?: { label: string; onClick: () => void };
  className?: string;
}) {
  return <header className={`session-view-head${back ? ' has-back' : ''} ${className}`}>
    <div><h2>{title}</h2>{summary && <p>{summary}</p>}</div>
    {children}
    {back && <button type="button" className="icon-button session-view-back" aria-label={back.label}
      title={back.label} onClick={back.onClick}><ArrowLeft aria-hidden="true" /></button>}
  </header>;
}
