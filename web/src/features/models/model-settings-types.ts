import type { ConcreteThinkingLevel, ModelOption, ModelSelection, ThinkingLevel } from '../../types/model-types';
import { concreteThinkingLevels } from '../../types/model-types';

export type ModelOrigin = 'builtin' | 'configured' | 'override';
export type ModelProvider = { id: string; name: string; mode: string; authConfigured?: boolean; envName?: string; envAvailable?: boolean; icon?: string; models: number; modelsUrl?: string; enabled: boolean; builtin: boolean };
export type ProviderModelInfo = { id: string; model: string; name: string; enabled: boolean; contextWindow?: number; maxTokens?: number; supportsImages?: boolean; reasoning?: boolean; thinkingLevels?: ConcreteThinkingLevel[]; origin: ModelOrigin; deletable?: boolean };
export type DiscoveredModel = { id: string; name: string; contextWindow?: number; maxTokens?: number; supportsImages: boolean; reasoning: boolean; thinkingLevels: ConcreteThinkingLevel[] };
export type ProviderDiscoveryState = { loading?: boolean; importing?: boolean; imported?: number; endpoint?: string; models?: DiscoveredModel[]; selected?: string[]; error?: string };
export type ProviderCatalogState = { loading: boolean; error?: string };
export type CustomModelConfig = {
  providerId: string;
  modelId: string;
  name: string;
  contextWindow?: number;
  maxTokens?: number;
  supportsImages: boolean;
  reasoning: boolean;
  thinkingLevels?: ConcreteThinkingLevel[];
  origin?: Exclude<ModelOrigin, 'builtin'>;
};

export const DEFAULT_MODEL_THINKING_LEVELS = concreteThinkingLevels.filter(
  (level) => level !== 'xhigh' && level !== 'max',
);

export function emptyCustomModelConfig() {
  return {
    providerId: '',
    modelId: '',
    name: '',
    contextWindow: '',
    maxTokens: '',
    supportsImages: false,
    reasoning: false,
    thinkingLevels: [] as ConcreteThinkingLevel[],
    origin: 'configured' as ModelOrigin,
  };
}

export type ModelSettingsActions = {
  onModelViewChange: (view: 'all' | 'provider') => void;
  onModelQueryChange: (query: string) => void;
  onSelectDefaultModel: (id: string) => void;
  onSelectDefaultThinking: (level: ThinkingLevel) => void;
  onAddProvider: () => void;
  onEditProvider: (id: string) => void;
  onSetEnabled: (ids: string[]) => void;
  onManageProvider: (id: string) => void;
  onReloadProvider: (id: string) => void;
  onDiscoverProvider: (id: string) => void;
  onOpenModelEditor: (providerId: string, item?: ProviderModelInfo) => void;
  onDeleteModel: (providerId: string, item: ProviderModelInfo) => void;
  onToggleProvider: (provider: ModelProvider, enabled: boolean) => void;
  onDeleteProvider: (provider: ModelProvider) => void;
  onDiscoverySelection: (providerId: string, selected: string[]) => void;
  onDismissDiscovery: (providerId: string) => void;
  onImportModels: (providerId: string, models: DiscoveredModel[]) => void;
};
export type ModelSettingsProps = {
  providers: ModelProvider[];
  models: ModelOption[];
  enabledModels: string[];
  defaultModelSelection: ModelSelection;
  defaultModelBusy: boolean;
  settingsBusy: boolean;
  recoveryPending?: boolean;
  providerModels: Record<string, ProviderModelInfo[]>;
  providerCatalogState: Record<string, ProviderCatalogState>;
  providerDiscovery: Record<string, ProviderDiscoveryState>;
  expandedProvider: string | null;
  modelView: 'all' | 'provider';
  modelQuery: string;
  actions: ModelSettingsActions;
};
