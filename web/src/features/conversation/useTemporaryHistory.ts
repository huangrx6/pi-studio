import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { TemporaryChatSummary } from '../../types/chat-types';
import { errorText } from '../../shared/error-text';
import { seedTemporaryChat, peekTemporary, prepareTemporaryHistory, retainTemporaryCanvas, subscribeTemporary, subscribeTemporaryHistory } from './temporary-chat-store';

export function useTemporaryHistory(active: boolean) {
  const [activeId, setActiveId] = useState<string>(() => crypto.randomUUID());
  const selection = useSyncExternalStore(
    useCallback(listener => active ? subscribeTemporary(activeId, listener) : () => {}, [active, activeId]),
    () => {
      const chat = active ? peekTemporary(activeId) : undefined;
      return chat?.modelSettled && chat.historyStatus !== 'loading' ? chat.selection : undefined;
    },
  );
  const draftId = useRef(activeId);
  const [history, setHistory] = useState<TemporaryChatSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const generation = useRef(0);
  const refresh = useCallback(() => {
    const request = ++generation.current;
    setLoading(true);
    setError('');
    void window.piApi.temporaryHistory().then(rows => {
      if (request === generation.current) setHistory(rows);
    }).catch(cause => {
      if (request === generation.current) setError(errorText(cause));
    }).finally(() => {
      if (request === generation.current) setLoading(false);
    });
  }, []);
  useEffect(() => {
    if (!active) return;
    refresh();
    const unsubscribe = subscribeTemporaryHistory(refresh);
    return () => { unsubscribe(); generation.current++; };
  }, [active, refresh]);
  useEffect(() => retainTemporaryCanvas(activeId), [activeId]);

  const startNew = useCallback((
    options?: { prompt?: string; autoSubmit?: boolean },
    onReuseDraft?: (id: string) => void,
  ) => {
    const previous = peekTemporary(draftId.current);
    if (options?.prompt || !previous || previous.busy || previous.messages.length) draftId.current = crypto.randomUUID();
    else onReuseDraft?.(draftId.current);
    if (options?.prompt) seedTemporaryChat(draftId.current, options.prompt, options.autoSubmit);
    setActiveId(draftId.current);
  }, []);
  const open = useCallback((id: string) => {
    prepareTemporaryHistory(id);
    setActiveId(id);
  }, []);
  const resumeDraft = useCallback((id: string) => {
    draftId.current = id;
    setActiveId(id);
  }, []);
  return { activeId, resumeDraft, selection, history, loading, error, refresh, startNew, open };
}
