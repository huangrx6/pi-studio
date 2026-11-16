import type { QueuedPrompt } from './composer-types';

type Draft<T> = { text: string; attachments: T[] };

/**
 * Restore a rejected submission without replacing text the user typed while
 * the previous attempt was in flight. Attachments keep their stable ids so a
 * retry cannot duplicate the same pending file.
 */
export function mergeRejectedComposerDraft<T extends { id: string }>(current: Draft<T>, rejected: Draft<T>) {
  const text = rejected.text
    ? current.text
      ? `${rejected.text}${rejected.text.endsWith('\n') ? '\n' : '\n\n'}${current.text}`
      : rejected.text
    : current.text;
  const existing = new Set(rejected.attachments.map((attachment) => attachment.id));
  return {
    text,
    attachments: [
      ...rejected.attachments,
      ...current.attachments.filter((attachment) => !existing.has(attachment.id)),
    ],
  };
}

/**
 * The queue can be edited while a submission is in flight. Admission cleanup
 * must target the exact request, not a newer queued edit that reused the row id.
 */
export function queuedSubmissionMatches(item: QueuedPrompt, id: string, requestId: string) {
  return item.id === id && item.submission?.requestId === requestId;
}

/**
 * Remove only the exact request that Durable admitted. A queued row may have
 * been edited while its old request was in flight, so matching by id alone can
 * delete newer user content.
 */
export function removeAdmittedQueuedSubmission(items: QueuedPrompt[], id: string, requestId: string) {
  const next = items.filter(item => !queuedSubmissionMatches(item, id, requestId));
  if (next.length === items.length) return items;
  return next;
}

/**
 * Keep a rejected request at its original queue position and prevent the
 * automatic drain from immediately retrying it. A later edit creates a new
 * request id, so this marker cannot leak onto the edited version.
 */
export function markRejectedQueuedSubmission(items: QueuedPrompt[], id: string, requestId: string, error: string) {
  let changed = false;
  const next = items.map((item) => {
    if (!queuedSubmissionMatches(item, id, requestId)) return item;
    changed = true;
    return { ...item, autoRetryError: error };
  });
  return changed ? next : items;
}
