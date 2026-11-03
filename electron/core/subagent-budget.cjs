/**
 * Pure subagent budget projection shared by settings and the runtime guard.
 *
 * Missing provider cost remains zero and never becomes an estimate. A budget
 * of zero disables that dimension.
 */

function nonNegative(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

function evaluateSubagentBudget(config = {}, usage = {}) {
  const tokens = nonNegative(usage.tokens);
  const costUsd = nonNegative(usage.costUsd ?? usage.cost);
  const requests = nonNegative(usage.requests);
  const budgetTokens = nonNegative(config.budgetTokens);
  const budgetCostUsd = nonNegative(config.budgetCostUsd);
  const budgetAction = config.budgetAction === 'stop' ? 'stop' : 'warn';
  return {
    tokens,
    costUsd,
    requests,
    budgetTokens,
    budgetCostUsd,
    budgetAction,
    exceeded: Boolean(
      (budgetTokens > 0 && tokens >= budgetTokens)
      || (budgetCostUsd > 0 && costUsd >= budgetCostUsd)
    ),
  };
}

module.exports = {
  evaluateSubagentBudget,
};
