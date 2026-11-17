import { useEffect, useState } from 'react';
import { Check, ChevronRight, Circle, CircleDot, Lock, Minus, Target } from 'lucide-react';
import type { TodoHistoryPage } from '../../types/chat-types';
import { LoadingState } from '../../shared/LoadingState';
import { historyTaskStatus, taskStatusNames } from './todo-status';
import { useTodoHistoryRevision } from './useTodoHistory';
import './styles/todo-history.css';
const statusIcons = { active: CircleDot, pending: Circle, completed: Check, blocked: Lock, unfinished: Minus };

// Mounted only when the user opens the history; paging never grows the transcript window.
export function TodoHistory({ sessionId, goalUpdatedAt }: { sessionId: string; goalUpdatedAt?: number }) {
  const [cursors, setCursors] = useState<number[]>([]);
  const [attempt, setAttempt] = useState(0);
  const [loaded, setLoaded] = useState<{ cursor?: number; page: TodoHistoryPage }>();
  const [error, setError] = useState('');
  const cursor = cursors.at(-1);
  const revision = useTodoHistoryRevision(sessionId);
  const page = loaded?.cursor === cursor ? loaded?.page : undefined;
  useEffect(() => {
    let disposed = false;
    setError('');
    void window.piApi.conversationTodoHistory({ id: sessionId, cursor, limit: 5 }).then(result => {
      if (!disposed) setLoaded({ cursor, page: result });
    }).catch(reason => {
      if (!disposed) setError(String(reason instanceof Error ? reason.message : reason));
    });
    return () => { disposed = true; };
  }, [sessionId, cursor, attempt, revision, goalUpdatedAt]);

  return <section className="todo-history" aria-label="会话任务历史">
    {error ? <p role="alert">{error} <button onClick={() => setAttempt(value => value + 1)}>重试</button></p>
      : !page ? <LoadingState>正在读取清单…</LoadingState>
      : !page.items.length ? <p>本次会话还没有任务清单</p>
      : page.items.map(plan => {
        const tasks = plan.tasks.filter(task => task.status !== 'deleted');
        return <details key={plan.planId}><summary><ChevronRight aria-hidden="true" />
          <strong>{plan.title}</strong>{plan.scope === 'goal' && <Target aria-label="目标清单" />}
          <small>{tasks.length} 项</small></summary>
          <ul>{tasks.map(task => {
            const status = historyTaskStatus(plan, task), Icon = statusIcons[status];
            return <li key={task.id} className="todo-history-task" data-status={status}>
              <span role="img" aria-label={taskStatusNames[status]} title={taskStatusNames[status]}><Icon aria-hidden="true" /></span>
              <span>{task.subject}{task.archivedAt && <small>已归档</small>}</span>
            </li>;
          })}</ul>
        </details>;
      })}
    {(cursors.length > 0 || page?.nextCursor) ? <nav aria-label="清单历史翻页">
      <button disabled={!cursors.length} onClick={() => setCursors(value => value.slice(0, -1))}>上一页</button>
      <button disabled={!page?.nextCursor} onClick={() => {
        if (page?.nextCursor) setCursors([...cursors, page.nextCursor]);
      }}>下一页</button>
    </nav> : null}
  </section>;
}
