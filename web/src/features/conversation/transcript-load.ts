import type { ChatMessage } from '../../types/chat-types';
import type { ConversationPage, TranscriptPageState } from '../../types/durable-types';

type LoadPage = Window['piApi']['conversationPage'];
type PageInfo = TranscriptPageState['page'];
type WindowOptions = { turnLimit?: number };
type Direction = 'older' | 'newer';

/**
 * 会话历史固定窗口加载。
 *
 * 大纲保存完整的稳定消息 ID；正文只请求并渲染当前窗口，避免长会话把全部消息
 * 放进渲染层。向上滚动和跳转都按窗口边界重新取数。
 */

/** 保留旧的完整扫描测试接口；正文窗口使用 TRANSCRIPT_WINDOW_TURNS。 */
export const TRANSCRIPT_PAGE_SIZE = 2_000;

/** 防御性上限：即使主进程一直返回游标，也不会无限循环。 */
const MAX_PAGES = 64;

/** 读取整段会话历史，返回结构与单页响应一致，只是消息已经合并完整。 */
export async function loadFullTranscript(loadPage: LoadPage, id: string) {
  let page;
  let cursor: string | undefined;
  let messages: ChatMessage[] = [];
  for (let index = 0; index < MAX_PAGES; index += 1) {
    page = await loadPage(cursor ? { id, limit: TRANSCRIPT_PAGE_SIZE, cursor } : { id, limit: TRANSCRIPT_PAGE_SIZE });
    if (!page) return undefined;
    // 每页内部按时间正序，越早的页越靠前。
    messages = [...page.messages, ...messages];
    if (!page.page?.hasOlder || !page.page.nextCursor) break;
    cursor = page.page.nextCursor;
  }
  if (!page) return undefined;
  return {
    ...page,
    messages,
    page: { hasOlder: false },
    // 最早一页的起点，用来在没有大纲数据时推算提问的序号。
    messageStart: page.messageStart ?? messages[0]?.sourceIndex ?? 0,
  };
}

/**
 * 首次打开会话时载入的消息窗口。
 *
 * 大会话只取最近这一段，更早的内容在滚到顶时按游标补入并裁掉远端。
 */
export const TRANSCRIPT_WINDOW_TURNS = 8;
/** 相邻窗口每次只移动一小段，保留重叠内容，避免整页 DOM 一次性替换。 */
export const TRANSCRIPT_ADJACENT_TURNS = 3;

/** 读取最近一页历史，保留分页游标供后续补页。 */
export async function loadTranscriptWindow(loadPage: LoadPage, id: string, options: WindowOptions = {}) {
  const turnLimit = options.turnLimit ?? TRANSCRIPT_WINDOW_TURNS;
  const page = await loadPage({ id, turnLimit });
  if (!page) return undefined;
  return {
    ...page,
    messages: page.messages,
    page: page.page ?? { hasOlder: false },
    messageStart: page.messageStart ?? page.messages[0]?.sourceIndex ?? 0,
  };
}

/**
 * 只取更早的一页，不做合并。
 *
 * 渲染层用函数式 setState 把它插到当前消息前面，加载期间新到的流式消息不会丢。
 */
export async function loadOlderPage(loadPage: LoadPage, id: string, page: PageInfo | undefined, options: WindowOptions = {}) {
  const cursor = page?.olderCursor ?? page?.nextCursor;
  if (!cursor) return null;
  const turnLimit = options.turnLimit ?? TRANSCRIPT_WINDOW_TURNS;
  const older = await loadPage({ id, turnLimit, cursor });
  if (!older) return null;
  return {
    messages: older.messages,
    page: older.page ?? { hasOlder: false },
    messageStart: older.messageStart ?? older.messages[0]?.sourceIndex ?? 0,
  };
}

/**
 * 往前补一页历史，返回合并后的完整结构。
 *
 * 没有更早的内容或主进程未返回时返回 null，调用方据此停止重复请求。
 */
export async function loadOlderTranscript(loadPage: LoadPage, id: string, current: ConversationPage, options: WindowOptions = {}) {
  const older = await loadOlderPage(loadPage, id, current?.page, options);
  if (!older) return null;
  return {
    ...current,
    messages: [...older.messages, ...current.messages],
    page: older.page,
    messageStart: older.messageStart,
  };
}

/** Stable identity and bounded merge helpers for the in-memory transcript window. */
export function messageKey(message: ChatMessage) {
  return (message.sourceIndex ?? 0) > 0
    ? `${message.sourceIndex}:${message.sourceOffset ?? 0}`
    : `${message.role}:${message.toolCallId ?? message.timestamp}`;
}
export function messagePosition(message: ChatMessage) {
  return { entryId: message.sourceIndex, offset: message.sourceOffset ?? 0 };
}

export const TRANSCRIPT_MAX_TURNS = 12;
export const TRANSCRIPT_MAX_BYTES = 8 * 1024 * 1024;
export function trimTranscript(messages: ChatMessage[], edge: 'latest' | 'oldest' = 'latest', protectedSources: number[] = []) {
  const rounds: ChatMessage[][] = [];
  for (const message of messages) {
    if (!rounds.length || message.role === 'user') rounds.push([]);
    rounds[rounds.length - 1].push(message);
  }
  const protectedSet = new Set(protectedSources);
  const protectedRounds = rounds.map((round, index) => (
    round.some(message => message.sourceIndex !== undefined && protectedSet.has(message.sourceIndex)) ? index : -1
  )).filter(index => index >= 0);
  // Build the preferred bounded window, then retain every visible round.
  // A large round may exceed the soft byte budget; it must not evict the
  // reader's current round just because the next page contains big tool output.
  const ordered = edge === 'latest' ? [...rounds].reverse() : rounds;
  let count = 0;
  let bytes = 0;
  for (const round of ordered) {
    const size = JSON.stringify(round).length * 2;
    if (count && (count >= TRANSCRIPT_MAX_TURNS || bytes + size > TRANSCRIPT_MAX_BYTES)) break;
    count += 1;
    bytes += size;
  }
  let start = edge === 'latest' ? rounds.length - count : 0;
  let end = edge === 'latest' ? rounds.length : count;
  if (protectedRounds.length) {
    start = Math.min(start, protectedRounds[0]);
    end = Math.max(end, protectedRounds[protectedRounds.length - 1] + 1);
    // Leave room beyond the viewport even when many short rounds fit on one
    // screen; otherwise protecting them would prevent paging from advancing.
    const capacity = Math.max(TRANSCRIPT_MAX_TURNS, protectedRounds[protectedRounds.length - 1] - protectedRounds[0] + 1 + TRANSCRIPT_ADJACENT_TURNS);
    if (end - start > capacity) {
      if (edge === 'latest') end = start + capacity;
      else start = end - capacity;
    }
  }
  return rounds.slice(start, end).flat();
}

export function mergeTranscriptPage(current: ChatMessage[], incoming: ChatMessage[], direction: Direction, protectedSources: number[] = []) {
  const combined = direction === 'older' ? [...incoming, ...current] : [...current, ...incoming];
  const seen = new Set();
  const unique = combined.filter(message => { const key = messageKey(message); if (seen.has(key)) return false; seen.add(key); return true; });
  return trimTranscript(unique, direction === 'older' ? 'oldest' : 'latest', protectedSources);
}
export async function loadAdjacentPage(loadPage: LoadPage, id: string, messages: ChatMessage[], page: PageInfo | undefined, direction: Direction) {
  const older = direction === 'older';
  if (older ? !page?.hasOlder : !page?.hasNewer) return null;
  const boundary = older ? messages[0] : [...messages].reverse().find(message => (message.sourceIndex ?? 0) > 0);
  if (!boundary) return null;
  const { entryId, offset } = messagePosition(boundary);
  if (entryId === undefined || entryId <= 0) return null;
  return loadPage({ id, turnLimit: TRANSCRIPT_ADJACENT_TURNS, [older ? 'before' : 'after']: { entryId, offset } });
}
