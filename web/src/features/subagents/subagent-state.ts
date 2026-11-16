import type { SubagentChild } from '../../types/subagent-types';

const TERMINAL_STATUSES = new Set(['completed', 'failed', 'stopped']);

/**
 * Reconcile a child status from two asynchronous projections.
 *
 * A terminal incoming status must always replace a stale running cache. A late
 * running event, however, must not move an already finished child backwards.
 */
export function reconcileSubagentStatus(current: SubagentChild['status'], incoming: SubagentChild['status']) {
  if (!incoming) return current;
  if (!current) return incoming;
  if (TERMINAL_STATUSES.has(current) && !TERMINAL_STATUSES.has(incoming)) {
    return current;
  }
  return incoming;
}

export function mergeSubagentChild(current: SubagentChild | undefined, incoming: SubagentChild) {
  if (!current || incoming.runId !== current.runId) return incoming;
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
export function mergeSubagentChildren(current: SubagentChild[], incoming: SubagentChild[]) {
  const previous = new Map(current.map((child) => [child.key, child]));
  return incoming.map((child) => {
    const cached = previous.get(child.key);
    return cached ? mergeSubagentChild(cached, child) : child;
  });
}

function progressPriority(child: SubagentChild) {
  if (child.status === 'waiting' || (child.supervisorRequests?.length ?? child.supervisorPending)) return 0;
  if (child.status === 'running') return 1;
  if (child.status === 'pending') return 2;
  if (child.status === 'paused' || child.status === 'failed') return 3;
  return 4;
}

export function orderProgressAgents(children: SubagentChild[]) {
  return [...children].sort((a, b) => progressPriority(a) - progressPriority(b)
    || (b.startedAt ?? 0) - (a.startedAt ?? 0) || b.index - a.index);
}
