/**
 * Expanded history belongs to its conversation. Resolve this during render,
 * before an effect can clear the previous conversation's window.
 * @param {string} session
 * @param {number} totalTurns
 * @param {{session: string, from: number} | null} expanded
 * @param {{session: string, from: number} | null} initial
 */
export function transcriptWindowStart(session, totalTurns, expanded, initial) {
  const from = expanded?.session === session ? expanded.from : initial?.session === session ? initial.from : 0;
  return Math.max(0, Math.min(from, totalTurns));
}
