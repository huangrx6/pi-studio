/** Fixed-height session rows; workspace headings retain normal document flow. */
export const SIDEBAR_VIRTUAL_THRESHOLD = 80;
export const SIDEBAR_OVERSCAN = 6;

/** Shallow map equality for group scroll offsets without JSON serialization. */
export function sidebarGroupsEqual(a: Record<string, number>, b: Record<string, number>) {
  if (a === b) return true;
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  for (const key of keys) {
    if (a[key] !== b[key]) return false;
  }
  return true;
}

export function visibleSessionIndices(count: number, scrollTop: number, viewportHeight: number, groupTop: number, rowHeight: number, retainedIndices: number[] = []) {
  if (count <= SIDEBAR_VIRTUAL_THRESHOLD) return Array.from({ length: count }, (_, index) => index);
  const height = Math.max(1, rowHeight);
  const start = Math.max(0, Math.min(count, Math.floor((scrollTop - groupTop) / height) - SIDEBAR_OVERSCAN));
  const end = Math.max(0, Math.min(count, Math.ceil((scrollTop + viewportHeight - groupTop) / height) + SIDEBAR_OVERSCAN));
  const indices = new Set(retainedIndices.filter((index) => Number.isInteger(index) && index >= 0 && index < count));
  for (let index = start; index < end; index++) indices.add(index);
  return [...indices].sort((a, b) => a - b);
}

export function sessionWindowSegments(indices: number[], count: number) {
  const segments: Array<{ kind: 'gap'; from: number; count: number } | { kind: 'row'; index: number }> = [];
  let cursor = 0;
  for (const index of indices) {
    if (index > cursor) segments.push({ kind: 'gap', from: cursor, count: index - cursor });
    segments.push({ kind: 'row', index });
    cursor = index + 1;
  }
  if (cursor < count) segments.push({ kind: 'gap', from: cursor, count: count - cursor });
  return segments;
}

export function focusNeighborIndices(index: number, count: number) {
  return [index - 1, index, index + 1].filter((value) => value >= 0 && value < count);
}
