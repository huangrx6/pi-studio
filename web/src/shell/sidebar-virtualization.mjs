/** Fixed-height session rows; workspace headings retain normal document flow. */
export const SIDEBAR_VIRTUAL_THRESHOLD = 80;
export const SIDEBAR_OVERSCAN = 6;

/**
 * @param {number} count
 * @param {number} scrollTop
 * @param {number} viewportHeight
 * @param {number} groupTop
 * @param {number} rowHeight
 * @param {number[]} retainedIndices
 */
export function visibleSessionIndices(count, scrollTop, viewportHeight, groupTop, rowHeight, retainedIndices = []) {
  if (count <= SIDEBAR_VIRTUAL_THRESHOLD) return Array.from({ length: count }, (_, index) => index);
  const height = Math.max(1, rowHeight);
  const start = Math.max(0, Math.min(count, Math.floor((scrollTop - groupTop) / height) - SIDEBAR_OVERSCAN));
  const end = Math.max(0, Math.min(count, Math.ceil((scrollTop + viewportHeight - groupTop) / height) + SIDEBAR_OVERSCAN));
  const indices = new Set(retainedIndices.filter((index) => Number.isInteger(index) && index >= 0 && index < count));
  for (let index = start; index < end; index++) indices.add(index);
  return [...indices].sort((a, b) => a - b);
}

/** @param {number[]} indices @param {number} count */
export function sessionWindowSegments(indices, count) {
  /** @type {Array<{kind:'gap',from:number,count:number}|{kind:'row',index:number}>} */
  const segments = [];
  let cursor = 0;
  for (const index of indices) {
    if (index > cursor) segments.push({ kind: 'gap', from: cursor, count: index - cursor });
    segments.push({ kind: 'row', index });
    cursor = index + 1;
  }
  if (cursor < count) segments.push({ kind: 'gap', from: cursor, count: count - cursor });
  return segments;
}

/** @param {number} index @param {number} count */
export function focusNeighborIndices(index, count) {
  return [index - 1, index, index + 1].filter((value) => value >= 0 && value < count);
}
