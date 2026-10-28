export type ThinkingLevel = 'default' | 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export type ModelSelection = {
  modelRef: string;
  label: string;
  thinkingLevel: ThinkingLevel;
  thinkingLevels: ThinkingLevel[];
  effectiveThinkingLevel: Exclude<ThinkingLevel, 'default'>;
  defaultThinkingLevel: Exclude<ThinkingLevel, 'default'>;
};
export type ModelOption = { id: string; provider: string; providerName: string; model: string; name: string; contextWindow?: number; maxTokens?: number; supportsImages?: boolean; reasoning?: boolean };
export type ModelCatalog = { models: ModelOption[]; enabled: string[]; current: string; selection: ModelSelection };
export const thinkingLabels: Record<ThinkingLevel, string> = { default: 'Default', off: 'Off', minimal: 'Minimal', low: 'Low', medium: 'Medium', high: 'High', xhigh: 'XHigh', max: 'Max' };
