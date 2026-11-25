import { useId, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import type { TodoTask } from '../../types/chat-types';
import { TaskStatusIcon } from './TaskStatusIcon';
import { taskStatusNames, type TaskStatus } from './todo-status';

export type TaskGroup = {
  key: string;
  title: string;
  meta?: string;
  uniformStatus?: TaskStatus;
  completed: number;
  entries: { planId: number; task: TodoTask; status: TaskStatus; source?: string }[];
};

export function TaskPager({ label, unit, range, previous, next, jump }: {
  label: string; unit: string; range: string; previous?: () => void; next?: () => void;
  jump?: { current: number; last: number; show: (page: number) => void };
}) {
  return <nav className="session-tasks-pager" aria-label={label}>
    <span aria-live="polite">{range}</span>
    <button type="button" className="icon-button" aria-label={'上一页' + unit} title={'上一页' + unit}
      disabled={!previous} onClick={previous}><ChevronLeft aria-hidden="true" /></button>
    {jump && jump.last >= 5 && <form className="session-tasks-page-number" onSubmit={event => {
      event.preventDefault();
      const input = event.currentTarget.elements.namedItem('page') as HTMLInputElement;
      if (input.validity.valid) jump.show(input.valueAsNumber - 1);
    }}>
      <input key={jump.current} type="number" name="page" min={1} max={jump.last + 1} required
        defaultValue={jump.current + 1} aria-label={'跳至' + unit + '页'} title={`输入页码（1–${jump.last + 1}），按回车跳转`}
        onFocus={event => event.currentTarget.select()} onBlur={event => { event.currentTarget.value = String(jump.current + 1); }} />
      <span>/ {jump.last + 1} 页</span>
    </form>}
    <button type="button" className="icon-button" aria-label={'下一页' + unit} title={'下一页' + unit}
      disabled={!next} onClick={next}><ChevronRight aria-hidden="true" /></button>
  </nav>;
}

const rowsPerPage = 8;

export function ConversationTaskGroup({ group, byStatus, initiallyOpen }: {
  group: TaskGroup; byStatus: boolean; initiallyOpen: boolean;
}) {
  const [open, setOpen] = useState(initiallyOpen);
  const [page, setPage] = useState(0);
  const id = useId();
  const heading = useRef<HTMLButtonElement>(null);
  const { entries, title, meta, uniformStatus, completed } = group;
  const total = entries.length;
  const lastPage = Math.ceil(total / rowsPerPage) - 1;
  const current = Math.min(page, lastPage);
  const start = current * rowsPerPage;
  const end = Math.min(start + rowsPerPage, total);
  let countLabel = `${total} 项`;
  if (uniformStatus && !byStatus) countLabel += taskStatusNames[uniformStatus];
  if (!uniformStatus && completed) countLabel = `${completed}/${total} 已完成`;

  function showPage(next: number) {
    setPage(next);
    heading.current?.focus({ preventScroll: true });
    heading.current?.scrollIntoView({ block: 'nearest' });
  }

  return <section className="session-tasks-group" aria-labelledby={id + '-title'}>
    <h3><button type="button" ref={heading} className="session-tasks-disclosure"
      aria-expanded={open} aria-controls={id} aria-labelledby={id + '-title'}
      aria-describedby={meta ? `${id}-meta ${id}-count` : id + '-count'}
      onClick={() => setOpen(value => !value)}>
      <ChevronRight aria-hidden="true" />
      <span className="session-tasks-heading"><span id={id + '-title'} title={title}>{title}</span>
        {meta && <small id={id + '-meta'}>{meta}</small>}</span>
      <span className="session-tasks-count" id={id + '-count'}>{countLabel}</span>
    </button></h3>
    <div id={id} hidden={!open}>
      {open && <>
        <ul>{entries.slice(start, end).map(({ planId, task, status, source }) => {
          const state = uniformStatus || status === 'completed' ? undefined : taskStatusNames[status];
          return <li key={planId + '/' + task.id} data-status={status}>
            <TaskStatusIcon status={status} label={state ? undefined : taskStatusNames[status]} />
            <div className="session-task-copy">
              <strong>{task.subject}</strong>
              {source && <small>{source}</small>}
              {task.closedReason && <small>{task.closedReason}</small>}
            </div>
            {(state || task.archivedAt) ? <span className="session-task-state">
              {[state, task.archivedAt ? '已归档' : ''].filter(Boolean).join(' · ')}
            </span> : null}
          </li>;
        })}</ul>
        {lastPage > 0 && <TaskPager label={title + '任务翻页'} unit="任务" range={`${start + 1}–${end} / ${total}`}
          previous={current > 0 ? () => showPage(current - 1) : undefined}
          next={current < lastPage ? () => showPage(current + 1) : undefined}
          jump={{ current, last: lastPage, show: showPage }} />}
      </>}
    </div>
  </section>;
}
