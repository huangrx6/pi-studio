/**
 * 会话历史一次性载入。
 *
 * 主进程仍按页返回历史（单页上限 2000 条），这里把分页循环收在一起：
 * 打开会话时一直读到没有更早的消息为止，界面只拿到一份完整记录。
 * 这样大纲、搜索和跳转都作用在同一份数据上，不需要再“点一下才补一页”。
 */

/** 主进程单页上限，与 conversations.cjs 的 MAX_PAGE_SIZE 保持一致。 */
export const TRANSCRIPT_PAGE_SIZE = 2_000;

/** 防御性上限：即使主进程一直返回游标，也不会无限循环。 */
const MAX_PAGES = 64;

/**
 * 一页历史：消息按时间正序，`page.hasOlder` 表示前面是否还有更早的内容。
 *
 * @typedef {object} TranscriptPage
 * @property {Array<any>} messages
 * @property {{ hasOlder?: boolean, nextCursor?: string }} [page]
 * @property {number} [messageStart]
 */

/**
 * 读取整段会话历史，返回结构与单页响应一致，只是消息已经合并完整。
 *
 * @template {TranscriptPage} T
 * @param {(payload: { id: string, limit: number, cursor?: string }) => Promise<T | undefined>} loadPage
 * @param {string} id 会话 id
 * @returns {Promise<T | undefined>}
 */
export async function loadFullTranscript(loadPage, id) {
  let page; let cursor; let messages = [];
  for (let index = 0; index < MAX_PAGES; index += 1) {
    page = await loadPage(cursor ? { id, limit: TRANSCRIPT_PAGE_SIZE, cursor } : { id, limit: TRANSCRIPT_PAGE_SIZE });
    if (!page) return undefined;
    // 每页内部按时间正序，越早的页越靠前。
    messages = [...page.messages, ...messages];
    if (!page.page?.hasOlder || !page.page.nextCursor) break;
    cursor = page.page.nextCursor;
  }
  if (!page) return undefined;
  /* @type {T} */
  const merged = /** @type {T} */ ({
    ...page,
    messages,
    page: { hasOlder: false },
    // 最早一页的起点，用来在没有大纲数据时推算提问的序号。
    messageStart: page.messageStart ?? messages[0]?.sourceIndex ?? 0,
  });
  return merged;
}

/**
 * 首次打开会话时载入的消息窗口。
 *
 * 大会话可能有几千条、上百 MB，整段读进渲染层会直接吃掉几百 MB 堆内存。
 * 只取最近这一段，更早的内容在滚到顶时用 {@link loadOlderTranscript} 补。
 */
export const TRANSCRIPT_WINDOW_SIZE = 200;

/**
 * 读取最近一页历史，保留分页游标供后续补页。
 *
 * @template {TranscriptPage} T
 * @param {(payload: { id: string, limit: number, cursor?: string }) => Promise<T | undefined>} loadPage
 * @param {string} id 会话 id
 * @param {{ limit?: number }} [options]
 * @returns {Promise<T | undefined>}
 */
export async function loadTranscriptWindow(loadPage, id, options = {}) {
  const limit = options.limit ?? TRANSCRIPT_WINDOW_SIZE;
  const page = await loadPage({ id, limit });
  if (!page) return undefined;
  return /** @type {T} */ ({
    ...page,
    messages: page.messages,
    page: page.page ?? { hasOlder: false },
    messageStart: page.messageStart ?? page.messages[0]?.sourceIndex ?? 0,
  });
}

/**
 * 只取更早的一页，不做合并。
 *
 * 渲染层用函数式 setState 把它插到当前消息前面，加载期间新到的流式消息不会丢。
 *
 * @template {TranscriptPage} T
 * @param {(payload: { id: string, limit: number, cursor?: string }) => Promise<T | undefined>} loadPage
 * @param {string} id 会话 id
 * @param {{ hasOlder?: boolean, nextCursor?: string } | undefined} page 当前窗口的分页信息
 * @param {{ limit?: number }} [options]
 * @returns {Promise<{ messages: Array<any>, page: { hasOlder?: boolean, nextCursor?: string }, messageStart: number } | null>}
 */
export async function loadOlderPage(loadPage, id, page, options = {}) {
  const cursor = page?.nextCursor;
  if (!cursor) return null;
  const limit = options.limit ?? TRANSCRIPT_WINDOW_SIZE;
  const older = await loadPage({ id, limit, cursor });
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
 *
 * @template {TranscriptPage} T
 * @param {(payload: { id: string, limit: number, cursor?: string }) => Promise<T | undefined>} loadPage
 * @param {string} id 会话 id
 * @param {T} current 当前已经载入的窗口
 * @param {{ limit?: number }} [options]
 * @returns {Promise<T | null>}
 */
export async function loadOlderTranscript(loadPage, id, current, options = {}) {
  const older = await loadOlderPage(loadPage, id, current?.page, options);
  if (!older) return null;
  return /** @type {T} */ ({
    ...current,
    messages: [...older.messages, ...current.messages],
    page: older.page,
    messageStart: older.messageStart,
  });
}
