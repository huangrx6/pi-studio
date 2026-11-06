import { useEffect, useRef, type KeyboardEvent } from 'react';
import { isComposingKey } from './keyboard-navigation';

/** One focus lifecycle for settings forms and resource details, including nested dialogs. */
export function useModalDialog() {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const composingEscape = useRef(false);

  useEffect(() => {
    const dialog = dialogRef.current!;
    const previous = document.activeElement as HTMLElement | null;
    // Chromium can dispatch a trusted native cancel even when Escape belongs to IME.
    // Suppress that cancellation only; let the IME receive its normal key default.
    const onCancel = (event: Event) => {
      if (!composingEscape.current) return;
      composingEscape.current = false;
      event.preventDefault();
      event.stopImmediatePropagation();
    };
    dialog.addEventListener('cancel', onCancel, true);
    dialog.showModal();
    return () => {
      dialog.removeEventListener('cancel', onCancel, true);
      const active = document.activeElement;
      const restore = active === document.body || active === dialog || dialog.contains(active);
      dialog.close();
      if (restore && previous?.isConnected) previous.focus({ preventScroll: true });
    };
  }, []);

  function onKeyDown(event: KeyboardEvent<HTMLDialogElement>) {
    if (event.defaultPrevented) return;
    // React portal events can bubble through an outer dialog; only the owner traps focus.
    if ((event.target as Element).closest('dialog') !== dialogRef.current) return;
    composingEscape.current = event.key === 'Escape' && isComposingKey(event.nativeEvent);
    if (isComposingKey(event.nativeEvent)) return;
    if (event.key === 'Escape') {
      event.stopPropagation();
      return;
    }
    if (event.key !== 'Tab') return;
    const dialog = dialogRef.current!;
    const focusable = [...dialog.querySelectorAll<HTMLElement>(
      'a[href], button:not(:disabled), input:not(:disabled):not([type="hidden"]), select:not(:disabled), textarea:not(:disabled), details > summary:first-of-type, [tabindex]',
    )].filter((element) => element.tabIndex >= 0 && !element.matches(':disabled') && element.getClientRects().length > 0);
    if (!focusable.length) {
      event.preventDefault();
      dialog.focus();
      return;
    }
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const active = document.activeElement;
    if (event.shiftKey && (active === first || !focusable.includes(active as HTMLElement))) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && (active === last || !focusable.includes(active as HTMLElement))) {
      event.preventDefault();
      first.focus();
    }
  }

  return { dialogRef, onKeyDown };
}
