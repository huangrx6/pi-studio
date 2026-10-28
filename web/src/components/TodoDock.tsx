import { useMemo } from 'react';
import { Archive, Check, ChevronDown, ChevronUp, Circle, CircleDot, ListTodo, Lock, Minus } from 'lucide-react';
import type { TodoDetails, TodoTask } from '../chat-types';

type TodoDockProps = {
  details?: TodoDetails;
  open: boolean;
  onToggle: () => void;
};

type Group = { key: string; label: string; tasks: TodoTask[]; icon: React.ReactNode };

function taskIsBlocked(task: TodoTask, tasks: TodoTask[]): boolean {
  return (task.blockedBy || []).some((id) => {
    const blocker = tasks.find((candidate) => candidate.id === id);
    return Boolean(blocker && !blocker.archivedAt && blocker.status !== 'completed' && !blocker.closedAt);
  });
}

function TaskRow({ task, blocked }: { task: TodoTask; blocked: boolean }) {
  const complete = task.status === 'completed';
  const closed = Boolean(task.closedAt);
  const active = task.status === 'in_progress';
  return <div className={`todo-row ${active ? 'is-active' : ''} ${complete ? 'is-complete' : ''} ${closed ? 'is-closed' : ''} ${blocked ? 'is-blocked' : ''}`}>
    <span className="todo-row-icon">
      {complete ? <Check /> : closed ? <Minus /> : blocked ? <Lock /> : active ? <CircleDot /> : <Circle />}
    </span>
    <span className="todo-row-id">#{task.id}</span>
    <span className="todo-row-subject" title={task.description || task.subject}>{active ? (task.activeForm || task.subject) : task.subject}</span>
    {blocked && !complete && !closed && <span className="todo-row-note">被依赖阻塞</span>}
    {closed && !complete && <span className="todo-row-note">已结束</span>}
  </div>;
}

export function TodoDock({ details, open, onToggle }: TodoDockProps) {
  const model = useMemo(() => {
    const all = Array.isArray(details?.tasks) ? details.tasks : [];
    const visible = all.filter((task) => !task.archivedAt && task.status !== 'deleted');
    const archived = all.filter((task) => Boolean(task.archivedAt) && task.status !== 'deleted');
    const inProgress = visible.filter((task) => task.status === 'in_progress' && !task.closedAt);
    const pending = visible.filter((task) => task.status === 'pending' && !task.closedAt);
    const ready = pending.filter((task) => !taskIsBlocked(task, visible));
    const blocked = pending.filter((task) => taskIsBlocked(task, visible));
    const completed = visible.filter((task) => task.status === 'completed');
    const closed = visible.filter((task) => Boolean(task.closedAt) && task.status !== 'completed');
    const tracked = visible.filter((task) => !task.closedAt);
    const current = inProgress[0] || ready[0] || blocked[0];
    return { all, visible, archived, inProgress, ready, blocked, completed, closed, tracked, current };
  }, [details]);

  const total = model.tracked.length;
  const done = model.completed.length;
  const ratio = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;
  const groups: Group[] = [
    { key: 'progress', label: '进行中', tasks: model.inProgress, icon: <CircleDot /> },
    { key: 'ready', label: '可开始', tasks: model.ready, icon: <Circle /> },
    { key: 'blocked', label: '被阻塞', tasks: model.blocked, icon: <Lock /> },
    { key: 'completed', label: '已完成', tasks: model.completed, icon: <Check /> },
    { key: 'closed', label: '已结束', tasks: model.closed, icon: <Minus /> },
  ].filter((group) => group.tasks.length > 0);

  if (!open && model.visible.length === 0) return null;

  const currentLabel = model.current
    ? model.current.status === 'in_progress' ? (model.current.activeForm || model.current.subject) : model.current.subject
    : total > 0 && done === total ? '全部完成' : model.closed.length > 0 ? '任务已结束' : '暂无任务';

  return <div className={`todo-dock ${open ? 'is-open' : ''} ${model.current?.status === 'in_progress' ? 'is-live' : ''}`}>
    <button type="button" className="todo-dock-head" onClick={onToggle} aria-expanded={open} aria-label="任务计划">
      <span className="todo-dock-title"><ListTodo /><span>计划</span></span>
      <span className="todo-dock-current" title={currentLabel}>{currentLabel}</span>
      <span className="todo-dock-meter" aria-hidden="true"><i style={{ width: `${ratio}%` }} /></span>
      <span className="todo-dock-count">{done}<span>/</span>{total}</span>
      {open ? <ChevronUp /> : <ChevronDown />}
    </button>
    {open && <div className="todo-dock-body">
      {groups.length === 0 ? <div className="todo-dock-empty"><ListTodo /><strong>暂无任务</strong><span>让 Pi 把多步工作拆成任务后，这里会自动出现。</span></div> : <div className="todo-dock-scroll">
        {groups.map((group) => <section className="todo-group" key={group.key}>
          <div className="todo-group-head">{group.icon}<span>{group.label}</span><b>{group.tasks.length}</b></div>
          {group.tasks.map((task) => <TaskRow key={task.id} task={task} blocked={group.key === 'blocked'} />)}
        </section>)}
        {model.archived.length > 0 && <div className="todo-dock-archived"><Archive /><span>{model.archived.length} 项已归档</span></div>}
      </div>}
    </div>}
  </div>;
}
