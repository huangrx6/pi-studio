import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ChatMessage, RequestTrace, TodoDetails } from '../../types/chat-types';
import type { AgentView } from '../../shell/app-types';
import type { OutlineItem } from './outline-model';
import { NO_ANSWER_TEXT } from './outline-model';
import { placeRequestTraces } from './request-trace-turns';
import { transcriptWindowStart } from './transcript-window.mjs';
import { outlineIndexAt } from './outline-sync.mjs';
import {
  SCROLL_INTENT_WINDOW_MS,
  isNearBottom,
  resolveAutoFollow,
} from './chat-scroll.mjs';

type Setter<T> = React.Dispatch<React.SetStateAction<T>>;

type TranscriptNavigationDependencies = {
  sessionId?: string;
  messages: ChatMessage[];
  requestTraces: RequestTrace[];
  busy: boolean;
  turnActive: boolean;
  error: string | null;
  agentView: AgentView;
  filesOpen: boolean;
  outlineItems: OutlineItem[];
  outlineActive: number;
  setOutlineActive: Setter<number>;
  showComposerFeedback: (message: string, tone?: 'info' | 'warning') => void;
  /** 向上补一页更早的历史；返回 false 表示没有更多。 */
  onLoadOlder?: () => Promise<boolean>;
};

const TURN_WINDOW_INITIAL = 24;
const TURN_WINDOW_STEP = 24;

export function useTranscriptNavigation({
  sessionId,
  messages,
  requestTraces,
  busy,
  turnActive,
  error,
  agentView,
  filesOpen,
  outlineItems,
  outlineActive,
  setOutlineActive,
  showComposerFeedback,
  onLoadOlder,
}: TranscriptNavigationDependencies) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const topSentinelRef = useRef<HTMLDivElement | null>(null);
  const chatContentRef = useRef<HTMLDivElement>(null);
  const [turnWindowFromState, setTurnWindowFromState] = useState<{ session: string; from: number } | null>(null);
  const [pendingOutlineJump, setPendingOutlineJump] = useState<number | null>(null);
  const windowAnchorRef = useRef<{ session: string; top: number; height: number } | null>(null);
  const windowBaseRef = useRef<{ session: string; from: number } | null>(null);
  const outlineSyncRef = useRef<number | null>(null);
  const followBottomRef = useRef(true);
  const autoScrollFrameRef = useRef(0);
  const scrollIntentTimerRef = useRef<number | null>(null);
  const userScrollIntentRef = useRef(false);
  const lastTranscriptScrollTopRef = useRef(0);
  const onLoadOlderRef = useRef(onLoadOlder);
  onLoadOlderRef.current = onLoadOlder;
  const olderLoadingRef = useRef(false);
  const turnsRef = useRef<typeof transcriptTurns>([]);

  useLayoutEffect(() => {
    followBottomRef.current = true;
    userScrollIntentRef.current = false;
    if (autoScrollFrameRef.current) {
      cancelAnimationFrame(autoScrollFrameRef.current);
      autoScrollFrameRef.current = 0;
    }
    if (scrollIntentTimerRef.current !== null) {
      window.clearTimeout(scrollIntentTimerRef.current);
      scrollIntentTimerRef.current = null;
    }
  }, [sessionId]);

  function markUserScrollIntent() {
    userScrollIntentRef.current = true;
    if (scrollIntentTimerRef.current !== null) window.clearTimeout(scrollIntentTimerRef.current);
    scrollIntentTimerRef.current = window.setTimeout(() => {
      userScrollIntentRef.current = false;
      scrollIntentTimerRef.current = null;
    }, SCROLL_INTENT_WINDOW_MS);
  }

  function pinTranscriptToBottom() {
    const node = scrollRef.current;
    if (!node || !followBottomRef.current) return;
    node.scrollTop = node.scrollHeight;
    lastTranscriptScrollTopRef.current = node.scrollTop;
  }

  function scheduleTranscriptPin() {
    if (autoScrollFrameRef.current || !followBottomRef.current) return;
    autoScrollFrameRef.current = requestAnimationFrame(() => {
      autoScrollFrameRef.current = 0;
      pinTranscriptToBottom();
    });
  }

  function pauseTranscriptFollow() {
    followBottomRef.current = false;
    if (autoScrollFrameRef.current) {
      cancelAnimationFrame(autoScrollFrameRef.current);
      autoScrollFrameRef.current = 0;
    }
  }

  function resumeTranscriptFollow() {
    followBottomRef.current = true;
    scheduleTranscriptPin();
  }

  /** 取最后一条 todo 工具结果的计划详情，供底部计划面板使用。 */
  const todoDetails = useMemo<TodoDetails | undefined>(() => {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];
      const details = message.role === 'toolResult' && message.toolName === 'todo' ? message.details : undefined;
      if (details && typeof details === 'object' && Array.isArray((details as TodoDetails).tasks)) return details as TodoDetails;
    }
    return undefined;
  }, [messages]);

  /**
   * Derived transcript data is memoised on the message array: streaming flushes
   * once per frame, and re-walking two thousand messages each time was pure
   * repeat work. `messages` is replaced by identity on every real update, so
   * the cache invalidates exactly when the content changes.
   */
  const toolResultMap = useMemo(
    () => new Map(messages.filter((message) => message.role === 'toolResult' && message.toolCallId).map((message) => [message.toolCallId as string, message])),
    [messages],
  );
  /** 把消息序列折叠成「用户提问 + 助手多步回复」的轮次，工具结果挂到对应轮次。 */
  const transcriptTurns = useMemo(() => {
    const turns: Array<{ kind: 'user'; message: ChatMessage } | { kind: 'assistant'; messages: ChatMessage[] }> = [];
    for (const message of messages) {
      if (message.role === 'toolResult') continue;
      if (message.role === 'user') { turns.push({ kind: 'user', message }); continue; }
      const last = turns[turns.length - 1];
      if (last?.kind === 'assistant') last.messages.push(message);
      else turns.push({ kind: 'assistant', messages: [message] });
    }
    return turns;
  }, [messages]);
  const windowSession = sessionId ?? '';
  // The window start is pinned once per conversation and only ever moves up.
  // Appending a message must not unmount the reader's current turn, so the
  // window grows with the transcript instead of sliding.
  if (transcriptTurns.length > 0 && windowBaseRef.current?.session !== windowSession) {
    windowBaseRef.current = {
      session: windowSession,
      from: Math.max(0, transcriptTurns.length - TURN_WINDOW_INITIAL),
    };
  }
  turnsRef.current = transcriptTurns;
  const turnWindowFrom = transcriptWindowStart(
    windowSession,
    transcriptTurns.length,
    turnWindowFromState,
    windowBaseRef.current,
  );
  const visibleTurns = turnWindowFrom > 0 ? transcriptTurns.slice(turnWindowFrom) : transcriptTurns;
  useEffect(() => {
    setTurnWindowFromState(null);
    setPendingOutlineJump(null);
  }, [windowSession]);

  /** Growing the window prepends turns; keep the reader's place. */
  useLayoutEffect(() => {
    const anchor = windowAnchorRef.current;
    const container = scrollRef.current;
    if (!anchor || !container) return;
    windowAnchorRef.current = null;
    if (anchor.session !== windowSession) return;
    container.scrollTop += container.scrollHeight - anchor.height;
  }, [turnWindowFrom, windowSession]);

  /** After the window grows, scroll to the pending outline target and re-align. */
  useLayoutEffect(() => {
    if (pendingOutlineJump === null) return undefined;
    const index = pendingOutlineJump;
    let frame = 0;
    let attempt = 0;
    const step = () => {
      frame = requestAnimationFrame(() => {
        // Instant, not smooth: a repeated smooth animation measures its own
        // in-flight position and compounds the overshoot.
        scrollToOutlineItem(index, 'auto');
        attempt += 1;
        if (attempt < 3) step();
        // Clear only after the last pass: clearing inside the effect made the
        // StrictMode double-invoke return early and skip the scroll entirely.
        else setPendingOutlineJump(null);
      });
    };
    step();
    return () => { if (frame) cancelAnimationFrame(frame); };
  }, [pendingOutlineJump]);

  /**
   * 补一页更早的历史，并把阅读位置钉住。
   *
   * 插入到前面会让 scrollHeight 变大；按差值补 scrollTop，读者视线不动。
   */
  async function loadOlderWithAnchor() {
    const node = scrollRef.current;
    const load = onLoadOlderRef.current;
    if (!node || !load || olderLoadingRef.current) return;
    olderLoadingRef.current = true;
    const height = node.scrollHeight;
    try {
      const loaded = await load();
      if (!loaded) return;
      requestAnimationFrame(() => {
        const next = scrollRef.current;
        if (next) next.scrollTop += next.scrollHeight - height;
      });
    } finally {
      olderLoadingRef.current = false;
    }
  }

  /**
   * Watch the sentinel above the mounted turns.
   *
   * 先扩大已渲染的 turn 窗口；渲染窗口已经到头时，才向主进程要更早的一页。
   */
  useEffect(() => {
    const sentinel = topSentinelRef.current;
    const root = scrollRef.current;
    if (!sentinel || !root) return undefined;
    const observer = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return;
      if (turnWindowFrom === 0) { void loadOlderWithAnchor(); return; }
      windowAnchorRef.current = { session: windowSession, top: root.scrollTop, height: root.scrollHeight };
      setTurnWindowFromState({ session: windowSession, from: Math.max(0, turnWindowFrom - TURN_WINDOW_STEP) });
    }, { root, rootMargin: '800px 0px 0px 0px' });
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [turnWindowFrom, windowSession]);

  const lastAssistantTurnIndex = useMemo(
    () => transcriptTurns.reduce((last, turn, index) => turn.kind === 'assistant' ? index : last, -1),
    [transcriptTurns],
  );
  /** 每条 turn 之后最近的一条用户消息时间戳：turn diff 只可能落在它之前。 */
  const nextUserTimestamps = useMemo(() => {
    const timestamps: number[] = new Array<number>(transcriptTurns.length).fill(Number.POSITIVE_INFINITY);
    let nextUser = Number.POSITIVE_INFINITY;
    for (let index = transcriptTurns.length - 1; index >= 0; index -= 1) {
      timestamps[index] = nextUser;
      const turn = transcriptTurns[index];
      const timestamp = turn.kind === 'user' ? turn.message.timestamp : undefined;
      if (typeof timestamp === 'number' && Number.isFinite(timestamp)) nextUser = timestamp;
    }
    return timestamps;
  }, [transcriptTurns]);
  // Every request trace goes to its own answer, to the unanswered message it served, or to the live tail.
  const requestPlacement = useMemo(
    () => placeRequestTraces({ traces: requestTraces, turns: transcriptTurns, turnActive }),
    [requestTraces, transcriptTurns, turnActive],
  );
  const pendingAssistantVisible = transcriptTurns.at(-1)?.kind !== 'assistant'
    && (turnActive || requestPlacement.pending.length > 0);
  const pendingTurnError = !turnActive && requestPlacement.pending.length > 0
    ? error || NO_ANSWER_TEXT
    : undefined;
  // 缩略导航显示全部提问：刻度全量渲染，超出高度时在轨道内滚动。
  const outlineSamples = useMemo(
    () => outlineItems.map((_, index) => index),
    [outlineItems],
  );

  function syncOutlineActive() {
    const container = scrollRef.current;
    if (!container) return;
    const top = container.getBoundingClientRect().top + 14;
    const nodes = Array.from(container.querySelectorAll<HTMLElement>('.messages > .message.user[id^="chat-turn-"]'))
      .filter((node) => /^chat-turn-\d+$/.test(node.id));
    if (nodes.length === 0) {
      setOutlineActive(0);
      return;
    }

    // The transcript is in source order, so locate the last visible turn with
    // one binary search instead of measuring every outline target per frame.
    let low = 0;
    let high = nodes.length - 1;
    let visible = -1;
    while (low <= high) {
      const middle = (low + high) >> 1;
      if (nodes[middle].getBoundingClientRect().top <= top) {
        visible = middle;
        low = middle + 1;
      } else {
        high = middle - 1;
      }
    }
    const activeNode = nodes[visible >= 0 ? visible : 0];
    const sourceIndex = Number(activeNode.id.slice('chat-turn-'.length));
    // 按 entry id 找“最后一条已经读过的提问”，窗口只加载了一部分时也能对齐。
    const resolved = outlineIndexAt(outlineItems, sourceIndex);
    if (resolved >= 0) setOutlineActive((current) => current === resolved ? current : resolved);
  }

  /**
   * 滚动期间把大纲同步合并到低频任务里。滚动本身优先交付给合成器，
   * 手势完全停顿后再做一次 DOM 测量。持续滚动会重置计时器，避免在滚轮
   * 惯性尚未结束时触发布局读取。
   */
  function scheduleOutlineSync() {
    if (outlineSyncRef.current !== null) window.clearTimeout(outlineSyncRef.current);
    outlineSyncRef.current = window.setTimeout(() => {
      outlineSyncRef.current = null;
      syncOutlineActive();
    }, 160);
  }

  /** 只有明确的用户滚动意图才能离开或重新进入贴底跟随。 */
  function handleTranscriptScroll(event: React.UIEvent<HTMLDivElement>) {
    const node = event.currentTarget;
    const nextTop = node.scrollTop;
    const nextFollow = resolveAutoFollow({
      following: followBottomRef.current,
      nearBottom: isNearBottom(node),
      userInitiated: userScrollIntentRef.current,
      movedTowardStart: nextTop < lastTranscriptScrollTopRef.current - 0.5,
    });
    if (nextFollow !== followBottomRef.current) {
      if (nextFollow) resumeTranscriptFollow();
      else pauseTranscriptFollow();
    }
    lastTranscriptScrollTopRef.current = nextTop;
    scheduleOutlineSync();
  }

  function scrollToOutlineItem(index: number, behavior?: ScrollBehavior) {
    const item = outlineItems[index];
    const container = scrollRef.current;
    const node = item ? document.getElementById(`chat-turn-${item.sourceIndex}`) : null;
    if (!item || !container || !node) return false;
    // 大纲跳转表示用户主动离开底部阅读，流式更新不能再把视图拉回最新消息。
    pauseTranscriptFollow();
    const delta = node.getBoundingClientRect().top - container.getBoundingClientRect().top;
    // 近处平滑滚动；跨几百屏的远距离跳转直接落地，等动画走完反而更慢。
    const distance = Math.abs(delta);
    container.scrollTo({
      top: container.scrollTop + delta - 12,
      behavior: behavior ?? (distance > container.clientHeight * 3 ? 'auto' : 'smooth'),
    });
    setOutlineActive(index);
    return true;
  }

  /** 点击大纲：目标可能在可视窗口之外，先扩窗再滚动。 */
  /**
   * 跳到某条提问。
   *
   * 目标可能还没被加载进窗口（大会话只载入最近一段）：这时先向上补页，
   * 每次补完等两帧 React 提交再重新查一次，最多补三页。
   */
  async function jumpToOutline(index: number) {
    const item = outlineItems[index];
    const locate = () => (item
      ? turnsRef.current.findIndex((turn) => turn.kind === 'user' && turn.message.sourceIndex === item.sourceIndex)
      : -1);
    let targetIndex = locate();
    for (let attempt = 0; targetIndex < 0 && attempt < 3; attempt += 1) {
      const loaded = await onLoadOlderRef.current?.();
      if (!loaded) break;
      await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      targetIndex = locate();
    }
    if (targetIndex < 0 && item) {
      showComposerFeedback('这条提问对应的历史已经不在当前窗口内。');
      return;
    }
    // 已经渲染出来的直接滚过去；还在窗口外的先把它挂上，提交后再滚。
    if (targetIndex >= 0 && scrollToOutlineItem(index, 'auto')) {
      requestAnimationFrame(() => { scrollToOutlineItem(index, 'auto'); });
      return;
    }
    if (targetIndex >= 0) {
      windowAnchorRef.current = null;
      setTurnWindowFromState({ session: windowSession, from: Math.min(turnWindowFrom, targetIndex) });
      setPendingOutlineJump(index);
      return;
    }
    showComposerFeedback('这条提问对应的历史消息已经不可用。');
  }

  /**
   * 跳到某条消息（按 sourceIndex，也就是 Durable entry id）。
   *
   * 目标可能还没加载进窗口：先按页向上补，最多六页，每补一页等 React 提交
   * 后重新定位。找到后把渲染窗口撑到目标所在轮次再滚动过去。
   */
  async function jumpToMessage(sourceIndex: number): Promise<boolean> {
    const locate = () => turnsRef.current.findIndex((turn) => (
      turn.kind === 'user'
        ? turn.message.sourceIndex === sourceIndex
        : turn.messages.some((message) => message.sourceIndex === sourceIndex)
    ));
    let target = locate();
    for (let attempt = 0; target < 0 && attempt < 6; attempt += 1) {
      const loaded = await onLoadOlderRef.current?.();
      if (!loaded) break;
      await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      target = locate();
    }
    if (target < 0) return false;
    if (target < turnWindowFrom) {
      windowAnchorRef.current = null;
      setTurnWindowFromState({ session: windowSession, from: target });
      await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    }
    const turn = turnsRef.current[target];
    const anchorIndex = turn.kind === 'user' ? turn.message.sourceIndex : turn.messages[0]?.sourceIndex;
    const node = anchorIndex === undefined
      ? null
      : document.getElementById(`chat-turn-${anchorIndex}`) ?? document.getElementById(`chat-assistant-turn-${anchorIndex}`);
    if (!node) return false;
    node.scrollIntoView({ block: 'center', behavior: 'auto' });
    // 短暂高亮，避免用户在人眼找不到落点。
    node.classList.add('is-search-hit');
    window.setTimeout(() => node.classList.remove('is-search-hit'), 1600);
    return true;
  }

  useLayoutEffect(() => {
    // 消息提交后先在绘制前贴底；Markdown、图片或折叠区随后长高时，
    // ResizeObserver 会继续补一次，避免输出中途停在半截。
    if (agentView.kind !== 'conversation' || !followBottomRef.current) return;
    pinTranscriptToBottom();
  }, [messages, busy, agentView.kind]);

  useEffect(() => {
    if (agentView.kind !== 'conversation' || messages.length === 0) return;
    const content = chatContentRef.current;
    const viewport = scrollRef.current;
    if (!content || !viewport || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => {
      if (followBottomRef.current) scheduleTranscriptPin();
    });
    observer.observe(content);
    observer.observe(viewport);
    return () => observer.disconnect();
  }, [agentView.kind, sessionId, messages.length === 0]);

  useEffect(() => () => {
    if (autoScrollFrameRef.current) cancelAnimationFrame(autoScrollFrameRef.current);
    if (scrollIntentTimerRef.current !== null) window.clearTimeout(scrollIntentTimerRef.current);
    if (outlineSyncRef.current !== null) window.clearTimeout(outlineSyncRef.current);
  }, []);

  useEffect(() => {
    const frame = requestAnimationFrame(syncOutlineActive);
    return () => cancelAnimationFrame(frame);
  }, [messages.length, sessionId, filesOpen]);

  return {
    scrollRef,
    topSentinelRef,
    chatContentRef,
    turnWindowFrom,
    visibleTurns,
    todoDetails,
    toolResultMap,
    transcriptTurns,
    lastAssistantTurnIndex,
    nextUserTimestamps,
    requestPlacement,
    pendingAssistantVisible,
    pendingTurnError,
    outlineSamples,
    markUserScrollIntent,
    pauseTranscriptFollow,
    resumeTranscriptFollow,
    handleTranscriptScroll,
    jumpToOutline,
    jumpToMessage,
  };
}
