import type { TodoHistoryPlan, TodoTask } from '../../types/chat-types';

export const taskStatusNames = {
  active: '进行中',
  pending: '待开始',
  blocked: '阻塞',
  completed: '已完成',
  unfinished: '结束时未完成',
} as const;

export type TaskStatus = keyof typeof taskStatusNames;
export type TaskFilter = TaskStatus | 'all' | 'incomplete';

export function taskIsBlocked(task: TodoTask, tasks: TodoTask[]) {
  return task.blockedBy?.some(id => tasks.some(other => other.id === id && other.status !== 'deleted'
    && !other.archivedAt && !other.closedAt && other.status !== 'completed')) ?? false;
}

export function historyTaskStatus(plan: TodoHistoryPlan, task: TodoTask): TaskStatus {
  if (task.status === 'completed') return 'completed';
  if (task.closedAt || plan.lifecycle === 'ended') return 'unfinished';
  if (task.status === 'in_progress') return 'active';
  return taskIsBlocked(task, plan.tasks) ? 'blocked' : 'pending';
}

export function matchesStatus(status: TaskStatus, filter: TaskFilter) {
  return filter === 'all' || status === filter || (filter === 'incomplete' && status !== 'completed');
}

export function matchesTaskQuery(plan: TodoHistoryPlan, task: TodoTask, query: string) {
  return !query || task.subject.toLowerCase().includes(query) || plan.title.toLowerCase().includes(query);
}

export function matchesTaskFilter(plan: TodoHistoryPlan, filter: TaskFilter, query = '') {
  return plan.tasks.some(task => task.status !== 'deleted'
    && matchesTaskQuery(plan, task, query)
    && (filter === 'all' || matchesStatus(historyTaskStatus(plan, task), filter)));
}
