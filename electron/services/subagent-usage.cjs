const { getStudioDatabase } = require('../core/studio-db.cjs');

/** One accounting path for the UI budget and the runtime admission check. */
function subagentUsage(state, database = getStudioDatabase()) {
  const ids = new Set(Object.values(state?.agents || {})
    .map((agent) => Number(agent?.conversationId))
    .filter((id) => Number.isSafeInteger(id) && id > 0));
  const total = { tokens: 0, costUsd: 0, requests: 0 };
  for (const id of ids) {
    const usage = database.metricTotalsForConversation(id);
    total.tokens += usage.tokens;
    total.costUsd += usage.cost;
    total.requests += usage.requests;
  }
  return total;
}

module.exports = { subagentUsage };
