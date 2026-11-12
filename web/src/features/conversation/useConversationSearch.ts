/**
 * 对话内搜索：走主进程在完整历史上做 LIKE 粗筛，渲染层只持有命中条目 id 与片段。
 *
 * 为什么不在这里扫已加载的消息：会话可能只加载了最近 200 条，而用户要搜的是
 * 全部历史；把整段历史拉进渲染层正是之前在修的内存问题。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ConversationSearchItem } from '../../types/durable-types';

export type ConversationSearchState = {
  open: boolean;
  query: string;
  items: ConversationSearchItem[];
  /** 当前定位到第几个结果；-1 表示还没跳。 */
  index: number;
  loading: boolean;
  error: string | null;
};

const INITIAL: ConversationSearchState = {
  open: false,
  query: '',
  items: [],
  index: -1,
  loading: false,
  error: null,
};

/** 输入停顿多久后再查库；大会话的 LIKE 只要几十毫秒，但连续输入不必每次都查。 */
const SEARCH_DEBOUNCE_MS = 220;

export function useConversationSearch({
  sessionId,
  onJump,
}: {
  sessionId?: string;
  /** 跳到某条命中；返回 false 表示目标不可达。 */
  onJump: (sourceIndex: number) => Promise<boolean>;
}) {
  const [state, setState] = useState<ConversationSearchState>(INITIAL);
  const requestRef = useRef(0);
  const timerRef = useRef<number | null>(null);
  const stateRef = useRef(state);
  stateRef.current = state;
  const onJumpRef = useRef(onJump);
  onJumpRef.current = onJump;

  // 切会话时收起搜索：结果属于上一条对话。
  useEffect(() => {
    setState(INITIAL);
    requestRef.current += 1;
  }, [sessionId]);

  const runSearch = useCallback(async (query: string) => {
    const trimmed = query.trim();
    const request = ++requestRef.current;
    if (!sessionId || trimmed.length < 2) {
      setState((current) => ({ ...current, items: [], index: -1, loading: false, error: null }));
      return;
    }
    setState((current) => ({ ...current, loading: true, error: null }));
    try {
      const result = await window.piApi.conversationSearch({ id: sessionId, query: trimmed });
      if (request !== requestRef.current) return;
      const items = Array.isArray(result?.items) ? result!.items : [];
      setState((current) => ({
        ...current,
        items,
        index: items.length > 0 ? 0 : -1,
        loading: false,
        error: null,
      }));
    } catch (cause) {
      if (request !== requestRef.current) return;
      setState((current) => ({
        ...current,
        items: [],
        index: -1,
        loading: false,
        error: cause instanceof Error ? cause.message : '搜索失败',
      }));
    }
  }, [sessionId]);

  const setQuery = useCallback((query: string) => {
    setState((current) => ({ ...current, query, index: -1 }));
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      void runSearch(query);
    }, SEARCH_DEBOUNCE_MS);
  }, [runSearch]);

  const open = useCallback(() => {
    setState((current) => ({ ...current, open: true }));
  }, []);

  const close = useCallback(() => {
    if (timerRef.current !== null) { window.clearTimeout(timerRef.current); timerRef.current = null; }
    requestRef.current += 1;
    setState(INITIAL);
  }, []);

  /** 跳到第 index 个结果；超出范围时停住不动。 */
  const jump = useCallback(async (index: number): Promise<boolean> => {
    const { items } = stateRef.current;
    if (index < 0 || index >= items.length) return false;
    const reached = await onJumpRef.current(items[index].sourceIndex);
    if (reached) setState((current) => ({ ...current, index }));
    return reached;
  }, []);

  const step = useCallback(async (direction: 1 | -1) => {
    const { items, index } = stateRef.current;
    if (items.length === 0) return;
    const next = index < 0 ? 0 : index + direction;
    if (next < 0 || next >= items.length) return;
    await jump(next);
  }, [jump]);

  useEffect(() => () => {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
  }, []);

  return { state, setQuery, open, close, jump, step, runSearch };
}
