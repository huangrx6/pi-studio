import type { ChatMessage, RequestTrace } from '../types/chat-types';

export type RequestTraceTurn =
  | { kind: 'user'; message: Pick<ChatMessage, 'timestamp'> }
  | { kind: 'assistant'; messages: Array<Pick<ChatMessage, 'timestamp' | 'taskId'>> };

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

  const latestUserTimestamp = [...trace.messages].reverse().find((message) => (
    message.role === 'user' && Number.isFinite(message.timestamp)
  ))?.timestamp;

  if (typeof latestUserTimestamp === 'number') {
    const userIndex = turns.findIndex((turn) => (
      turn.kind === 'user' && turn.message.timestamp === latestUserTimestamp
    ));
    if (userIndex >= 0) {
      const responseTurn = turns[userIndex + 1];
      return responseTurn?.kind === 'assistant' ? userIndex + 1 : -1;
    }
  }

  // A known request input that is outside the loaded transcript must not be
  // guessed onto a later answer just because that answer has a newer time.
  if (typeof latestUserTimestamp === 'number') return -1;

  // Older traces may not carry message timestamps or task IDs.
  return turns.findIndex((turn) => (
    turn.kind === 'assistant'
    && turn.messages.some((message) => (
      typeof message.timestamp === 'number' && message.timestamp >= trace.createdAt
    ))
  ));
}
