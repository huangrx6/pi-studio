import type { ComposerAttachment } from '../../types/chat-types';
import type { ComposerDraft } from './composer-drafts';

/** Capture immutable comparison values without serializing potentially large image data. */
export function snapshotComposerDraft(draft: ComposerDraft): ComposerDraft {
  return { text: draft.text, attachments: draft.attachments.map(attachment => ({ ...attachment })) };
}

function sameAttachment(left: ComposerAttachment, right: ComposerAttachment): boolean {
  const keys: (keyof ComposerAttachment)[] = ['id', 'kind', 'name', 'mime', 'bytes', 'data', 'path', 'lines', 'marker'];
  return keys.every(key => left[key] === right[key]);
}

/** Preparing an earlier draft must never consume later text, attachments or ordering. */
export function composerDraftMatches(current: ComposerDraft, original: ComposerDraft): boolean {
  return current.text === original.text
    && current.attachments.length === original.attachments.length
    && current.attachments.every((attachment, index) => sameAttachment(attachment, original.attachments[index]));
}

/**
 * Reuse a previously generated request id only when the user is retrying the
 * same exact draft. Edited content receives a new id and stays a distinct
 * Durable submission.
 */
export function retainedComposerRequestId(
  retry: { draft: ComposerDraft; requestId: string } | undefined,
  current: ComposerDraft,
): string | undefined {
  return retry && composerDraftMatches(current, retry.draft)
    ? retry.requestId
    : undefined;
}
