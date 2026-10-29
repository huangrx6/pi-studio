/**
 * Stable renderer contract for Studio extensions.
 *
 * Agent extensions execute in the Electron main process. UI extensions are
 * declarative JSON only. The renderer never receives Electron, Durable, React,
 * module objects, HTML, CSS, or executable JavaScript.
 */

export type ExtensionScope = 'builtin' | 'user' | 'project';
export type ExtensionTier = 'core' | 'system' | 'optional' | 'user' | 'project';
export type ExtensionHealth =
  | 'available'
  | 'disabled'
  | 'untrusted'
  | 'error'
  | 'cycle'
  | 'blocked'
  | 'missing';

export type ExtensionUiSlot =
  | 'workspace.sidebar'
  | 'conversation.header'
  | 'conversation.detail'
  | 'conversation.footer'
  | 'composer.before'
  | 'settings.panel'
  | 'panel.side'
  | 'status.bar';

export type ConversationExtensionLayout = 'grid' | 'list';
export type ConversationExtensionOrderScope = 'global' | 'session';

export interface ConversationExtensionUiPreferences {
  version: 1;
  layout: ConversationExtensionLayout;
  /** Extension IDs in the user's global order. Empty means declaration order. */
  globalOrder: string[];
  /** Optional per-conversation overrides keyed by stable conversation ID. */
  sessionOrders: Record<string, string[]>;
}

export type ExtensionPermission =
  | 'agent.tools'
  | 'agent.sections'
  | 'agent.hooks'
  | 'agent.tasks'
  | 'ui.commands'
  | 'ui.panels'
  | 'ui.settings'
  | 'ui.data'
  | 'provider.credentials'
  | 'network';

export type ExtensionCommandPlacement =
  | 'composer'
  | 'command-menu'
  | 'session'
  | 'workspace';

export type ExtensionSettingsPage =
  | 'general'
  | 'tools'
  | 'harness'
  | 'subagents'
  | 'permissions'
  | 'models'
  | 'usage'
  | 'mcp'
  | 'skills'
  | 'extensions'
  | 'about';

/**
 * Renderer actions are deliberately data-only. The main process validates
 * commands again before executing them.
 */
export type ExtensionUiAction =
  | { kind: 'openSettings'; panel?: ExtensionSettingsPage }
  | { kind: 'openPanel'; panelId: string }
  | { kind: 'sendPrompt'; text: string; submit?: boolean }
  | { kind: 'copyText'; text: string }
  | { kind: 'openUrl'; url: string }
  | { kind: 'runCommand'; commandId: string };

export interface ExtensionActionButton {
  id: string;
  label: string;
  tone?: 'default' | 'primary' | 'danger';
  action: ExtensionUiAction;
}

export type ExtensionTone = 'neutral' | 'info' | 'success' | 'warning' | 'error';
export type ExtensionStatus = 'pending' | 'active' | 'success' | 'warning' | 'error' | 'neutral';
export type ExtensionDensity = 'compact' | 'comfortable' | 'spacious';

export interface ExtensionMetric {
  id: string;
  label: string;
  value: string | number;
  unit?: string;
  detail?: string;
  trend?: {
    direction: 'up' | 'down' | 'flat';
    label: string;
    tone?: 'neutral' | 'positive' | 'negative';
  };
  tone?: ExtensionTone;
}

export interface ExtensionChartSeries {
  id: string;
  label: string;
  values: number[];
  tone?: 'accent' | 'info' | 'success' | 'warning' | 'error';
}

export interface ExtensionTimelineItem {
  id: string;
  title: string;
  detail?: string;
  time?: string;
  status?: ExtensionStatus;
}

export interface ExtensionStatusItem {
  id: string;
  label: string;
  detail?: string;
  status?: ExtensionStatus;
}

export interface ExtensionTableColumn {
  key: string;
  label: string;
  align?: 'left' | 'right' | 'center';
}

export type ExtensionTableValue = string | number | boolean | null;

/**
 * Declarative content is intentionally recursive so extensions can compose
 * sections and layouts. The host applies depth, item and length limits before
 * this data reaches React.
 */
export type ExtensionContent =
  | { kind: 'heading'; text: string; level?: 2 | 3 }
  | { kind: 'text'; text: string }
  | { kind: 'list'; items: Array<{ title?: string; text: string }> }
  | { kind: 'keyValue'; items: Array<{ label: string; value: string }> }
  | {
      kind: 'notice';
      tone: 'info' | 'success' | 'warning' | 'error';
      title?: string;
      text: string;
    }
  | { kind: 'actions'; buttons: ExtensionActionButton[] }
  | { kind: 'badge'; label: string; tone?: ExtensionTone }
  | {
      kind: 'emptyState';
      title: string;
      text?: string;
      action?: ExtensionActionButton;
    }
  | {
      kind: 'section';
      title?: string;
      description?: string;
      tone?: ExtensionTone;
      density?: ExtensionDensity;
      content: ExtensionContent[];
    }
  | {
      kind: 'stack';
      gap?: ExtensionDensity;
      content: ExtensionContent[];
    }
  | {
      kind: 'grid';
      columns?: 1 | 2 | 3 | 4;
      density?: ExtensionDensity;
      content: ExtensionContent[];
    }
  | {
      kind: 'tabs';
      tabs: Array<{ id: string; label: string; content: ExtensionContent[] }>;
      activeTab?: string;
    }
  | {
      kind: 'disclosure';
      title: string;
      description?: string;
      open?: boolean;
      content: ExtensionContent[];
    }
  | {
      kind: 'metricGrid';
      columns?: 1 | 2 | 3 | 4;
      metrics: ExtensionMetric[];
    }
  | ({ kind: 'metric' } & ExtensionMetric)
  | {
      kind: 'sparkline';
      label: string;
      values: number[];
      unit?: string;
      tone?: 'accent' | 'info' | 'success' | 'warning' | 'error';
    }
  | {
      kind: 'chart';
      title: string;
      description?: string;
      labels?: string[];
      series: ExtensionChartSeries[];
      unit?: string;
    }
  | {
      kind: 'timeline';
      title?: string;
      items: ExtensionTimelineItem[];
    }
  | {
      kind: 'statusList';
      title?: string;
      items: ExtensionStatusItem[];
    }
  | {
      kind: 'table';
      title?: string;
      columns: ExtensionTableColumn[];
      rows: Array<Record<string, ExtensionTableValue>>;
    }
  | {
      kind: 'progress';
      label: string;
      value: number;
      max?: number;
      detail?: string;
      tone?: 'accent' | 'info' | 'success' | 'warning' | 'error';
    }
  | {
      kind: 'dataView';
      sourceId: ExtensionContributionId;
      emptyText?: string;
      fallback?: ExtensionContent[];
    }
  | { kind: 'divider' };

/**
 * A fully qualified contribution identity:
 * `<scope>:<manifest-id>/<contribution-id>`.
 */
export type ExtensionContributionId = string;

export interface ExtensionToolContribution {
  name: string;
  description: string;
}

export interface ExtensionCommandContribution {
  id: string;
  title: string;
  description: string;
  placement: ExtensionCommandPlacement;
  argumentHint?: string;
  icon?: string;
  action?: ExtensionUiAction;
}

export interface ExtensionPanelContribution {
  id: string;
  title: string;
  description: string;
  slot: ExtensionUiSlot;
  icon?: string;
  size?: 'compact' | 'regular';
  priority?: number;
  content: ExtensionContent[];
}

export interface ExtensionSettingContribution {
  id: string;
  title: string;
  description: string;
  content: ExtensionContent[];
}

export interface ExtensionComposerContribution {
  id: string;
  title: string;
  description: string;
  action: string;
  argumentHint?: string;
  icon?: string;
}

export interface ExtensionDataSourceContribution {
  id: string;
  title: string;
  description: string;
}

export interface ExtensionManifest {
  format: 1;
  id: string;
  name: string;
  version: string;
  description: string;
  author: string;
  publisher?: string;
  license?: string;
  scope?: ExtensionScope;
  source?: string;
  permissions: ExtensionPermission[];
  providerAccess?: string[];
  runtime: { durableEntry: string };
  contributes: {
    tools: ExtensionToolContribution[];
    commands: ExtensionCommandContribution[];
    panels: ExtensionPanelContribution[];
    settings: ExtensionSettingContribution[];
    composer: ExtensionComposerContribution[];
    dataSources: ExtensionDataSourceContribution[];
  };
}

export interface ExtensionHostItem {
  /** Stable database identity. User and project manifests with the same id coexist. */
  id: string;
  name: string;
  version: string;
  scope: ExtensionScope;
  tier: ExtensionTier;
  source: string;
  manifest: ExtensionManifest;
  enabled: boolean;
  trusted: boolean;
  contentHash: string;
  installedAt: number;
  updatedAt: number;
  runtimeName: string;
  runtimeNames: string[];
  available: boolean;
  health: ExtensionHealth;
  blockedReason: string;
  requirements: ExtensionContributionId[];
  dependents: ExtensionContributionId[];
  activeDependents: ExtensionContributionId[];
  missingDependencies: ExtensionContributionId[];
  disabledDependencies: ExtensionContributionId[];
  untrustedDependencies: ExtensionContributionId[];
  unavailableDependencies: ExtensionContributionId[];
  cycleDependencies: ExtensionContributionId[];
  canDisable: boolean;
  canRemove: boolean;
  disableBlockedReason: string;
  removeBlockedReason: string;
  manageBlockedReason: string;
  commandIds: ExtensionContributionId[];
  panelIds: ExtensionContributionId[];
  dataSourceIds: ExtensionContributionId[];
  installation?: ExtensionInstallationSummary;
}

export interface ExtensionInstallVersion {
  version: string;
  sha256: string;
  sourceKind: string;
  resolvedRef: string | null;
  publisher: string;
  signatureStatus?: 'unsigned' | 'trusted';
  signaturePublisher?: string;
  signatureKeyId?: string;
  activatedAt: number;
  active: boolean;
}

export interface ExtensionInstallationSummary {
  managed: true;
  version: string;
  activeCodePath: string;
  dataPath: string;
  sha256: string;
  source: string;
  sourceKind: string;
  resolvedRef: string | null;
  publisher: string;
  signatureStatus?: 'unsigned' | 'trusted';
  signaturePublisher?: string;
  signatureKeyId?: string;
  activeHistoryIndex: number;
  canRollback: boolean;
  versions: ExtensionInstallVersion[];
}

export type ExtensionInstallScope = 'user' | 'project';

export interface ExtensionInstallPreview {
  token: string;
  scope: ExtensionInstallScope;
  id: string;
  name: string;
  version: string;
  publisher: string;
  description: string;
  permissions: ExtensionPermission[];
  providerAccess: string[];
  requires: ExtensionContributionId[];
  addedRequirements: ExtensionContributionId[];
  missingDependencies: ExtensionContributionId[];
  addedPermissions: ExtensionPermission[];
  addedProviderAccess: string[];
  executable: boolean;
  executableExpansion: boolean;
  sourceKind: string;
  source: string;
  resolvedRef: string | null;
  archiveSha256: string | null;
  treeSha256: string;
  integrityFileSha256: string;
  signatureStatus: 'unsigned' | 'valid' | 'trusted';
  signaturePublisher?: string;
  signatureKeyId?: string;
  publisherTrust: 'not-applicable' | 'untrusted' | 'trusted';
  requiresPublisherTrust: boolean;
  upgrade: boolean;
  alreadyInstalled: boolean;
  installedVersion?: string;
  requiresPermissionConsent: boolean;
  requiresCapabilityConsent: boolean;
}

export interface ExtensionUpdateCheckResult {
  id: string;
  name: string;
  installedVersion: string;
  latestVersion?: string;
  source: string;
  status: 'update-available' | 'current' | 'error';
  updateAvailable: boolean;
  requiresCapabilityConsent?: boolean;
  addedPermissions?: ExtensionPermission[];
  addedProviderAccess?: string[];
  addedRequirements?: ExtensionContributionId[];
  executableExpansion?: boolean;
  message?: string;
  code?: string;
}

export interface ExtensionUpdateCheckSnapshot {
  scope: ExtensionInstallScope;
  checkedAt: number;
  updates: ExtensionUpdateCheckResult[];
  errors: ExtensionHostError[];
  skipped: Array<{
    id: string;
    installedVersion: string;
    reason: string;
  }>;
}

export interface ExtensionPublisherTrustKey {
  keyId: string;
  status: 'trusted' | 'revoked';
  source?: string;
  createdAt?: number;
  updatedAt?: number;
  revokedAt?: number;
}

export interface ExtensionPublisherTrustSnapshot {
  schemaVersion: 1;
  publishers: Array<{
    publisher: string;
    keys: ExtensionPublisherTrustKey[];
  }>;
}

export interface OfficialExtensionCatalogItem {
  id: string;
  name: string;
  version: string;
  description: string;
  publisher: string;
  author?: string;
  repository?: string;
  homepage?: string;
  keywords: string[];
  permissions: ExtensionPermission[];
  providerAccess?: string[];
  requires: ExtensionContributionId[];
  executable: boolean;
  sha256: string;
  installed: boolean;
  officialManaged: boolean;
  installedVersion?: string;
  updateAvailable: boolean;
  autoUpdate: boolean;
  requiresPermissionConsent: boolean;
  requiresCapabilityConsent: boolean;
  addedPermissions: ExtensionPermission[];
  addedProviderAccess: string[];
  addedRequirements: ExtensionContributionId[];
  executableExpansion: boolean;
}

export interface OfficialExtensionCatalogSnapshot {
  extensions: OfficialExtensionCatalogItem[];
  errors: ExtensionHostError[];
  updatedAt: number;
  autoUpdate?: {
    results: Array<{
      id: string;
      status: 'updated' | 'consent-required';
      version: string;
      permissions?: ExtensionPermission[];
      providerAccess?: string[];
      requirements?: ExtensionContributionId[];
      executableExpansion?: boolean;
      missingDependencies?: ExtensionContributionId[];
    }>;
    updated: string[];
  };
}

export interface ExtensionHostError {
  path: string;
  id?: string;
  message: string;
}

export interface ExtensionHostSnapshot {
  extensions: ExtensionHostItem[];
  errors: ExtensionHostError[];
  syncedAt: number;
  apiVersion: number;
}

/** One JSON-safe item that can be rendered by a generic extension slot. */
export interface ExtensionUiItem {
  id: ExtensionContributionId;
  extensionId: string;
  extensionName: string;
  scope: ExtensionScope;
  contributionId: string;
  title: string;
  description: string;
  slot: ExtensionUiSlot;
  icon?: string;
  size: 'compact' | 'regular';
  priority: number;
  /** Stable declaration order from extension scan and manifest order. */
  sourceOrder: number;
  content: ExtensionContent[];
}

export interface ExtensionUiSnapshot {
  items: ExtensionUiItem[];
  errors: ExtensionHostError[];
  syncedAt: number;
  apiVersion: number;
}

export interface ExtensionDataViewSnapshot {
  sourceId: ExtensionContributionId;
  revision: number;
  updatedAt: number;
  content: ExtensionContent[];
  error?: string;
}

export interface ExtensionDataViewOpenRequest {
  sourceId: ExtensionContributionId;
  cwd?: string;
  sessionId?: string;
  /** Current renderer selection. The host re-resolves the durable model when available. */
  modelRef?: string;
}

export interface ExtensionDataViewOpenResult {
  subscriptionId: string;
  snapshot: ExtensionDataViewSnapshot;
}

export interface ExtensionDataViewEvent {
  subscriptionId: string;
  snapshot: ExtensionDataViewSnapshot;
}

export interface ExtensionCommandResult {
  ok: boolean;
  action?: ExtensionUiAction;
  message?: string;
  promptText?: string;
  submit?: boolean;
  panelId?: ExtensionContributionId;
  settingsPage?: ExtensionSettingsPage;
}
