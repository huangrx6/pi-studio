import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ChatMessage, RequestTrace, TodoDetails } from '../../types/chat-types';
import type { AgentView } from '../../shell/app-types';
import type { OutlineItem } from './outline-model';
import { NO_ANSWER_TEXT } from './outline-model';
import { placeRequestTraces } from './request-trace-turns';
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
  hasNewer?: boolean;
  outlineItems: OutlineItem[];
  outlineActive: number;
  setOutlineActive: Setter<number>;
  showComposerFeedback: (message: string, tone?: 'info' | 'warning') => void;
  /** 向上补一页更早的历史；返回 false 表示没有更多。 */
  onLoadOlder?: (beforeApply: () => number[]) => Promise<boolean>;
  /** 向下补一页更新的历史；返回 false 表示已经到最新。 */
  onLoadNewer?: (beforeApply: () => number[]) => Promise<boolean>;
  /** 按稳定 entry id 直接读取目标附近的一窗。 */
  onLoadTarget?: (sourceIndex: number) => Promise<boolean>;
};

export function useTranscriptNavigation({
  sessionId,
  messages,
  requestTraces,
  busy,
  turnActive,
  error,
  agentView,
  filesOpen,
  hasNewer = false,
  outlineItems,
  outlineActive,
  setOutlineActive,
  showComposerFeedback,
  onLoadOlder,
  onLoadNewer,
  onLoadTarget,
}: TranscriptNavigationDependencies) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const topSentinelRef = useRef<HTMLDivElement | null>(null);
  const bottomSentinelRef = useRef<HTMLDivElement | null>(null);
  const chatContentRef = useRef<HTMLDivElement>(null);
  const pageAnchorRef = useRef<{ session: string; anchors: Array<{ id: string; offset: number }> } | null>(null);
  const jumpingRef = useRef(false);
  const hasNewerRef = useRef(hasNewer);
  hasNewerRef.current = hasNewer;
  const outlineSyncRef = useRef<number | null>(null);
  const followBottomRef = useRef(true);
  const autoScrollFrameRef = useRef(0);
  const scrollIntentTimerRef = useRef<number | null>(null);
  const userScrollIntentRef = useRef(false);
  // One gesture may request one page. Scroll compensation never grants
  // another request, and cannot reverse the user's loading direction.
  const pageIntentRef = useRef<'older' | 'newer' | 'unknown' | null>(null);
  const pageIntentFrameRef = useRef(0);
  const lastTranscriptScrollTopRef = useRef(0);
  const programmedTopRef = useRef<number | null>(null);
  // Keep the last layout metrics so a composer resize can preserve the current
  // reading edge without being mistaken for new transcript content. The input
  // editor lives after the viewport in normal flow, so growing it reduces the
  // viewport height while leaving the transcript's scroll height unchanged.
  const resizeMetricsRef = useRef<{ viewportHeight: number; contentHeight: number } | null>(null);
  const onLoadOlderRef = useRef(onLoadOlder);
  onLoadOlderRef.current = onLoadOlder;
  const onLoadNewerRef = useRef(onLoadNewer);
  onLoadNewerRef.current = onLoadNewer;
  const olderLoadingRef = useRef(false);

  const turnsRef = useRef<typeof transcriptTurns>([]);

  useLayoutEffect(() => {
    followBottomRef.current = true;
    userScrollIntentRef.current = false;
    pageIntentRef.current = null;
    pageAnchorRef.current = null;
    programmedTopRef.current = null;
    resizeMetricsRef.current = null;
    if (pageIntentFrameRef.current) cancelAnimationFrame(pageIntentFrameRef.current);
    if (autoScrollFrameRef.current) {
      cancelAnimationFrame(autoScrollFrameRef.current);
      autoScrollFrameRef.current = 0;
    }
    if (scrollIntentTimerRef.current !== null) {
      window.clearTimeout(scrollIntentTimerRef.current);
      scrollIntentTimerRef.current = null;
    }
  }, [sessionId]);

  function markUserScrollIntent(deltaY?: number) {
    userScrollIntentRef.current = true;
    pageIntentRef.current = deltaY === undefined ? 'unknown' : deltaY < 0 ? 'older' : 'newer';
    if (pageIntentFrameRef.current) cancelAnimationFrame(pageIntentFrameRef.current);
    pageIntentFrameRef.current = requestAnimationFrame(() => {
      pageIntentFrameRef.current = 0;
      const root = scrollRef.current;
      const direction = pageIntentRef.current;
      if (!root || !direction || direction === 'unknown') return;
      const distance = direction === 'older' ? root.scrollTop : root.scrollHeight - root.scrollTop - root.clientHeight;
      if (distance < 240) void loadWithAnchor(direction);
    });
    if (scrollIntentTimerRef.current !== null) window.clearTimeout(scrollIntentTimerRef.current);
    scrollIntentTimerRef.current = window.setTimeout(() => {
      userScrollIntentRef.current = false;
      pageIntentRef.current = null;
      scrollIntentTimerRef.current = null;
    }, SCROLL_INTENT_WINDOW_MS);
  }

  function pinTranscriptToBottom() {
    const node = scrollRef.current;
    if (!node || !followBottomRef.current) return;
    // Use the clamped maximum instead of assigning scrollHeight directly.  A
    // direct `scrollTop = scrollHeight` write is repeated while the composer
    // and streamed markdown resize; even when the browser lands on the same
    // position it still schedules a scroll event in some WebViews.  Avoiding
    // that no-op write keeps the reader at the live edge without a visible
    // one-frame nudge.
    const target = Math.max(0, node.scrollHeight - node.clientHeight);
    const moved = Math.abs(node.scrollTop - target) > 0.5;
    if (moved) {
      node.scrollTop = target;
      // Only suppress the scroll event caused by an actual programmatic move.
      // Leaving this marker behind after a no-op pin can swallow the next tiny
      // trackpad gesture and make follow mode feel unresponsive.
      programmedTopRef.current = target;
    } else {
      programmedTopRef.current = null;
    }
    lastTranscriptScrollTopRef.current = target;
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

  function resumeTranscriptFollow(force = false) {
    if (!force && (hasNewerRef.current || olderLoadingRef.current || pageAnchorRef.current)) return;
    followBottomRef.current = true;
    scheduleTranscriptPin();
  }

  /** 工具结果仅作为刷新信号，计划栏始终读取当前会话的任务文档。 */
  const windowTodoDetails = useMemo<TodoDetails | undefined>(() => {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];
      const details = message.role === 'toolResult' && message.toolName === 'todo' ? message.details : undefined;
      if (details && typeof details === 'object' && Array.isArray((details as TodoDetails).tasks)) return details as TodoDetails;
    }
    return undefined;
  }, [messages]);

  // The composer plan belongs to the conversation, not the paged transcript.
  const [plan, setPlan] = useState<{ session: string; details?: TodoDetails } | null>(null);
  useEffect(() => {
    if (!sessionId) return;
    let disposed = false;
    void window.piApi.conversationTodo(sessionId).then(details => {
      if (!disposed) setPlan({ session: sessionId, details });
    }).catch(() => { /* Preserve the last authoritative plan on a transient failure. */ });
    return () => { disposed = true; };
  }, [sessionId, busy, windowTodoDetails]);
  const todoDetails = plan && plan.session === sessionId ? plan.details : undefined;

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
  turnsRef.current = transcriptTurns;
  const turnWindowFrom = 0;
  const visibleTurns = transcriptTurns;

  function capturePageAnchor() {
    const root = scrollRef.current;
    if (!root) return [];
    const rect = root.getBoundingClientRect();
    const nodes = Array.from(root.querySelectorAll<HTMLElement>('.messages > [id]'));
    const visible = nodes.filter(node => {
      const box = node.getBoundingClientRect();
      return box.bottom > rect.top && box.top < rect.bottom;
    });
    pageAnchorRef.current = {
      session: windowSession,
      anchors: visible
        .map(node => ({ id: node.id, offset: node.getBoundingClientRect().top - rect.top })),
    };
    return visible.map(node => Number(node.id.split('-').at(-1))).filter(Number.isFinite);
  }

  async function loadWithAnchor(direction: 'older' | 'newer') {
    if (direction === 'newer' && !hasNewerRef.current) return;
    const load = direction === 'older' ? onLoadOlderRef.current : onLoadNewerRef.current;
    if (!scrollRef.current || !load || olderLoadingRef.current || jumpingRef.current) return;
    pageIntentRef.current = null;
    olderLoadingRef.current = true;
    pauseTranscriptFollow();
    try {
      // Measure after the request completes, immediately before applying it.
      // Capturing at request start loses any wheel movement during the wait.
      const loaded = await load(capturePageAnchor);
      if (!loaded) pageAnchorRef.current = null;
      // Keep auto-follow disabled until React has committed and compensated.
      await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    } finally {
      olderLoadingRef.current = false;
    }
  }

  useLayoutEffect(() => {
    const anchor = pageAnchorRef.current;
    const root = scrollRef.current;
    if (!anchor || !root || anchor.session !== windowSession) return;
    pageAnchorRef.current = null;
    for (const item of anchor.anchors) {
      const node = document.getElementById(item.id);
      if (!node || !root.contains(node)) continue;
      root.scrollTop += node.getBoundingClientRect().top - root.getBoundingClientRect().top - item.offset;
      break;
    }
    pageIntentRef.current = null;
    programmedTopRef.current = root.scrollTop;
    lastTranscriptScrollTopRef.current = root.scrollTop;
  }, [messages[0]?.sourceIndex, messages[0]?.sourceOffset, messages.at(-1)?.sourceIndex, messages.at(-1)?.sourceOffset, windowSession]);

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
    const atLatest = !hasNewerRef.current && isNearBottom({
      scrollTop: container.scrollTop,
      clientHeight: container.clientHeight,
      scrollHeight: container.scrollHeight,
    });
    if (atLatest && outlineItems.length > 0) {
      const latest = outlineItems.length - 1;
      setOutlineActive((current) => (current === latest ? current : latest));
      return;
    }
    const top = container.getBoundingClientRect().top + 14;
    const nodes = Array.from(container.querySelectorAll<HTMLElement>('.messages > [id]'))
      .filter((node) => /^chat-(?:assistant-)?turn-\d+$/.test(node.id));
    if (nodes.length === 0) {
      const resolved = outlineIndexAt(outlineItems, messages[0]?.sourceIndex);
      if (resolved >= 0) setOutlineActive(resolved);
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
    const sourceIndex = Number(activeNode.id.split('-').at(-1));
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
    if (outlineSyncRef.current !== null) return;
    outlineSyncRef.current = window.setTimeout(() => {
      outlineSyncRef.current = null;
      syncOutlineActive();
    }, 80);
  }

  /** 只有明确的用户滚动意图才能离开或重新进入贴底跟随。 */
  function handleTranscriptScroll(event: React.UIEvent<HTMLDivElement>) {
    const node = event.currentTarget;
    const nextTop = node.scrollTop;
    const programmedTop = programmedTopRef.current;
    programmedTopRef.current = null;
    if (programmedTop !== null && Math.abs(nextTop - programmedTop) < 1) {
      lastTranscriptScrollTopRef.current = nextTop;
      scheduleOutlineSync();
      return;
    }

    if (userScrollIntentRef.current && pageIntentRef.current && !jumpingRef.current) {
      const moved = nextTop - lastTranscriptScrollTopRef.current;
      if (pageIntentRef.current === 'unknown' && Math.abs(moved) > 0.5) {
        pageIntentRef.current = moved < 0 ? 'older' : 'newer';
      }
      if (pageIntentRef.current === 'older' && nextTop < 240) void loadWithAnchor('older');
      else if (pageIntentRef.current === 'newer' && node.scrollHeight - nextTop - node.clientHeight < 240) void loadWithAnchor('newer');
    }
    const nextFollow = resolveAutoFollow({
      following: followBottomRef.current,
      nearBottom: !hasNewer && !olderLoadingRef.current && !pageAnchorRef.current && isNearBottom(node),
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

  /**
   * Keep message navigation inside the transcript viewport.
   *
   * `Element.scrollIntoView()` walks all scrollable ancestors. In the desktop
   * shell that can move the app card itself when a target is outside the
   * current render window, which makes the wallpaper and top gutter jump. The
   * transcript is the only owner of vertical scrolling, so calculate the
   * target position relative to it and scroll that element directly.
   */
  function scrollMessageIntoView(node: HTMLElement, behavior: ScrollBehavior = 'auto') {
    const container = scrollRef.current;
    if (!container) return false;
    const containerRect = container.getBoundingClientRect();
    const nodeRect = node.getBoundingClientRect();
    const nodeTop = container.scrollTop + nodeRect.top - containerRect.top;
    const targetTop = nodeTop - Math.max(0, (container.clientHeight - nodeRect.height) / 2);
    const maxTop = Math.max(0, container.scrollHeight - container.clientHeight);
    container.scrollTo({ top: Math.min(maxTop, Math.max(0, targetTop)), behavior });
    programmedTopRef.current = container.scrollTop;
    lastTranscriptScrollTopRef.current = container.scrollTop;
    return true;
  }

  /**
   * 跳到某条消息（按 sourceIndex，也就是 Durable entry id）。
   *
   * 目标未加载时直接读取附近窗口，提交后仅定位内部滚动区。
   */
  async function jumpToMessage(sourceIndex: number): Promise<boolean> {
    // A pending prepend must not compensate a later direct jump with its old
    // scroll height snapshot.
    pauseTranscriptFollow();
    pageAnchorRef.current = null;
    pageIntentRef.current = null;
    jumpingRef.current = true;
    try {
      const locate = () => turnsRef.current.findIndex((turn) => (
        turn.kind === 'user'
          ? turn.message.sourceIndex === sourceIndex
          : turn.messages.some((message) => message.sourceIndex === sourceIndex)
      ));
      let target = locate();
      if (target < 0 && onLoadTarget) {
        const loaded = await onLoadTarget(sourceIndex);
        if (!loaded) return false;
        await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
        target = locate();
      }
      if (target < 0) return false;
      const turn = turnsRef.current[target];
      const anchorIndex = turn.kind === 'user' ? turn.message.sourceIndex : turn.messages[0]?.sourceIndex;
      const node = anchorIndex === undefined
        ? null
        : document.getElementById(`chat-turn-${anchorIndex}`) ?? document.getElementById(`chat-assistant-turn-${anchorIndex}`);
      if (!node) return false;
      scrollMessageIntoView(node);
      const resolvedOutlineIndex = outlineIndexAt(outlineItems, sourceIndex);
      if (resolvedOutlineIndex >= 0) setOutlineActive(resolvedOutlineIndex);
      // 短暂高亮，避免在一大段输出里找不到落点。
      node.classList.add('is-search-hit');
      window.setTimeout(() => node.classList.remove('is-search-hit'), 1600);
      return true;
    } finally {
      jumpingRef.current = false;
    }
  }

  /** 跳到某条提问：与搜索走同一条路径，都按 sourceIndex 定位并自动补页。 */
  async function jumpToOutline(index: number) {
    const item = outlineItems[index];
    if (!item) return;
    // 大纲与搜索走同一条跳转路径：都按 sourceIndex 定位并自动补页。
    const reached = await jumpToMessage(item.sourceIndex);
    if (!reached) showComposerFeedback('没能定位到这条提问，可能已经被编辑替换。');
  }

  useLayoutEffect(() => {
    // 消息提交后先在绘制前贴底；Markdown、图片或折叠区随后长高时，
    // ResizeObserver 会继续补一次，避免输出中途停在半截。
    if (agentView.kind !== 'conversation' || !followBottomRef.current) return;
    // Coalesce the commit with the ResizeObserver pass.  React can commit a
    // streamed token before markdown has finished settling its final height;
    // pinning synchronously here and once more from the observer causes two
    // competing scroll writes in one frame, which is perceived as jitter.
    scheduleTranscriptPin();
  }, [messages, busy, agentView.kind]);

  useEffect(() => {
    if (agentView.kind !== 'conversation' || messages.length === 0) return;
    const content = chatContentRef.current;
    const viewport = scrollRef.current;
    if (!content || !viewport || typeof ResizeObserver === 'undefined') return;
    resizeMetricsRef.current = {
      viewportHeight: viewport.clientHeight,
      contentHeight: content.scrollHeight,
    };
    const observer = new ResizeObserver(() => {
      const previous = resizeMetricsRef.current;
      const next = {
        viewportHeight: viewport.clientHeight,
        contentHeight: content.scrollHeight,
      };
      resizeMetricsRef.current = next;
      if (!followBottomRef.current || !previous) return;

      const viewportDelta = previous.viewportHeight - next.viewportHeight;
      const contentChanged = Math.abs(next.contentHeight - previous.contentHeight) > 0.5;
      const wasNearBottom = isNearBottom({
        scrollTop: viewport.scrollTop,
        clientHeight: previous.viewportHeight,
        scrollHeight: previous.contentHeight,
      });

      // A composer/editor resize only changes the visible viewport. Preserve
      // the bottom edge by the exact lost/gained height; do not write the
      // absolute bottom position, which races the streaming content update and
      // makes the transcript visibly jump while typing.
      if (wasNearBottom && !contentChanged && Math.abs(viewportDelta) > 0.5) {
        viewport.scrollTop = Math.max(0, viewport.scrollTop + viewportDelta);
        lastTranscriptScrollTopRef.current = viewport.scrollTop;
        programmedTopRef.current = viewport.scrollTop;
        return;
      }

      // Markdown, images, tool traces and disclosure rows can change the
      // transcript's natural height. Those updates still need the normal
      // coalesced follow-to-bottom pass while the reader is following live
      // output.
      if (contentChanged) scheduleTranscriptPin();
    });
    observer.observe(content);
    observer.observe(viewport);
    return () => {
      observer.disconnect();
      resizeMetricsRef.current = null;
    };
  }, [agentView.kind, sessionId, messages.length === 0]);

  useEffect(() => () => {
    if (pageIntentFrameRef.current) cancelAnimationFrame(pageIntentFrameRef.current);
    if (autoScrollFrameRef.current) cancelAnimationFrame(autoScrollFrameRef.current);
    if (scrollIntentTimerRef.current !== null) window.clearTimeout(scrollIntentTimerRef.current);
    if (outlineSyncRef.current !== null) window.clearTimeout(outlineSyncRef.current);
  }, []);

  useEffect(() => {
    const frame = requestAnimationFrame(syncOutlineActive);
    return () => cancelAnimationFrame(frame);
  }, [messages.length, messages[0]?.sourceIndex, messages.at(-1)?.sourceIndex, sessionId, filesOpen, outlineItems.length]);

  return {
    scrollRef,
    topSentinelRef,
    bottomSentinelRef,
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
