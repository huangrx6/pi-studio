/** Compact, frozen duration for a completed answer in the conversation list. */
export function completedTurnDuration(durationMs?: number): string {
  if (!Number.isFinite(durationMs) || Number(durationMs) < 0) return '';
  const totalSeconds = Math.floor(Number(durationMs) / 1_000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const totalMinutes = Math.floor(totalSeconds / 60);
  if (totalMinutes < 60) return `${totalMinutes}m`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${hours}h${minutes ? `${minutes}m` : ''}`;
}
