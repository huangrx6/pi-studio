import { useEffect, useReducer, useRef, useState } from 'react';
import type { TodoHistoryPlan } from '../../types/chat-types';
import { matchesTaskFilter, type TaskFilter } from './todo-status';

// A tool result, its document update and the run boundary can arrive together.
export function useTodoHistoryRevision(sessionId: string) {
  const [revision, refresh] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    let timer: number | undefined;
    const stop = window.piApi.onConversationEvent(event => {
      if (event.conversationId !== sessionId || timer !== undefined) return;
      if (event.type !== 'todo.changed' && event.type !== 'run.started' && event.type !== 'run.completed'
        && event.type !== 'run.failed' && event.type !== 'snapshot' && !(event.type === 'transcript.appended'
          && event.payload.messages.some(message => message.toolName === 'todo' || message.toolName === 'long_task'))) return;
      timer = window.setTimeout(() => { timer = undefined; refresh(); }, 80);
    });
    return () => { stop(); window.clearTimeout(timer); };
  }, [sessionId]);
  return revision;
}

type Catalog = { plans: TodoHistoryPlan[]; cursor?: number | null };
const batchSize = 12;

// The page is keyed by session. Cache read pages while filtering and follow the cursor
// even across empty matches, so a filter can find a task in the oldest checklist.
export function useTaskCatalog(sessionId: string, goalUpdatedAt: number | undefined, filter: TaskFilter, visibleLimit: number) {
  const revision = useTodoHistoryRevision(sessionId);
  const cache = useRef<Catalog>({ plans: [] });
  const [catalog, setCatalog] = useState<Catalog>(cache.current);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [attempt, retry] = useReducer((n: number) => n + 1, 0);

  useEffect(() => { cache.current = { plans: [] }; }, [sessionId, revision, goalUpdatedAt]);
  useEffect(() => {
    let disposed = false;
    async function load() {
      setError('');
      setLoading(true);
      let { plans, cursor } = cache.current;
      let matches = plans.filter(plan => matchesTaskFilter(plan, filter)).length;
      try {
        while (cursor !== null && matches < visibleLimit) {
          const page = await window.piApi.conversationTodoHistory({ id: sessionId, cursor, limit: batchSize });
          if (disposed) return;
          if (cursor !== undefined && page.nextCursor != null && page.nextCursor >= cursor) {
            throw new Error('任务历史翻页失败，请重试');
          }
          plans = plans.concat(page.items);
          cursor = page.nextCursor ?? null;
          matches += page.items.filter(plan => matchesTaskFilter(plan, filter)).length;
          cache.current = { plans, cursor };
        }
        setCatalog(cache.current);
      } catch (cause) {
        if (!disposed) {
          if (cache.current.plans.length) setCatalog(cache.current);
          setError(cause instanceof Error ? cause.message : String(cause));
        }
      } finally {
        if (!disposed) setLoading(false);
      }
    }
    void load();
    return () => { disposed = true; };
  }, [sessionId, revision, goalUpdatedAt, filter, visibleLimit, attempt]);

  const matches = catalog.plans.filter(plan => matchesTaskFilter(plan, filter));
  return { plans: matches.slice(0, visibleLimit), more: catalog.cursor != null || matches.length > visibleLimit, loading, error, retry };
}

export const taskPageSize = batchSize;
