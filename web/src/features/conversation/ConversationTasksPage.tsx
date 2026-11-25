import { useDeferredValue, useMemo, useRef, useState } from 'react';
import { ListChecks, Search } from 'lucide-react';
import { SessionViewHeader } from '../../shell/SessionViewHeader';
import { Select } from '../../shared/Select';
import { LoadingState } from '../../shared/LoadingState';
import type { TodoHistoryPlan } from '../../types/chat-types';
import { historyTaskStatus, matchesStatus, matchesTaskQuery, taskStatusNames, type TaskFilter, type TaskStatus } from './todo-status';
import { taskPageSize, useTaskCatalog } from './useTodoHistory';
import { ConversationTaskGroup, TaskPager, type TaskGroup } from './ConversationTaskGroup';
import './styles/conversation-tasks.css';

const views = { plan: '按清单', goal: '按目标', status: '按状态' } as const;
type View = keyof typeof views;
const statuses = Object.keys(taskStatusNames) as TaskStatus[];
const filterOptions = [
  { value: 'all', label: '全部状态' },
  { value: 'incomplete', label: '全部未完成' },
  ...statuses.map(value => ({ value, label: taskStatusNames[value] })),
];
const scopeNames = { turn: '普通清单', goal: '目标清单', legacy: '早期会话任务' };
const initiallyOpenGroups = 3;

function taskGroups(plans: TodoHistoryPlan[], view: View, filter: TaskFilter, query: string) {
  const groups = new Map<string, TaskGroup>();
  for (const plan of plans) {
    const scopeName = scopeNames[plan.scope];
    const source = `${scopeName} #${plan.planId}${view === 'status' ? ' · ' + plan.title : ''}`;
    let planKey = String(plan.planId);
    let title = plan.title;
    let meta: string | undefined;
    if (view === 'goal') {
      planKey = plan.scope === 'goal' ? `goal-${plan.goalId ?? plan.planId}` : plan.scope;
      if (plan.scope !== 'goal') title = plan.scope === 'legacy' ? scopeName : '普通对话任务';
    } else if (view === 'plan') {
      meta = [scopeName, `#${plan.planId}`, plan.lifecycle === 'ended' ? '已结束' : ''].filter(Boolean).join(' · ');
    }
    for (const task of plan.tasks) {
      if (task.status === 'deleted' || !matchesTaskQuery(plan, task, query)) continue;
      const status = historyTaskStatus(plan, task);
      if (!matchesStatus(status, filter)) continue;
      const key = view === 'status' ? status : planKey;
      let group = groups.get(key);
      if (!group) {
        group = { key, title: view === 'status' ? taskStatusNames[status] : title, meta, uniformStatus: status, completed: 0, entries: [] };
        groups.set(key, group);
      }
      if (group.uniformStatus !== status) group.uniformStatus = undefined;
      if (status === 'completed') group.completed++;
      group.entries.push({ planId: plan.planId, task, status, source: view === 'plan' ? undefined : source });
    }
  }
  return view === 'status' ? statuses.flatMap(status => groups.get(status) ?? []) : [...groups.values()];
}

export default function ConversationTasksPage({ sessionId, goalUpdatedAt, onBack }: {
  sessionId: string;
  goalUpdatedAt?: number;
  onBack: () => void;
}) {
  const [view, setView] = useState<View>('plan');
  const [filter, setFilter] = useState<TaskFilter>('all');
  const [search, setSearch] = useState('');
  const query = useDeferredValue(search.trim().toLowerCase());
  const [groupPage, setGroupPage] = useState(0);
  const [limit, setLimit] = useState(taskPageSize);
  const results = useRef<HTMLDivElement>(null);
  const { plans, loading, more, error, retry } = useTaskCatalog(sessionId, goalUpdatedAt, filter, query, limit);
  const groups = useMemo(() => taskGroups(plans, view, filter, query), [plans, view, filter, query]);
  const count = groups.reduce((total, group) => total + group.entries.length, 0);
  const lastPage = Math.max(0, Math.ceil(groups.length / taskPageSize) - 1);
  const current = Math.min(groupPage, lastPage);
  const start = current * taskPageSize;
  const end = Math.min(start + taskPageSize, groups.length);
  const hasNext = current < lastPage || (view === 'plan' && more);
  const groupUnit = view === 'plan' ? '清单' : '分组';

  function firstPage() {
    setGroupPage(0);
    results.current?.scrollTo(0, 0);
  }

  function showGroupPage(page: number) {
    if (page > lastPage) setLimit(value => value + taskPageSize);
    setGroupPage(page);
    results.current?.focus({ preventScroll: true });
    results.current?.scrollTo(0, 0);
  }

  return <section className="session-tasks-page" aria-label="本会话全部任务">
    <div className="session-tasks-column">
      <div className="session-tasks-controls">
        <SessionViewHeader title="全部任务" back={{ label: '返回进展', onClick: onBack }}
          summary={count > 0 ? `${more ? '已载入 ' : ''}${plans.length} 份清单 · ${count} 项任务` : undefined} />
        <div className="session-tasks-toolbar">
          <div className="session-tasks-views" role="group" aria-label="任务分组">
            {(Object.keys(views) as View[]).map(key => <button key={key} type="button" aria-pressed={view === key}
              onClick={() => { setView(key); firstPage(); }}>{views[key]}</button>)}
          </div>
          <label className="session-tasks-search"><Search aria-hidden="true" />
            <input type="search" aria-label="搜索清单或任务" placeholder="搜索清单或任务" value={search}
              onChange={event => { setSearch(event.target.value); setLimit(taskPageSize); firstPage(); }} />
          </label>
          <Select label="筛选任务状态" value={filter} options={filterOptions}
            onChange={value => { setFilter(value as TaskFilter); setLimit(taskPageSize); firstPage(); }} />
        </div>
      </div>
      <div className="session-tasks-results" ref={results} tabIndex={-1} role="region" aria-label="任务结果" aria-busy={loading}>
        {error && <div className="session-tasks-feedback" role="alert">{error}<button type="button" onClick={retry}>重试</button></div>}
        {groups.slice(start, end).map((group, index) => <ConversationTaskGroup
          key={JSON.stringify([view, filter, query, group.key])} group={group} byStatus={view === 'status'}
          initiallyOpen={index < initiallyOpenGroups} />)}
        {loading && <LoadingState variant="section">正在读取任务…</LoadingState>}
        {!loading && !error && !count && <div className="session-tasks-empty" role="status">
          {query ? <Search aria-hidden="true" /> : <ListChecks aria-hidden="true" />}
          <p>{query ? '没有找到匹配的任务' : filter === 'all' ? '本次会话还没有任务' : '没有符合此状态的任务'}</p>
          {(query || filter !== 'all') && <button type="button" onClick={() => {
            setSearch(''); setFilter('all'); setLimit(taskPageSize); firstPage();
          }}>查看全部任务</button>}
        </div>}
        {count > 0 && (lastPage > 0 || (view === 'plan' && more)) && <TaskPager label="任务分组翻页" unit={groupUnit}
          range={`${groupUnit} ${start + 1}–${end}`}
          previous={current > 0 ? () => showGroupPage(current - 1) : undefined}
          next={hasNext && !loading && !error ? () => showGroupPage(current + 1) : undefined}
          jump={{ current, last: lastPage, show: showGroupPage }} />}
        {!loading && !error && more && view !== 'plan' && <button type="button" className="session-tasks-more"
          onClick={() => setLimit(value => value + taskPageSize)}>加载更多清单</button>}
      </div>
    </div>
  </section>;
}
