/**
 * Durable token usage analytics stored in Studio SQLite.
 *
 * The metrics extension writes content-free request totals through the host.
 * This service only reads aggregate rows; prompts, responses, credentials and
 * provider secrets never enter the analytics store or renderer contract.
 */

const { getStudioDatabase } = require('../core/studio-db.cjs');
const { METRICS_EXTENSION_ID } = require('./metrics-runtime.cjs');

const DEFAULT_DAYS = 371;
const MAX_DAYS = 3_660;

function localDay(date) {
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0'),
  ].join('-');
}

function dayStart(value) {
  const [year, month, day] = value.split('-').map(Number);
  return new Date(year, month - 1, day);
}

function shiftDay(value, amount) {
  const date = dayStart(value);
  date.setDate(date.getDate() + amount);
  return localDay(date);
}

function rangeStart(days, now) {
  const date = new Date(now);
  date.setHours(0, 0, 0, 0);
  date.setDate(date.getDate() - days + 1);
  return localDay(date);
}

function currentStreak(activeDays, now) {
  if (activeDays.size === 0) return 0;
  const today = localDay(new Date(now));
  let cursor = activeDays.has(today) ? today : shiftDay(today, -1);
  if (!activeDays.has(cursor)) return 0;
  let count = 0;
  while (activeDays.has(cursor)) {
    count += 1;
    cursor = shiftDay(cursor, -1);
  }
  return count;
}

function longestStreak(activeDays) {
  if (activeDays.size === 0) return 0;
  let longest = 1;
  let current = 1;
  let previous;
  for (const day of [...activeDays].sort()) {
    if (previous && day === shiftDay(previous, 1)) current += 1;
    else current = 1;
    longest = Math.max(longest, current);
    previous = day;
  }
  return longest;
}

function roundCost(value) {
  return Math.round((Number(value) || 0) * 1_000_000) / 1_000_000;
}

function usageAnalyticsSnapshot(options = {}) {
  const db = options.database || getStudioDatabase();
  const now = Number.isFinite(options.now) ? Number(options.now) : Date.now();
  const requestedDays = Number(options.days);
  const days = Number.isSafeInteger(requestedDays)
    ? Math.max(7, Math.min(MAX_DAYS, requestedDays))
    : DEFAULT_DAYS;
  const sinceDay = rangeStart(days, now);
  const daily = db.usageDaily({ sinceDay });
  const range = db.usageTotals({ sinceDay });
  const allTime = db.usageTotals();
  const allDaily = db.usageDaily();
  const activeDates = new Set(allDaily.map((row) => row.day));
  const providers = new Map(db.listProviders().map((entry) => [entry.id, entry.name]));
  const modelCatalog = db.listModels();
  const modelNames = new Map(
    modelCatalog.map((entry) => [
      `${entry.providerId}/${entry.modelId}`,
      entry.name,
    ]),
  );
  const modelIdentity = (entry) => ({
    providerId: entry.providerId,
    providerName: providers.get(entry.providerId) || entry.providerId,
    modelId: entry.modelId,
    displayName: modelNames.get(`${entry.providerId}/${entry.modelId}`) || entry.modelId,
  });
  const historicalUsage = db.usageModels();
  const historicalKeys = new Set(
    historicalUsage.map((entry) => `${entry.providerId}/${entry.modelId}`),
  );
  const filterModels = new Map();
  for (const entry of modelCatalog) {
    const key = `${entry.providerId}/${entry.modelId}`;
    const inUse = historicalKeys.has(key);
    if (!entry.enabled && !inUse) continue;
    filterModels.set(key, {
      ...modelIdentity(entry),
      enabled: entry.enabled,
      inUse,
    });
  }
  for (const entry of historicalUsage) {
    const key = `${entry.providerId}/${entry.modelId}`;
    if (filterModels.has(key)) continue;
    filterModels.set(key, {
      providerId: entry.providerId,
      providerName: providers.get(entry.providerId) || entry.providerId,
      modelId: entry.modelId,
      displayName: entry.modelId,
      enabled: false,
      inUse: true,
    });
  }
  const filterModelList = [...filterModels.values()].sort((left, right) => (
    Number(right.enabled) - Number(left.enabled)
    || left.providerName.localeCompare(right.providerName, 'zh-CN')
    || left.displayName.localeCompare(right.displayName, 'zh-CN')
  ));
  const modelUsage = db.usageModels({ sinceDay }).map((entry) => ({
    ...entry,
    providerName: providers.get(entry.providerId) || entry.providerId,
    displayName: modelNames.get(`${entry.providerId}/${entry.modelId}`) || entry.modelId,
    cost: roundCost(entry.cost),
  }));
  const dailyModels = db.usageDailyModels({ sinceDay }).map((entry) => ({
    ...entry,
    providerName: providers.get(entry.providerId) || entry.providerId,
    displayName: modelNames.get(`${entry.providerId}/${entry.modelId}`) || entry.modelId,
    cost: roundCost(entry.cost),
  }));
  return {
    generatedAt: now,
    days,
    sinceDay,
    collection: {
      enabled: db.getExtension(METRICS_EXTENSION_ID)?.enabled !== false,
      store: 'studio-sqlite',
    },
    allTime: {
      ...allTime,
      cost: roundCost(allTime.cost),
      currentStreak: currentStreak(activeDates, now),
      longestStreak: longestStreak(activeDates),
    },
    range: {
      ...range,
      cost: roundCost(range.cost),
    },
    daily: daily.map((entry) => ({ ...entry, cost: roundCost(entry.cost) })),
    dailyModels,
    filterModels: filterModelList,
    models: modelUsage,
  };
}

module.exports = {
  DEFAULT_DAYS,
  MAX_DAYS,
  currentStreak,
  localDay,
  longestStreak,
  usageAnalyticsSnapshot,
};
