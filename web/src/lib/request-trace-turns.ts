import type { ChatMessage, RequestTrace } from '../types/chat-types';

export type RequestTraceTurn =
  | { kind: 'user'; message: Pick<ChatMessage, 'timestamp'> }
  | { kind: 'assistant'; messages: Array<Pick<ChatMessage, 'timestamp' | 'taskId'>> };

/** Timestamp of the newest user message inside a captured provider request. */
function latestUserTimestamp(trace: Pick<RequestTrace, 'messages'>): number | undefined {
  return [...trace.messages].reverse().find((message) => (
    message.role === 'user' && Number.isFinite(message.timestamp)
  ))?.timestamp;
}

function userTurnIndexFor(trace: Pick<RequestTrace, 'messages'>, turns: readonly RequestTraceTurn[]): number {
  const timestamp = latestUserTimestamp(trace);
  if (timestamp === undefined) return -1;
  return turns.findIndex((turn) => turn.kind === 'user' && turn.message.timestamp === timestamp);
}

function lastIndexOfKind(turns: readonly RequestTraceTurn[], kind: RequestTraceTurn['kind']): number {
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    if (turns[index].kind === kind) return index;
  }
  return -1;
}

function append<K>(map: Map<K, RequestTrace[]>, key: K, trace: RequestTrace): void {
  const list = map.get(key);
  if (list) list.push(trace);
  else map.set(key, [trace]);
}

/**
 * A trace belongs to the answer for the newest user message in its captured
 * provider request. Its createdAt may be later than that answer when a retry
 * is cancelled before Durable appends a matching assistant message.
 */
export function requestTraceTargetTurnIndex(
  trace: Pick<RequestTrace, 'createdAt' | 'taskId' | 'messages'>,
  turns: readonly RequestTraceTurn[],
): number {
  if (trace.taskId) {
    const taskIndex = turns.findIndex((turn) => (
      turn.kind === 'assistant'
      && turn.messages.some((message) => message.taskId === trace.taskId)
    ));
    if (taskIndex >= 0) return taskIndex;
  }

  const userTimestamp = latestUserTimestamp(trace);
  if (typeof userTimestamp === 'number') {
    const userIndex = turns.findIndex((turn) => (
      turn.kind === 'user' && turn.message.timestamp === userTimestamp
    ));
    if (userIndex >= 0) {
      const responseTurn = turns[userIndex + 1];
      return responseTurn?.kind === 'assistant' ? userIndex + 1 : -1;
    }
  }

  // A known request input that is outside the loaded transcript must not be
  // guessed onto a later answer just because that answer has a newer time.
  if (typeof userTimestamp === 'number') return -1;

  // Older traces may not carry message timestamps or task IDs.
  return turns.findIndex((turn) => (
    turn.kind === 'assistant'
    && turn.messages.some((message) => (
      typeof message.timestamp === 'number' && message.timestamp >= trace.createdAt
    ))
  ));
}

export type RequestTracePlacement = {
  /** Attempts that belong to an assistant turn, keyed by that turn's index. */
  byAssistantTurn: Map<number, RequestTrace[]>;
  /** Attempts that never produced an answer, keyed by the index of the user turn they served. */
  unansweredByUserTurn: Map<number, RequestTrace[]>;
  /** Attempts of the newest user message; the newest one may still be running. */
  pending: RequestTrace[];
};

/**
 * Places every request trace in the transcript.
 *
 * Attempts for an older user message that never produced an answer stay after
 * that message. A newer message therefore cannot inherit them. Attempts of the
 * newest user message stay pending at the tail, and while the turn is active
 * only the newest request is treated as still running.
 */
export function placeRequestTraces(input: {
  traces: readonly RequestTrace[];
  turns: readonly RequestTraceTurn[];
  turnActive: boolean;
}): RequestTracePlacement {
  const { turns, turnActive } = input;
  const placement: RequestTracePlacement = {
    byAssistantTurn: new Map(),
    unansweredByUserTurn: new Map(),
    pending: [],
  };
  const traces = [...input.traces].sort((left, right) => (
    left.createdAt - right.createdAt || left.id.localeCompare(right.id)
  ));
  const lastUserIndex = lastIndexOfKind(turns, 'user');
  const lastAssistantIndex = lastIndexOfKind(turns, 'assistant');
  traces.forEach((trace, position) => {
    let target = requestTraceTargetTurnIndex(trace, turns);
    // Without a user timestamp, a trace can only follow the answer that is currently being produced.
    if (target < 0 && latestUserTimestamp(trace) === undefined && turnActive && turns.at(-1)?.kind === 'assistant') {
      target = lastAssistantIndex;
    }
    if (target >= 0) {
      append(placement.byAssistantTurn, target, trace);
      return;
    }
    const owner = userTurnIndexFor(trace, turns);
    const newest = position === traces.length - 1;
    if (owner < 0 || owner === lastUserIndex || (turnActive && newest)) placement.pending.push(trace);
    else append(placement.unansweredByUserTurn, owner, trace);
  });
  return placement;
}
