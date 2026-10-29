/**
 * History pagination starts before the user reaches the literal top, then stays
 * disarmed until they deliberately move back into the conversation.
 */
export const HISTORY_PAGE_SIZE = 200;
export const HISTORY_LOAD_DISTANCE = 320;
export const HISTORY_REARM_DISTANCE = 520;

/**
 * @typedef {object} HistoryScrollInput
 * @property {number} scrollTop
 * @property {boolean} armed
 * @property {boolean} hasMore
 * @property {boolean} loading
 * @property {boolean} userInitiated
 */

/**
 * @param {HistoryScrollInput} input
 * @returns {{ armed: boolean, load: boolean }}
 */
export function resolveHistoryScroll({ scrollTop, armed, hasMore, loading, userInitiated }) {
  if (!hasMore) return { armed: false, load: false };
  if (loading) return { armed, load: false };
  if (scrollTop <= HISTORY_LOAD_DISTANCE) {
    return armed ? { armed: false, load: true } : { armed: false, load: false };
  }
  if (scrollTop >= HISTORY_REARM_DISTANCE && userInitiated) return { armed: true, load: false };
  return { armed, load: false };
}
