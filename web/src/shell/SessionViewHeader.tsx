import type { ReactNode } from 'react';

export function SessionViewHeader({ title, summary, children, className = '' }: {
  title: string;
  summary?: ReactNode;
  children?: ReactNode;
  className?: string;
}) {
  return <header className={`session-view-head ${className}`}>
    <div><h2>{title}</h2>{summary && <p>{summary}</p>}</div>
    {children}
  </header>;
}
