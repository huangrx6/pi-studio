import type { ModelComparisonSnapshot } from '../../types/comparison-types';

/** A poll started before deletion must not revive a discarded branch. */
export function reconcileComparisonSnapshot(
  current: ModelComparisonSnapshot | null,
  incoming: ModelComparisonSnapshot,
): ModelComparisonSnapshot {
  const discarded = new Map(current?.filter((branch) => branch.status === 'discarded')
    .map((branch) => [branch.sessionId, branch]));
  return incoming.map((branch) => discarded.get(branch.sessionId) || branch) as ModelComparisonSnapshot;
}
