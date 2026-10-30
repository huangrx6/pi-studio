export type ComposerSubmitAction = 'send' | 'steer' | 'queue' | 'none';

type ComposerEnterInput = {
  key: string;
  shiftKey: boolean;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  isComposing: boolean;
  busy: boolean;
};

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
