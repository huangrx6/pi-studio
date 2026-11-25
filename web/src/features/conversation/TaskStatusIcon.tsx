import type { ReactNode } from 'react';
import type { TaskStatus } from './todo-status';
import './styles/task-status-icon.css';

const sheet = <rect x="3" y="3" width="14" height="14" rx="3.5" />;
const marks: Record<TaskStatus, ReactNode> = {
  pending: <rect x="3" y="3" width="14" height="14" rx="3.5" strokeDasharray="3 3" />,
  active: <>{sheet}<path d="M10 3v14H6.5A3.5 3.5 0 0 1 3 13.5v-7A3.5 3.5 0 0 1 6.5 3Z" fill="currentColor" stroke="none" /></>,
  completed: <><path d="M10.5 3H6.5A3.5 3.5 0 0 0 3 6.5v7A3.5 3.5 0 0 0 6.5 17h7a3.5 3.5 0 0 0 3.5-3.5V10" />
    <path d="m7 9 3.2 3.2 7.3-8.1" /></>,
  blocked: <><rect x="3.5" y="8" width="13" height="9" rx="2.7" /><path d="M6.5 8V6a3.5 3.5 0 0 1 7 0v2M10 11.5v2" /></>,
  unfinished: <>{sheet}<path d="m7 13 6-6" /></>,
};

export function TaskStatusIcon({ status, label }: { status: TaskStatus; label?: string }) {
  return <span className="task-status-icon" data-status={status} role={label ? 'img' : undefined}
    aria-label={label} aria-hidden={label ? undefined : true} title={label}>
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"
      strokeLinejoin="round" aria-hidden="true">{marks[status]}</svg>
  </span>;
}
