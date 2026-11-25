import { useMemo, useState, type ReactNode } from 'react';
import { ChevronDown, ChevronUp } from 'lucide-react';
import { TaskStatusIcon } from './TaskStatusIcon';
import { taskIsBlocked } from './todo-status';
import type { TodoDetails, TodoTask } from '../../types/chat-types';

type TodoDockProps = {
  /** 任务计划快照；undefined 表示当前会话还没有 todo 结果。 */
  details?: TodoDetails;
  headerAction: ReactNode;
};

type Group = { key: string; label: string; tasks: TodoTask[] };

/**
 * 单条任务行。
 *
 * 图标优先级：已完成 > 已结束 > 被阻塞 > 进行中 > 待办，保证一行只表达一个主状态。
 * 进行中的任务优先显示 activeForm（例如「正在运行测试」），其余显示 subject。
 *
 * @param task 任务
 * @param blocked 是否被依赖阻塞（由分组决定，父级已知）
 */
function TaskRow({ task, blocked, label }: { task: TodoTask; blocked: boolean; label?: string }) {
  const complete = task.status === 'completed';
  const closed = Boolean(task.closedAt);
  const active = task.status === 'in_progress';
  const status = complete ? 'completed' : closed ? 'unfinished' : blocked ? 'blocked' : active ? 'active' : 'pending';
  return <div className={`todo-row ${active ? 'is-active' : ''} ${complete ? 'is-complete' : ''} ${closed ? 'is-closed' : ''} ${blocked ? 'is-blocked' : ''}`}>
    <TaskStatusIcon status={status} label={label} />
    <span className="todo-row-subject" title={task.description || task.subject}>{active ? (task.activeForm || task.subject) : task.subject}</span>
    {blocked && !complete && !closed && <span className="todo-row-note">被依赖阻塞</span>}
    {closed && !complete && <span className="todo-row-note">已结束</span>}
  </div>;
}

/**
 * 进展面板的任务预览。
 *
 * @param details 任务快照（来自最新 todo 工具结果）
 *
 * 进度分母只统计「未结束」任务（tracked），因此提前结束的任务不会拉低完成率；
 * 任务按当前状态排序，长清单可展开。
 */
export function TodoDock({ details, headerAction }: TodoDockProps) {
  const [showMore, setShowMore] = useState(false);
  const model = useMemo(() => {
    const all = Array.isArray(details?.tasks) ? details.tasks : [];
    // deleted 是软删除，任何分组都不展示；archived 只保留在归档计数里。
    const visible = all.filter((task) => !task.archivedAt && task.status !== 'deleted');
    const archived = all.filter((task) => Boolean(task.archivedAt) && task.status !== 'deleted');
    const inProgress = visible.filter((task) => task.status === 'in_progress' && !task.closedAt);
    const pending = visible.filter((task) => task.status === 'pending' && !task.closedAt);
    // ready / blocked 都来自 pending：阻塞判断基于 visible，已归档的依赖不再算阻塞。
    const ready = pending.filter((task) => !taskIsBlocked(task, visible));
    const blocked = pending.filter((task) => taskIsBlocked(task, visible));
    const completed = visible.filter((task) => task.status === 'completed');
    const closed = visible.filter((task) => Boolean(task.closedAt) && task.status !== 'completed');
    // tracked 排除已结束任务，作为进度分母，避免“提前关闭”看起来像未完成。
    const tracked = visible.filter((task) => !task.closedAt);
    return { archived, inProgress, ready, blocked, completed, closed, tracked };
  }, [details]);

  const total = model.tracked.length;
  const done = model.tracked.filter(task => task.status === 'completed').length;
  // 空分组不渲染，保持展开后的列表紧凑；顺序即产品上希望用户看到的优先级。
  const groups: Group[] = [
    { key: 'progress', label: '进行中', tasks: model.inProgress },
    { key: 'ready', label: '可开始', tasks: model.ready },
    { key: 'blocked', label: '被阻塞', tasks: model.blocked },
    { key: 'completed', label: '已完成', tasks: model.completed },
    { key: 'closed', label: '已结束', tasks: model.closed },
  ].filter((group) => group.tasks.length > 0);

  const rows = groups.flatMap(group => group.tasks.map(task => ({ task, group })));
  const previewLimit = 4;
  const preview = showMore ? rows : rows.slice(0, previewLimit);
  const more = rows.length > previewLimit && <button className="progress-text-action todo-preview-more" type="button"
    aria-expanded={showMore} onClick={() => setShowMore(value => !value)}>
    {showMore ? '收起任务' : `展开其余 ${rows.length - previewLimit} 项`}{showMore ? <ChevronUp /> : <ChevronDown />}</button>;

  return <>
    <header className="progress-section-head">
      <h3>任务列表{total > 0 && <small aria-label={`已完成 ${done} 项，共 ${total} 项`}>{done} / {total}</small>}</h3>
      {headerAction}
    </header>
    {rows.length > 0 && <div className="progress-task-scroll" tabIndex={showMore ? 0 : undefined}>
      {preview.map(({ task, group }) =>
        <TaskRow key={task.id} task={task} blocked={group.key === 'blocked'} label={group.label} />)}
    </div>}
    {more}
    {model.archived.length > 0 && <small className="progress-archive-count">{model.archived.length} 项已归档</small>}
  </>;
}
