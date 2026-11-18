'use strict';

const RECOVERABLE_WATCH_END_KINDS = new Set([
  'aborted',
  'ended',
  'listener_error',
  'failed',
]);

/**
 * Remove an ended watch only when it is still the current owner of its key.
 * A late close from an older watch must never affect a replacement watch.
 */
function trackConversationStream({
  key,
  entry,
  watches,
  onUnexpectedEnd,
}) {
  const settle = (end) => {
    if (watches.get(key) !== entry) return;
    watches.delete(key);
    const kind = end && typeof end === 'object' ? end.kind : undefined;
    if (!RECOVERABLE_WATCH_END_KINDS.has(kind)) return;
    try {
      onUnexpectedEnd(kind);
    } catch {
      // A diagnostic delivery failure must not become an unhandled rejection.
    }
  };

  let closed;
  try {
    closed = entry.stream.closed;
  } catch {
    settle({ kind: 'failed' });
    return Promise.resolve();
  }
  return Promise.resolve(closed).then(
    settle,
    () => settle({ kind: 'failed' }),
  );
}

module.exports = {
  trackConversationStream,
};
