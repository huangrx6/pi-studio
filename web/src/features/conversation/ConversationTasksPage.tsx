import { useMemo, useState } from 'react';
import { Check, Circle, CircleDot, ListChecks, LockKeyhole, Minus } from 'lucide-react';
import { SessionViewHeader } from '../../shell/SessionViewHeader';
import { Select } from '../../shared/Select';
import { LoadingState } from '../../shared/LoadingState';
import type { TodoHistoryPlan, TodoTask } from '../../types/chat-types';
import { historyTaskStatus, matchesStatus, taskStatusNames, type TaskFilter, type TaskStatus } from './todo-status';
import { taskPageSize, useTaskCatalog } from './useTodoHistory';
import './styles/conversation-tasks.css';

const views = { plan: '按清单', goal: '按目标', status: '按状态' } as const;
type View = keyof typeof views;
const statuses = Object.keys(taskStatusNames) as TaskStatus[];
const filterOptions = [
  { value: 'all', label: '全部状态' },
  { value: 'incomplete', label: '全部未完成' },
  ...statuses.map(value => ({ value, label: taskStatusNames[value] })),
];
const icons = { active: CircleDot, pending: Circle, blocked: LockKeyhole, completed: Check, unfinished: Minus };
const scopeNames = { turn: '普通清单', goal: '目标清单', legacy: '早期会话任务' };
type TaskEntry = { plan: TodoHistoryPlan; task: TodoTask; status: TaskStatus };
type Group = { key: string; title: string; meta?: string; entries: TaskEntry[] };

function taskGroups(plans: TodoHistoryPlan[], view: View, filter: TaskFilter) {
  const groups = new Map<string, Group>();
  for (const plan of plans) {
    for (const task of plan.tasks) {
      if (task.status === 'deleted') continue;
      const status = historyTaskStatus(plan, task);
      if (!matchesStatus(status, filter)) continue;
      let key = String(plan.planId);
      let title = plan.title;
      let meta: string | undefined;
      if (view === 'goal') {
        key = plan.scope === 'goal' ? `goal-${plan.goalId ?? plan.planId}` : plan.scope;
        if (plan.scope !== 'goal') title = plan.scope === 'legacy' ? '早期会话任务' : '普通对话任务';
      } else if (view === 'status') {
        key = status;
        title = taskStatusNames[status];
      } else {
        meta = [scopeNames[plan.scope], `#${plan.planId}`, plan.lifecycle === 'ended' ? '已结束' : ''].filter(Boolean).join(' · ');
      }
      let group = groups.get(key);
      if (!group) {
        group = { key, title, meta, entries: [] };
        groups.set(key, group);
      }
      group.entries.push({ plan, task, status });
    }
  }
  return view === 'status' ? statuses.flatMap(status => groups.get(status) ?? []) : [...groups.values()];
}

export default function ConversationTasksPage({ sessionId, goalUpdatedAt }: { sessionId: string; goalUpdatedAt?: number }) {
  const [view, setView] = useState<View>('plan');
  const [filter, setFilter] = useState<TaskFilter>('all');
  const [limit, setLimit] = useState(taskPageSize);
  const { plans, loading, more, error, retry } = useTaskCatalog(sessionId, goalUpdatedAt, filter, limit);
  const groups = useMemo(() => taskGroups(plans, view, filter), [plans, view, filter]);
  const count = groups.reduce((total, group) => total + group.entries.length, 0);

  return <section className="session-tasks-page" aria-label="本会话全部任务">
    <div className="session-tasks-column">
      <SessionViewHeader title="全部任务" summary={count > 0 ? `${more ? '已显示 ' : ''}${plans.length} 份清单 · ${count} 项任务` : undefined} />
      <div className="session-tasks-toolbar">
        <div className="session-tasks-views" role="group" aria-label="任务分组">
          {(Object.keys(views) as View[]).map(key => <button key={key} type="button" aria-pressed={view === key}
            onClick={() => setView(key)}>{views[key]}</button>)}
        </div>
        <Select label="筛选任务状态" value={filter} options={filterOptions}
          onChange={value => { setFilter(value as TaskFilter); setLimit(taskPageSize); }} />
      </div>
      {error && <div className="session-tasks-feedback" role="alert">{error}<button type="button" onClick={retry}>重试</button></div>}
      <div aria-busy={loading}>
        {groups.map(group => <section className="session-tasks-group" key={view + group.key} aria-label={group.title}>
          <header><h3>{group.title}</h3><small>{group.meta && `${group.meta} · `}{group.entries.length} 项</small></header>
          <ul>{group.entries.map(({ plan, task, status }) => {
            const Icon = icons[status];
            return <li key={plan.planId + '/' + task.id} data-status={status}>
              <Icon aria-hidden="true" />
              <div><strong>{task.subject}</strong>
                {view !== 'plan' && <small>{scopeNames[plan.scope]} #{plan.planId}{view === 'status' ? ` · ${plan.title}` : ''}</small>}
                {task.closedReason && <small>{task.closedReason}</small>}
              </div>
              {view !== 'status' ? <span>{taskStatusNames[status]}{task.archivedAt ? ' · 已归档' : ''}</span>
                : task.archivedAt ? <span>已归档</span> : null}
            </li>;
          })}</ul>
        </section>)}
      </div>
      {loading && <LoadingState variant="section">正在读取任务…</LoadingState>}
      {!loading && !error && !count && <div className="session-tasks-empty"><ListChecks aria-hidden="true" />
        <p>{filter === 'all' ? '本次会话还没有任务' : '没有符合此状态的任务'}</p></div>}
      {!loading && !error && more && <button type="button" className="session-tasks-more" onClick={() => setLimit(value => value + taskPageSize)}>加载更多清单</button>}
    </div>
  </section>;
}
