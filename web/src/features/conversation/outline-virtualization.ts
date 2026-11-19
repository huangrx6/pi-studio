/** Fixed-height outline ticks; large histories only mount the visible band. */
export const OUTLINE_VIRTUAL_THRESHOLD = 64;
export const OUTLINE_OVERSCAN = 10;
/** Matches .outline-tick height in 08-conversation-details.css (10px default). */
export const OUTLINE_ROW_HEIGHT = 10;

export function visibleOutlineRange(
  count: number,
  scrollTop: number,
  viewportHeight: number,
  rowHeight = OUTLINE_ROW_HEIGHT,
  overscan = OUTLINE_OVERSCAN,
): { start: number; end: number } {
  if (count <= 0) return { start: 0, end: 0 };
  if (count <= OUTLINE_VIRTUAL_THRESHOLD) return { start: 0, end: count };
  const height = Math.max(1, rowHeight);
  const start = Math.max(0, Math.min(count, Math.floor(scrollTop / height) - overscan));
  const end = Math.max(start, Math.min(count, Math.ceil((scrollTop + viewportHeight) / height) + overscan));
  return { start, end };
}
