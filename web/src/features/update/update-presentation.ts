/** Unknown progress stays unknown; finite percentages always fit the visible bar. */
export function normalizeUpdateProgress(value?: number): number | null {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.min(100, Math.max(0, value))
    : null;
}
