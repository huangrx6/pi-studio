/** IME-owned keys must not activate application shortcuts or menu navigation. */
export function isComposingKey(event: { isComposing?: boolean; keyCode?: number }): boolean {
  return Boolean(event.isComposing || event.keyCode === 229);
}

/** Index among enabled controls. Empty menus deliberately have no focus target. */
export function menuFocusIndex(key: string, current: number, size: number, wrap = false): number | null {
  if (!size) return null;
  if (key === 'Home') return 0;
  if (key === 'End') return size - 1;
  if (key !== 'ArrowDown' && key !== 'ArrowUp') return null;
  if (current < 0) return key === 'ArrowUp' ? size - 1 : 0;
  const next = current + (key === 'ArrowDown' ? 1 : -1);
  return wrap ? (next + size) % size : Math.min(size - 1, Math.max(0, next));
}
