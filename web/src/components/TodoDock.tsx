/**
 * 任务计划浮层（TodoDock）。
 *
 * 数据来源：会话里最新一条 `todo` 工具结果消息的 details。App 用 useMemo 从
 * messages 中提取后作为 props 传入，因此本组件不订阅 IPC，也不直接修改任务——
 * 任务的创建/勾选由模型调用 todo 工具完成。
 *
 * 展示逻辑：
 * - 分组：进行中 / 可开始 / 被阻塞 / 已完成 / 已结束；
 * - 「被阻塞」= blockedBy 中至少一个依赖仍未完成且未结束（见 taskIsBlocked）；
 * - 进度 = 未结束任务中已完成的比例，右上角显示 done/total；
 * - 折叠时只显示当前任务标题和进度条，展开后显示分组明细与归档数量。
 */
import { useMemo } from 'react';
import { Archive, Check, ChevronDown, ChevronUp, Circle, CircleDot, ListTodo, Lock, Minus } from 'lucide-react';
import type { TodoDetails, TodoTask } from '../chat-types';

type TodoDockProps = {
  /** 任务计划快照；undefined 表示当前会话还没有 todo 结果。 */
  details?: TodoDetails;
  /** 面板是否展开。 */
  open: boolean;
  /** 切换展开/收起。 */
  onToggle: () => void;
};

type Group = { key: string; label: string; tasks: TodoTask[]; icon: React.ReactNode };

/**
 * 判断任务是否被依赖阻塞。
 *
 * 只有「依赖仍然存在、未归档、未完成、也未结束」才算阻塞：
 * - 依赖已归档：视为不再阻塞（归档通常意味着不再参与当前计划）；
 * - 依赖已结束（closedAt）：同样视为解除；
 * - blockedBy 里指向不存在的 id：忽略，避免脏数据把任务永久锁住。
 *
 * @param task 待判断任务
 * @param tasks 参与判断的任务集合（调用方传 visible，即未归档/未删除的任务）
 */
function taskIsBlocked(task: TodoTask, tasks: TodoTask[]): boolean {
  return (task.blockedBy || []).some((id) => {
    const blocker = tasks.find((candidate) => candidate.id === id);
    return Boolean(blocker && !blocker.archivedAt && blocker.status !== 'completed' && !blocker.closedAt);
  });
}

/**
 * 单条任务行。
 *
 * 图标优先级：已完成 > 已结束 > 被阻塞 > 进行中 > 待办，保证一行只表达一个主状态。
 * 进行中的任务优先显示 activeForm（例如「正在运行测试」），其余显示 subject。
 *
 * @param task 任务
 * @param blocked 是否被依赖阻塞（由分组决定，父级已知）
 */
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

/**
 * 任务计划浮层。
 *
 * @param details 任务快照（来自最新 todo 工具结果）
 * @param open 是否展开
 * @param onToggle 折叠头部的点击回调
 *
 * 进度分母只统计「未结束」任务（tracked），因此提前结束的任务不会拉低完成率；
 * 当前任务按「进行中 → 可开始 → 被阻塞」的优先级选取，用于折叠态标题。
 */
export function TodoDock({ details, open, onToggle }: TodoDockProps) {
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
    // 头部优先展示正在做的，其次是可开始的，最后才提示被阻塞的任务。
    const current = inProgress[0] || ready[0] || blocked[0];
    return { all, visible, archived, inProgress, ready, blocked, completed, closed, tracked, current };
  }, [details]);

  const total = model.tracked.length;
  const done = model.completed.length;
  const ratio = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;
  // 空分组不渲染，保持展开后的列表紧凑；顺序即产品上希望用户看到的优先级。
  const groups: Group[] = [
    { key: 'progress', label: '进行中', tasks: model.inProgress, icon: <CircleDot /> },
    { key: 'ready', label: '可开始', tasks: model.ready, icon: <Circle /> },
    { key: 'blocked', label: '被阻塞', tasks: model.blocked, icon: <Lock /> },
    { key: 'completed', label: '已完成', tasks: model.completed, icon: <Check /> },
    { key: 'closed', label: '已结束', tasks: model.closed, icon: <Minus /> },
  ].filter((group) => group.tasks.length > 0);

  // 折叠且无任务时不占位；展开时即使无任务也要显示空状态（用户主动点开的）。
  if (!open && model.visible.length === 0) return null;

  const currentLabel = model.current
    ? model.current.status === 'in_progress' ? (model.current.activeForm || model.current.subject) : model.current.subject
    : total > 0 && done === total ? '全部完成' : model.closed.length > 0 ? '任务已结束' : '暂无任务';

  return <div className={`todo-dock ${open ? 'is-open' : ''} ${model.current?.status === 'in_progress' ? 'is-live' : ''}`}>
    <button type="button" className="todo-dock-head" onClick={onToggle} aria-expanded={open} aria-label="任务计划">
      <span className="todo-dock-title"><ListTodo /><span>计划</span></span>
      {/* 折叠态用 title 兜底完整标题，避免长任务名被省略号截断后无法查看。 */}
      <span className="todo-dock-current" title={currentLabel}>{currentLabel}</span>
      <span className="todo-dock-meter" aria-hidden="true"><i style={{ width: `${ratio}%` }} /></span>
      <span className="todo-dock-count">{done}<span>/</span>{total}</span>
      {open ? <ChevronUp /> : <ChevronDown />}
    </button>
    {open && <div className="todo-dock-body">
      {groups.length === 0 ? <div className="todo-dock-empty"><ListTodo /><strong>暂无任务</strong><span>让 Pi 把多步工作拆成任务后，这里会自动出现。</span></div> : <div className="todo-dock-scroll">
        {groups.map((group) => <section className="todo-group" key={group.key}>
          <div className="todo-group-head">{group.icon}<span>{group.label}</span><b>{group.tasks.length}</b></div>
          {/* 只有 blocked 分组才把 blocked 标记传给行，避免其他分组出现重复提示。 */}
          {group.tasks.map((task) => <TaskRow key={task.id} task={task} blocked={group.key === 'blocked'} />)}
        </section>)}
        {model.archived.length > 0 && <div className="todo-dock-archived"><Archive /><span>{model.archived.length} 项已归档</span></div>}
      </div>}
    </div>}
  </div>;
}
