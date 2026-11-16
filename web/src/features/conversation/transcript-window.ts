type WindowStart = { session: string; from: number };

/**
 * Expanded history belongs to its conversation. Resolve this during render,
 * before an effect can clear the previous conversation's window.
 */
export function transcriptWindowStart(session: string, totalTurns: number, expanded: WindowStart | null, initial: WindowStart | null) {
  const from = expanded?.session === session ? expanded.from : initial?.session === session ? initial.from : 0;
  return Math.max(0, Math.min(from, totalTurns));
}
