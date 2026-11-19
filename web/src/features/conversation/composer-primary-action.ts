export type ComposerPrimaryAction = 'send' | 'stop' | 'queue' | 'preparing' | 'stopping';

/**
 * Single trailing composer control:
 * - idle → send
 * - live turn, empty draft → stop
 * - live turn, typed follow-up → queue
 * - preparing / stopping keep a stable non-dispatch state
 */
export function resolveComposerPrimaryAction(input: {
  running: boolean;
  stopping: boolean;
  preparing?: boolean;
  hasContent: boolean;
}): ComposerPrimaryAction {
  if (input.stopping) return 'stopping';
  if (input.preparing) return 'preparing';
  if (input.running) return input.hasContent ? 'queue' : 'stop';
  return 'send';
}
