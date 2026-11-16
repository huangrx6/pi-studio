/**
 * Composer size limits.
 *
 * This module stays framework-free so the paste boundary can be tested directly.
 * The composer still inserts the user's pasted batch as one attachment; it never
 * moves earlier typed content into that attachment.
 */
export const LONG_MESSAGE_CHARS = 12_000;
export const LONG_MESSAGE_BYTES = 24_000;
export const LONG_MESSAGE_LINES = 240;

const encoder = new TextEncoder();

export function isLongMessage(text: string) {
  if (text.length > LONG_MESSAGE_CHARS) return true;
  if (text.split('\n').length > LONG_MESSAGE_LINES) return true;
  return encoder.encode(text).length > LONG_MESSAGE_BYTES;
}

/**
 * Decide whether a single paste would push the whole composer over its limit.
 * Existing text consumes the shared budget, while the saved attachment contains
 * only `pasted`.
 */
export function pasteExceedsBudget(base: string, pasted: string) {
  return isLongMessage(base + pasted);
}
