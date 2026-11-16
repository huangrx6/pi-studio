import { ArrowLeft } from 'lucide-react';
import type { ReactNode } from 'react';

export function SessionViewHeader({ title, summary, onBack, children, className = '' }: {
  title: string;
  summary?: ReactNode;
  onBack: () => void;
  children?: ReactNode;
  className?: string;
}) {
  return <header className={`session-view-head ${className}`}>
    <button className="session-view-back" type="button" onClick={onBack}><ArrowLeft />返回对话</button>
    <div className="session-view-heading">
      <div><h2>{title}</h2>{summary && <p>{summary}</p>}</div>
      {children}
    </div>
  </header>;
}
