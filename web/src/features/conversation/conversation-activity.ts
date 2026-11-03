/**
 * Studio turn activity is broader than one Durable model run. A main run can
 * finish while an owned foreground or background task keeps working.
 */
export function isConversationTurnActive(input: {
  requestRunning: boolean;
  compacting: boolean;
  conversationRunning: boolean;
}): boolean {
  return input.requestRunning || input.compacting || input.conversationRunning;
}

/** Older event payloads do not carry `running`; callers then keep their fallback. */
export function eventSaysConversationRunning(
  payload: { running?: boolean } | undefined,
  fallback: boolean,
): boolean {
  return typeof payload?.running === 'boolean' ? payload.running : fallback;
}
