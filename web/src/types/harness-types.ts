import type { RuntimeRefreshSnapshot } from './runtime-types';

export type HarnessSectionId =
  | 'preamble'
  | 'tools'
  | 'rules'
  | 'repositoryDocs'
  | 'projectContext'
  | 'skills'
  | 'cwd'
  | 'addendum';

export type HarnessSectionDefinition = {
  id: HarnessSectionId;
  label: string;
  description: string;
};

export type HarnessProfile = {
  id: string;
  name: string;
  builtin: boolean;
  sections: Record<HarnessSectionId, boolean>;
  sectionOverrides: Partial<Record<HarnessSectionId, string>>;
  customInstructions: string;
  toolGuidance: Record<string, string>;
};

export type HarnessProfileDraft = HarnessProfile;

export type RuntimePolicy = {
  version: 1;
  streamTimeoutMs: number;
  retry: {
    enabled: boolean;
    maxRetries: number;
    baseDelayMs: number;
  };
  compaction: {
    enabled: boolean;
    reserveTokens: number;
    keepRecentTokens: number;
    backgroundTokens: number;
  };
  toolExecution: 'parallel' | 'sequential';
  afterFailedRun: 'keep' | 'continue' | 'withdraw';
  restartLimit: number;
  contextRetentionMs: number;
  documentRetentionMs: number;
};

export type HarnessSettingsSnapshot = {
  version: number;
  activeProfileId: string;
  globalProfileId: string;
  workspaceProfileId: string;
  sections: HarnessSectionDefinition[];
  profiles: HarnessProfile[];
  activeProfile: HarnessProfile;
  path: string;
  globalInstructionsPath: string;
  globalInstructionsStatus: 'present' | 'missing' | 'unreadable';
  runtimePolicy: RuntimePolicy;
  runtimePolicyDefaults: RuntimePolicy;
  runtimePolicyPath: string;
  runtimeRefresh?: RuntimeRefreshSnapshot;
};
