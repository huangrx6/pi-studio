/**
 * status.chip 的作用域：会话视图。
 *
 * chip 与会话标题同处一行，读的也是当前会话的实时数据；新会话还是草稿，
 * 没有 sessionId，扩展的数据源与详情面板都无从指认，因此不渲染任何 chip。
 * 需要「全局」入口的扩展应该用 `status.bar`，而不是把 chip 当全局按钮。
 */
export function scopedExtensionChips<T>(sessionId: string | undefined, chips: T[]): T[] {
  return sessionId ? chips : [];
}
