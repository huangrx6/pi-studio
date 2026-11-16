import { useEffect, useState } from 'react';
import type { TodoHistoryPage } from '../../types/chat-types';
import { historyTaskStatus, taskStatusNames } from './todo-status';
import { useTodoHistoryRevision } from './useTodoHistory';
import './styles/todo-history.css';

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
      : !page ? <p role="status">正在读取清单…</p>
      : !page.items.length ? <p>本次会话还没有任务清单</p>
      : page.items.map(plan => <details key={plan.planId}>
        <summary>
          <span>{plan.scope === 'goal' ? '目标' : plan.scope === 'turn' ? '普通清单' : '历史'}</span>
          <strong>{plan.title}</strong>
          <small>{plan.tasks.filter(task => task.status !== 'deleted').length} 项</small>
        </summary>
        {plan.tasks.filter(task => task.status !== 'deleted').map(task => <div key={task.id} className="todo-history-task">
          <span>{taskStatusNames[historyTaskStatus(plan, task)]}{task.archivedAt ? ' · 已归档' : ''}</span><span>{task.subject}</span>
        </div>)}
      </details>)}
    {(cursors.length > 0 || page?.nextCursor) ? <nav aria-label="清单历史翻页">
      <button disabled={!cursors.length} onClick={() => setCursors(value => value.slice(0, -1))}>上一页</button>
      <button disabled={!page?.nextCursor} onClick={() => {
        if (page?.nextCursor) setCursors([...cursors, page.nextCursor]);
      }}>下一页</button>
    </nav> : null}
  </section>;
}
