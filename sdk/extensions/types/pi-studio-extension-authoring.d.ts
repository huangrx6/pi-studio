/**
 * Pi Studio extension authoring contract, format 1.
 *
 * Import concrete Durable helpers from `@earendil-works/pi-durable`. This file
 * describes the metadata, command, data-view and declarative UI layer owned by
 * Pi Studio. The renderer never imports extension code.
 */

import type { Extension as DurableExtension } from '@earendil-works/pi-durable';

export type PiStudioExtensionApiVersion = 1;
export type PiStudioExtensionScope = 'builtin' | 'user' | 'project';
export type PiStudioExtensionTier = 'core' | 'system' | 'optional' | 'user' | 'project';

export type PiStudioExtensionPermission =
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

export type PiStudioSettingsPage =
  | 'general'
  | 'tools'
  | 'harness'
  | 'subagents'
  | 'permissions'
  | 'models'
  | 'mcp'
  | 'skills'
  | 'extensions'
  | 'about';

export type PiStudioExtensionAction =
  | { kind: 'openSettings'; panel?: PiStudioSettingsPage }
  | { kind: 'openPanel'; panelId: string }
  | { kind: 'sendPrompt'; text: string; submit?: boolean }
  | { kind: 'copyText'; text: string }
  | { kind: 'openUrl'; url: `http://${string}` | `https://${string}` }
  | { kind: 'runCommand'; commandId: string };

export type PiStudioExtensionTone = 'neutral' | 'info' | 'success' | 'warning' | 'error';
export type PiStudioExtensionStatus =
  | 'pending'
  | 'active'
  | 'success'
  | 'warning'
  | 'error'
  | 'neutral';
export type PiStudioExtensionDensity = 'compact' | 'comfortable' | 'spacious';
export type PiStudioExtensionChartTone = 'accent' | 'info' | 'success' | 'warning' | 'error';
export type PiStudioExtensionButtonTone = 'default' | 'primary' | 'danger';

export interface PiStudioExtensionActionButton {
  id: string;
  label: string;
  tone?: PiStudioExtensionButtonTone;
  action: PiStudioExtensionAction;
}

export interface PiStudioExtensionMetric {
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
  tone?: PiStudioExtensionTone;
}

export interface PiStudioExtensionChartSeries {
  id: string;
  label: string;
  values: number[];
  tone?: PiStudioExtensionChartTone;
}

export interface PiStudioExtensionTimelineItem {
  id: string;
  title: string;
  detail?: string;
  time?: string;
  status?: PiStudioExtensionStatus;
}

export interface PiStudioExtensionStatusItem {
  id: string;
  label: string;
  detail?: string;
  status?: PiStudioExtensionStatus;
}

export interface PiStudioExtensionTableColumn {
  key: string;
  label: string;
  align?: 'left' | 'right' | 'center';
}

export type PiStudioExtensionTableValue = string | number | boolean | null;

/**
 * A fully qualified `<scope>:<manifest-id>/<contribution-id>` identity.
 * Host normalizers resolve short command and panel references in manifests.
 */
export type PiStudioExtensionContributionId = string;

/**
 * Declarative UI is data-only. Studio owns layout, colors, typography,
 * animation, accessibility and responsive behavior.
 */
export type PiStudioExtensionContent =
  | { kind: 'heading'; text: string; level?: 2 | 3 }
  | { kind: 'text'; text: string }
  | { kind: 'divider' }
  | { kind: 'list'; items: Array<{ title?: string; text: string }> }
  | { kind: 'keyValue'; items: Array<{ label: string; value: string }> }
  | {
      kind: 'notice';
      tone?: 'info' | 'success' | 'warning' | 'error';
      title?: string;
      text: string;
    }
  | { kind: 'actions'; buttons: PiStudioExtensionActionButton[] }
  | { kind: 'badge'; label: string; tone?: PiStudioExtensionTone }
  | {
      kind: 'emptyState';
      title: string;
      text?: string;
      action?: PiStudioExtensionActionButton;
    }
  | {
      kind: 'section';
      title?: string;
      description?: string;
      tone?: PiStudioExtensionTone;
      density?: PiStudioExtensionDensity;
      content: PiStudioExtensionContent[];
    }
  | {
      kind: 'stack';
      gap?: PiStudioExtensionDensity;
      content: PiStudioExtensionContent[];
    }
  | {
      kind: 'grid';
      columns?: 1 | 2 | 3 | 4;
      density?: PiStudioExtensionDensity;
      content: PiStudioExtensionContent[];
    }
  | {
      kind: 'tabs';
      activeTab?: string;
      tabs: Array<{ id: string; label: string; content: PiStudioExtensionContent[] }>;
    }
  | {
      kind: 'disclosure';
      title: string;
      description?: string;
      open?: boolean;
      content: PiStudioExtensionContent[];
    }
  | ({ kind: 'metric' } & PiStudioExtensionMetric)
  | {
      kind: 'metricGrid';
      columns?: 1 | 2 | 3 | 4;
      metrics: PiStudioExtensionMetric[];
    }
  | {
      kind: 'sparkline';
      label: string;
      values: number[];
      unit?: string;
      tone?: PiStudioExtensionChartTone;
    }
  | {
      kind: 'chart';
      title: string;
      description?: string;
      labels?: string[];
      series: PiStudioExtensionChartSeries[];
      unit?: string;
    }
  | { kind: 'timeline'; title?: string; items: PiStudioExtensionTimelineItem[] }
  | { kind: 'statusList'; title?: string; items: PiStudioExtensionStatusItem[] }
  | {
      kind: 'table';
      title?: string;
      columns: PiStudioExtensionTableColumn[];
      rows: Array<Record<string, PiStudioExtensionTableValue>>;
    }
  | {
      kind: 'progress';
      label: string;
      value: number;
      max?: number;
      detail?: string;
      tone?: PiStudioExtensionChartTone;
    }
  | {
      kind: 'dataView';
      sourceId: PiStudioExtensionContributionId;
      emptyText?: string;
      fallback?: PiStudioExtensionContent[];
    };

export type PiStudioExtensionUiSlot =
  | 'workspace.sidebar'
  | 'conversation.header'
  | 'conversation.detail'
  | 'conversation.footer'
  | 'composer.before'
  | 'settings.panel'
  | 'panel.side'
  | 'status.bar';

export type PiStudioExtensionCommandPlacement =
  | 'composer'
  | 'command-menu'
  | 'session'
  | 'workspace';

export interface PiStudioExtensionToolContribution {
  name: string;
  description?: string;
}

export interface PiStudioExtensionCommandContribution {
  id: string;
  title: string;
  description?: string;
  placement?: PiStudioExtensionCommandPlacement;
  argumentHint?: string;
  icon?: string;
  action?: PiStudioExtensionAction;
}

export interface PiStudioExtensionPanelContribution {
  id: string;
  title: string;
  description?: string;
  slot: PiStudioExtensionUiSlot;
  icon?: string;
  size?: 'compact' | 'regular';
  priority?: number;
  content?: PiStudioExtensionContent[];
}

export interface PiStudioExtensionSettingContribution {
  id: string;
  title: string;
  description?: string;
  content?: PiStudioExtensionContent[];
}

export interface PiStudioExtensionComposerContribution {
  id: string;
  title: string;
  description?: string;
  action: string;
  argumentHint?: string;
  icon?: string;
}

export interface PiStudioExtensionDataSourceContribution {
  id: string;
  title: string;
  description?: string;
}

export interface PiStudioExtensionContributions {
  tools?: PiStudioExtensionToolContribution[];
  commands?: PiStudioExtensionCommandContribution[];
  panels?: PiStudioExtensionPanelContribution[];
  settings?: PiStudioExtensionSettingContribution[];
  composer?: PiStudioExtensionComposerContribution[];
  dataSources?: PiStudioExtensionDataSourceContribution[];
}

/**
 * Distribution metadata accepted from an extension package. Version ranges,
 * package paths and URL constraints are revalidated by the host.
 */
export interface PiStudioExtensionManifest {
  $schema?: string;
  format: PiStudioExtensionApiVersion;
  id: string;
  name: string;
  version: string;
  description?: string;
  author?: string;
  publisher?: string;
  license?: string;
  repository?: `https://${string}`;
  homepage?: `https://${string}`;
  engines?: {
    piStudio?: string;
  };
  keywords?: string[];
  icon?: string;
  readme?: string;
  /**
   * Host-owned ownership tier for Studio built-ins. User and project packages
   * must omit this field; the runtime rejects it.
   */
  tier?: PiStudioExtensionTier;
  requires?: PiStudioExtensionContributionId[];
  permissions: PiStudioExtensionPermission[];
  /**
   * Exact Studio model-provider IDs whose encrypted API key the extension may
   * request through the read-only activation capability.
   */
  providerAccess?: string[];
  runtime?: {
    durableEntry?: string;
  };
  contributes: PiStudioExtensionContributions;
}

/** Normalized host manifest passed to `activate()`. */
export interface PiStudioNormalizedExtensionManifest
  extends Omit<
    PiStudioExtensionManifest,
    'tier' | 'requires' | 'runtime' | 'contributes'
  > {
  scope: PiStudioExtensionScope;
  source: string;
  tier: PiStudioExtensionTier;
  requires: PiStudioExtensionContributionId[];
  runtime: { durableEntry: string };
  contributes: Required<PiStudioExtensionContributions>;
}

export interface PiStudioExtensionActivationContext {
  readonly apiVersion: PiStudioExtensionApiVersion;
  /** Stable database identity, for example `user:demo.extension`. */
  readonly extensionId: string;
  readonly manifestId: string;
  readonly scope: PiStudioExtensionScope;
  readonly manifest: Readonly<PiStudioNormalizedExtensionManifest>;
  /** Private, persistent storage owned by this extension and scope. */
  readonly dataDirectory: string;
  /**
   * Present only when `provider.credentials` is declared. Every call returns
   * the current value from Studio SQLite; omitted providers are rejected.
   */
  readonly providerCredentials?: {
    readonly allowedProviderIds: readonly string[];
    read(providerId: string, options?: {
      signal?: AbortSignal;
    }): Promise<{
      providerId: string;
      type: string;
      apiKey: string;
      baseUrl: string;
    } | undefined>;
  };
}

export interface PiStudioExtensionCommandContext {
  readonly extensionId: string;
  readonly manifestId: string;
  readonly scope: PiStudioExtensionScope;
  readonly sessionId?: string;
  readonly cwd?: string;
  readonly input: string;
}

export interface PiStudioExtensionCommandResult {
  message?: string;
  promptText?: string;
  submit?: boolean;
  panelId?: PiStudioExtensionContributionId;
  settingsPage?: PiStudioSettingsPage;
  action?: PiStudioExtensionAction;
}

export type PiStudioExtensionCommandHandler = (
  context: Readonly<PiStudioExtensionCommandContext>,
) =>
  | PiStudioExtensionCommandResult
  | string
  | void
  | Promise<PiStudioExtensionCommandResult | string | void>;

export type PiStudioExtensionCommands =
  | Record<string, PiStudioExtensionCommandHandler>
  | Map<string, PiStudioExtensionCommandHandler>;

export interface PiStudioExtensionDataViewContext {
  readonly sourceId: PiStudioExtensionContributionId;
  readonly extensionId: string;
  readonly cwd: string;
  readonly sessionId: string;
  readonly webContentsId: number;
}

export interface PiStudioExtensionDataViewValue {
  content: PiStudioExtensionContent[];
}

export type PiStudioExtensionDataViewContent =
  | PiStudioExtensionContent[]
  | PiStudioExtensionDataViewValue;

export type PiStudioExtensionDataViewPublish = (
  value: PiStudioExtensionDataViewContent,
) => void;

export type PiStudioExtensionDataViewCleanup =
  | void
  | (() => void | Promise<void>)
  | Promise<void | (() => void | Promise<void>)>;

export interface PiStudioExtensionDataSourceProvider {
  read(
    context: Readonly<PiStudioExtensionDataViewContext>,
  ): PiStudioExtensionDataViewContent | Promise<PiStudioExtensionDataViewContent>;
  subscribe?(
    context: Readonly<PiStudioExtensionDataViewContext>,
    publish: PiStudioExtensionDataViewPublish,
  ): PiStudioExtensionDataViewCleanup;
}

export type PiStudioExtensionDataSources =
  | Record<string, PiStudioExtensionDataSourceProvider>
  | Map<string, PiStudioExtensionDataSourceProvider>;

/** Release resources acquired by activate(): timers, listeners or clients. */
export type PiStudioExtensionCleanup = () => void | Promise<void>;

export interface PiStudioExtensionActivation {
  durableExtension?: DurableExtension;
  commands?: PiStudioExtensionCommands;
  dataSources?: PiStudioExtensionDataSources;
  /** Called once when the extension is reloaded, disabled or removed. */
  cleanup?: PiStudioExtensionCleanup;
}

/**
 * Optional module exports read by the host when `activate()` is absent.
 * An extension may use either exports or `activate()`.
 */
export declare const durableExtension: DurableExtension | undefined;
export declare const commands: PiStudioExtensionCommands | undefined;
export declare const dataSources: PiStudioExtensionDataSources | undefined;

export declare function activate(
  context: Readonly<PiStudioExtensionActivationContext>,
): PiStudioExtensionActivation | Promise<PiStudioExtensionActivation>;

/**
 * Optional lifecycle export for module-style extensions. The host calls this
 * once before reload, disable, trust revocation, rollback or uninstall.
 */
export declare function deactivate(
  context: Readonly<PiStudioExtensionActivationContext> | undefined,
): void | Promise<void>;
