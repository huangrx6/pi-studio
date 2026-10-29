const TERMINAL_STATUSES = new Set(['completed', 'failed', 'stopped']);

/**
 * Reconcile a child status from two asynchronous projections.
 *
 * A terminal incoming status must always replace a stale running cache. A late
 * running event, however, must not move an already finished child backwards.
 */
export function reconcileSubagentStatus(current, incoming) {
  if (!incoming) return current;
  if (!current) return incoming;
  if (TERMINAL_STATUSES.has(current) && !TERMINAL_STATUSES.has(incoming)) {
    return current;
  }
  return incoming;
}

export function mergeSubagentChild(current, incoming) {
  if (!current) return incoming;
  const fields = Object.fromEntries(
    Object.entries(incoming).filter(([, value]) => (
      value !== undefined && value !== null && value !== ''
    )),
  );
  const next = {
    ...current,
    ...fields,
    status: reconcileSubagentStatus(current.status, incoming.status),
  };
  if (current.hasTranscript && !incoming.hasTranscript) next.hasTranscript = true;
  return next;
}

/**
 * The list endpoint is authoritative. Use its order and membership, while
 * retaining a known transcript flag for the same child across a brief refresh.
 */
export function mergeSubagentChildren(current, incoming) {
  const previous = new Map(current.map((child) => [child.key, child]));
  return incoming.slice(-100).map((child) => {
    const cached = previous.get(child.key);
    return cached ? mergeSubagentChild(cached, child) : child;
  });
}
