/** JSON-safe aggregate returned by the Studio SQLite usage projection. */

export type UsageTotals = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cost: number;
  requests: number;
  activeDays: number;
};

export type UsageDay = UsageTotals & {
  day: string;
};

export type UsageModel = UsageTotals & {
  providerId: string;
  providerName: string;
  modelId: string;
  displayName: string;
};

export type UsageActiveModel = {
  providerId: string;
  providerName: string;
  modelId: string;
  displayName: string;
};

export type UsageFilterModel = UsageActiveModel & {
  enabled: boolean;
  inUse: boolean;
};

export type UsageModelDay = UsageDay & UsageActiveModel;

export type UsageAnalyticsSnapshot = {
  generatedAt: number;
  days: number;
  sinceDay: string;
  collection: {
    enabled: boolean;
    store: 'studio-sqlite';
  };
  allTime: UsageTotals & {
    currentStreak: number;
    longestStreak: number;
  };
  range: UsageTotals;
  daily: UsageDay[];
  dailyModels: UsageModelDay[];
  filterModels: UsageFilterModel[];
  models: UsageModel[];
};
