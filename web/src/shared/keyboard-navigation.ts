/** IME-owned keys must not activate application shortcuts or menu navigation. */
export function isComposingKey(event: { isComposing?: boolean; keyCode?: number }): boolean {
  return Boolean(event.isComposing || event.keyCode === 229);
}

let focusSource: 'pointer' | 'keyboard' | 'restore' = 'keyboard';

/** A sandboxed view can request dismissal without bubbling its Escape key to the host. */
export function restoreDismissedFocus(target: HTMLElement | null) {
  if (!target) return;
  focusSource = 'restore';
  target.focus({ preventScroll: true });
}

/** On Escape, give each control back the focus indication it had before opening a surface. */
export function trackDismissFocus() {
  const pointerTargets = new WeakSet<HTMLElement>();
  let marked: HTMLElement | null = null;
  const forcedColors = window.matchMedia('(forced-colors: active)');

  function update(target: EventTarget | null) {
    marked?.removeAttribute('data-pointer-dismiss');
    marked = null;
    if (!(target instanceof HTMLElement)) return;
    if (focusSource === 'pointer') pointerTargets.add(target);
    else if (focusSource === 'keyboard') pointerTargets.delete(target);
    else if (pointerTargets.has(target) && !target.matches(':read-write') && !forcedColors.matches) {
      marked = target;
      target.setAttribute('data-pointer-dismiss', '');
    }
  }

  const events = new AbortController();
  const capture = { capture: true, signal: events.signal };
  window.addEventListener('pointerdown', event => {
    focusSource = 'pointer';
    // Clicking the already-focused button does not dispatch another focusin.
    if (event.target instanceof Node && document.activeElement?.contains(event.target)) update(document.activeElement);
  }, capture);
  window.addEventListener('keydown', event => {
    if (isComposingKey(event) || ['Shift', 'Alt', 'Control', 'Meta'].includes(event.key)) return;
    focusSource = event.key === 'Escape' ? 'restore' : 'keyboard';
    update(document.activeElement);
  }, capture);
  // Native dialogs and animated popovers can restore focus well after keydown.
  window.addEventListener('focusin', event => update(event.target), capture);
  forcedColors.addEventListener('change', () => update(document.activeElement), { signal: events.signal });
  return () => { events.abort(); update(null); };
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
