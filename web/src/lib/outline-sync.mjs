/**
 * 大纲与消息窗口的对齐。
 *
 * 大纲条目和消息都用 `sourceIndex`（Durable entry id）标识，而不是“第几条消息”。
 * 两者只有在窗口完整时才一一对应，所以映射一律按 id 比较：滚动时找“最后一条已读过
 * 的提问”，跳转时找“不超过目标的最近条目”，都不假设消息已全部加载。
 */

/**
 * 最后一个 `sourceIndex` 不超过 `sourceIndex` 的条目下标；没有更早的条目时返回 -1。
 * 条目按 `sourceIndex` 升序排列（服务端按 entry 顺序扫描）。
 */
export function outlineIndexAt(items, sourceIndex) {
  const list = Array.isArray(items) ? items : [];
  const target = Number(sourceIndex);
  if (!Number.isFinite(target) || list.length === 0) return -1;
  let low = 0;
  let high = list.length - 1;
  let found = -1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    const value = Number(list[middle]?.sourceIndex);
    if (Number.isFinite(value) && value <= target) {
      found = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return found;
}

/** 窗口里最靠后、且能在大纲中定位到的提问下标。 */
export function outlineIndexForMessages(items, messages) {
  const list = Array.isArray(messages) ? messages : [];
  for (let index = list.length - 1; index >= 0; index -= 1) {
    const message = list[index];
    if (message?.role !== 'user') continue;
    const resolved = outlineIndexAt(items, message.sourceIndex);
    if (resolved >= 0) return resolved;
  }
  return -1;
}
