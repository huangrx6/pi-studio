'use strict';

const count = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;

/** Pi usage categories are disjoint; reasoning is already part of output. */
function usageTokens(usage) {
  if (!usage || typeof usage !== 'object') return undefined;
  if (count(usage.totalTokens) !== undefined) return usage.totalTokens;
  const values = [usage.input ?? usage.inputTokens, usage.output ?? usage.outputTokens, usage.cacheRead, usage.cacheWrite].map(count);
  return values.some(value => value !== undefined) ? values.reduce((sum, value) => sum + (value || 0), 0) : undefined;
}

/** Model bucket only: a tool may relay its child's usage, which would double count. */
function modelUsageTotals(state) {
  let tokens = 0;
  let found = false;
  let referenceCostUsd = 0;
  let costFound = false;
  for (const usage of Object.values(state?.models || {})) {
    const value = usageTokens(usage);
    if (value !== undefined) { tokens += value; found = true; }
    if (count(usage.cost?.total) !== undefined && usage.cost.total > 0) {
      referenceCostUsd += usage.cost.total;
      costFound = true;
    }
  }
  return { ...(found ? { tokens } : {}), ...(costFound ? { referenceCostUsd } : {}) };
}

module.exports = { usageTokens, modelUsageTotals };
