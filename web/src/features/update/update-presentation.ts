/** Unknown progress stays unknown; finite percentages always fit the visible bar. */
export function normalizeUpdateProgress(value?: number): number | null {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.min(100, Math.max(0, value))
    : null;
}

type ProgressFields = {
  progress?: number;
  transferred?: number;
  total?: number;
};

/** Bytes or percent that mean the payload finished and verification can start. */
export function isUpdateDownloadComplete(snapshot: ProgressFields): boolean {
  const progress = normalizeUpdateProgress(snapshot.progress);
  if (progress !== null && progress >= 99.5) return true;
  const total = Number(snapshot.total);
  const transferred = Number(snapshot.transferred);
  return Number.isFinite(total) && total > 0
    && Number.isFinite(transferred)
    && transferred >= total * 0.995;
}

export type UpdateFlowPhase = 'connecting' | 'downloading' | 'verifying' | 'ready' | 'installing';

/**
 * Map updater snapshot + local install action onto the three-step flow:
 * download → verify → install.
 */
export function resolveUpdateFlowPhase(
  state: string,
  snapshot: ProgressFields,
  pendingAction?: string | null,
): UpdateFlowPhase | null {
  if (pendingAction === 'install') return 'installing';
  if (state === 'downloaded') return 'ready';
  if (state !== 'downloading') return null;
  const progress = normalizeUpdateProgress(snapshot.progress);
  const hasTransfer = typeof snapshot.transferred === 'number'
    && Number.isFinite(snapshot.transferred)
    && snapshot.transferred > 0;
  if (progress === null && !hasTransfer) return 'connecting';
  if (isUpdateDownloadComplete(snapshot)) return 'verifying';
  return 'downloading';
}
