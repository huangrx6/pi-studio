export type ComposerSubmitAction = 'send' | 'steer' | 'queue' | 'none';

export type ComposerEnterInput = {
  key: string;
  shiftKey: boolean;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  isComposing: boolean;
  busy: boolean;
};

export type ComposerKeyAction = ComposerSubmitAction | 'previous' | 'next' | 'select' | 'close' | 'wait';

/** Candidate navigation must not steal IME keys or modified text-entry shortcuts. */
export function composerKeyAction(input: ComposerEnterInput & { menuOpen: boolean; optionCount: number; pending?: boolean }): ComposerKeyAction {
  if (input.isComposing) return 'none';
  const modified = input.metaKey || input.ctrlKey || input.altKey || input.shiftKey;
  if (input.menuOpen && !modified) {
    if (input.key === 'Escape') return 'close';
    if (input.optionCount > 0) {
      if (input.key === 'ArrowUp') return 'previous';
      if (input.key === 'ArrowDown') return 'next';
      if (input.key === 'Enter' || input.key === 'Tab') return 'select';
    }
    if (input.key === 'Enter' && input.pending) return 'wait';
  }
  return composerSubmitAction(input);
}

/**
 * Keep the composer keyboard contract deterministic:
 * - Enter sends, or supplements the active task without stopping it.
 * - Cmd/Ctrl+Enter queues the current draft for the next turn.
 * - Shift+Enter remains available for browser-native line insertion.
 */
export function composerSubmitAction(input: ComposerEnterInput): ComposerSubmitAction {
  if (input.key !== 'Enter' || input.isComposing || input.altKey || input.shiftKey) {
    return 'none';
  }
  if (input.metaKey || input.ctrlKey) return input.busy ? 'queue' : 'send';
  return input.busy ? 'steer' : 'send';
}
