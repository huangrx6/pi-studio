export type TemporaryChatSubmissionState = {
  draft: string;
  imageCount: number;
  modelRef: string;
  unavailable?: boolean;
  busy?: boolean;
};

/** A temporary prompt needs a usable model and actual user content. */
export function temporaryChatCanSubmit(input: TemporaryChatSubmissionState): boolean {
  return !input.busy
    && Boolean(input.modelRef)
    && !input.unavailable
    && Boolean(input.draft.trim() || input.imageCount > 0);
}

/** Enter sends; Shift+Enter and every IME-owned key remain native text input. */
export function temporaryChatEnterAction(
  input: TemporaryChatSubmissionState & {
    key: string;
    shiftKey?: boolean;
    altKey?: boolean;
    isComposing?: boolean;
    keyCode?: number;
  },
): 'send' | 'none' {
  if (input.key !== 'Enter' || input.shiftKey || input.altKey || input.isComposing || input.keyCode === 229) return 'none';
  return temporaryChatCanSubmit(input) ? 'send' : 'none';
}
