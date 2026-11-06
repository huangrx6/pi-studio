/**
 * Restore a rejected submission without replacing text the user typed while
 * the previous attempt was in flight. Attachments keep their stable ids so a
 * retry cannot duplicate the same pending file.
 *
 * @template {{id: string}} Attachment
 * @param {{text: string, attachments: Attachment[]}} current
 * @param {{text: string, attachments: Attachment[]}} rejected
 * @returns {{text: string, attachments: Attachment[]}}
 */
export function mergeRejectedComposerDraft(current, rejected) {
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
 *
 * @param {{id: string, submission: {requestId: string}}} item
 * @param {string} id
 * @param {string} requestId
 */
export function queuedSubmissionMatches(item, id, requestId) {
  return item.id === id && item.submission?.requestId === requestId;
}

/**
 * Remove only the exact request that Durable admitted. A queued row may have
 * been edited while its old request was in flight, so matching by id alone can
 * delete newer user content.
 *
 * @template T
 * @param {T[]} items
 * @param {string} id
 * @param {string} requestId
 * @returns {T[]}
 */
export function removeAdmittedQueuedSubmission(items, id, requestId) {
  const next = items.filter(item => !queuedSubmissionMatches(item, id, requestId));
  if (next.length === items.length) return items;
  return next;
}

/**
 * Keep a rejected request at its original queue position and prevent the
 * automatic drain from immediately retrying it. A later edit creates a new
 * request id, so this marker cannot leak onto the edited version.
 *
 * @template T
 * @param {T[]} items
 * @param {string} id
 * @param {string} requestId
 * @param {string} error
 * @returns {T[]}
 */
export function markRejectedQueuedSubmission(items, id, requestId, error) {
  let changed = false;
  const next = items.map((item) => {
    if (!queuedSubmissionMatches(item, id, requestId)) return item;
    changed = true;
    return { ...item, autoRetryError: error };
  });
  return changed ? next : items;
}
