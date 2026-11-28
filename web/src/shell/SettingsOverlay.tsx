import { lazy, useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type ComponentProps, type ReactNode, type RefObject } from 'react';
import { BookOpen, Plus, RotateCw } from 'lucide-react';
import { LoadingState } from '../shared/LoadingState';
import type { DiscoveredModel } from '../features/models/model-settings-types';
import type { ModelOption, ModelSelection } from '../types/model-types';
import type { SettingsDraftGuard } from '../shared/settings-draft-guard';
import type { PermissionMode } from './app-shell-config';
import type {
  SettingsSnapshot,
  PiWorkspace,
} from './app-types';
import type { PluginWorkspaceSection, SettingsTab } from './app-shell-config';
import { isPluginWorkspaceTab } from './app-shell-config';
import type { SettingsWorkspace } from './useSettingsWorkspace';
import { SettingsDraftContext } from '../shared/SettingsDraftGuard';
import { DeferredSettingsBoundary } from '../shared/DeferredSettingsBoundary';
import { SettingsToast, useSettingsToast } from '../shared/SettingsToast';
import { errorText } from '../shared/error-text';
import { quotaExtensionAvailable } from '../types/provider-quota';
import { SettingsEditorDialog } from './SettingsEditorDialog';
import type { ModalDismiss } from '../shared/useModalDialog';
import { ShellHeader } from './ShellLayout';
import { isComposingKey } from '../shared/keyboard-navigation';
import { apiTypeOptions } from './app-shell-config';
import { PluginWorkspaceAction, PluginWorkspaceHeader } from '../features/plugins/PluginWorkspaceHeader';

const loadAgentToolsSettings = () => import('../features/tools/AgentToolsSettings');
const loadHarnessSettings = () => import('../features/harness/HarnessSettings');
const loadPermissionPolicySettings = () => import('../features/permissions/PermissionPolicySettings');
const loadSecretVaultSettings = () => import('../features/permissions/SecretVaultSettings');
const loadSkillHub = () => import('../features/skills/SkillHub');
const loadAgentsSettings = () => import('../features/agents/AgentsSettings');
const loadUsageSettings = () => import('../features/usage/UsageSettings');
const loadArchivedConversationsSettings = () => import('../features/archives/ArchivedConversationsSettings');
const loadDeviceStorageSettings = () => import('../features/storage/DeviceStorageSettings');
const loadShortcutSettings = () => import('./ShortcutSettings');
const loadModelSettings = () => import('../features/models/ModelSettings');
const loadMcpSettings = () => import('../features/mcp/McpSettings');
const loadPluginSettings = () => import('../features/plugins/PluginSettings');
const loadInstalledSkills = () => import('../features/skills/InstalledSkills');
const loadPublisherTrustSettings = () => import('../features/extensions/PublisherTrustSettings');
const loadInstalledExtensionsSection = () => import('../features/extensions/InstalledExtensionsSection');
const loadGeneralSettings = () => import('../features/appearance/GeneralSettings');
const loadNetworkSettings = () => import('../features/network/NetworkSettings');
const loadGitSettings = () => import('../features/git/GitSettings');
const loadAboutSettings = () => import('../features/about/AboutSettings');
const loadBrowserSettings = () => import('../features/browser/BrowserSettings');
const loadDesktopControlSettings = () => import('../features/desktop-control/DesktopControlSettings');

const TAB_PRELOADERS: Record<string, Array<() => Promise<unknown>>> = {
  general: [loadGeneralSettings],
  shortcuts: [loadShortcutSettings],
  models: [loadModelSettings],
  usage: [loadUsageSettings],
  tools: [loadAgentToolsSettings],
  permissions: [loadPermissionPolicySettings],
  harness: [loadHarnessSettings],
  agents: [loadAgentsSettings],
  plugins: [loadPluginSettings, loadMcpSettings, loadInstalledSkills, loadSkillHub, loadInstalledExtensionsSection, loadPublisherTrustSettings],
  mcp: [loadMcpSettings, loadPluginSettings],
  skills: [loadInstalledSkills, loadSkillHub],
  extensions: [loadInstalledExtensionsSection, loadPublisherTrustSettings],
  browser: [loadBrowserSettings],
  'desktop-control': [loadDesktopControlSettings],
  git: [loadGitSettings],
  network: [loadNetworkSettings],
  secrets: [loadSecretVaultSettings],
  archives: [loadArchivedConversationsSettings],
  storage: [loadDeviceStorageSettings],
  about: [loadAboutSettings],
};

export function preloadSettingsTab(id: string) {
  const loaders = TAB_PRELOADERS[id];
  if (!loaders) return;
  for (const load of loaders) void load().catch(() => {});
}

const AgentToolsSettings = lazy(async () => {
  const module = await loadAgentToolsSettings();
  return { default: module.AgentToolsSettings };
});
const HarnessSettings = lazy(async () => {
  const module = await loadHarnessSettings();
  return { default: module.HarnessSettings };
});
const PermissionPolicySettings = lazy(async () => {
  const module = await loadPermissionPolicySettings();
  return { default: module.PermissionPolicySettings };
});
const SecretVaultSettings = lazy(async () => {
  const module = await loadSecretVaultSettings();
  return { default: module.SecretVaultSettings };
});
const SkillHub = lazy(async () => {
  const module = await loadSkillHub();
  return { default: module.SkillHub };
});
const AgentsSettings = lazy(async () => {
  const module = await loadAgentsSettings();
  return { default: module.AgentsSettings };
});
const UsageSettings = lazy(async () => {
  const module = await loadUsageSettings();
  return { default: module.UsageSettings };
});
const ArchivedConversationsSettings = lazy(async () => {
  const module = await loadArchivedConversationsSettings();
  return { default: module.ArchivedConversationsSettings };
});
const DeviceStorageSettings = lazy(async () => {
  const module = await loadDeviceStorageSettings();
  return { default: module.DeviceStorageSettings };
});
const ShortcutSettings = lazy(async () => {
  const module = await loadShortcutSettings();
  return { default: module.ShortcutSettings };
});
const ModelSettings = lazy(async () => {
  const module = await loadModelSettings();
  return { default: module.ModelSettings };
});
const McpSettings = lazy(async () => {
  const module = await loadMcpSettings();
  return { default: module.McpSettings };
}) as typeof import('../features/mcp/McpSettings').McpSettings;
const PluginSettings = lazy(async () => {
  const module = await loadPluginSettings();
  return { default: module.PluginSettings };
}) as typeof import('../features/plugins/PluginSettings').PluginSettings;
const InstalledSkills = lazy(async () => {
  const module = await loadInstalledSkills();
  return { default: module.InstalledSkills };
}) as typeof import('../features/skills/InstalledSkills').InstalledSkills;

const PublisherTrustSettings = lazy(async () => {
  const module = await loadPublisherTrustSettings();
  return { default: module.PublisherTrustSettings };
});
const InstalledExtensionsSection = lazy(async () => {
  const module = await loadInstalledExtensionsSection();
  return { default: module.InstalledExtensionsSection };
});
const GeneralSettings = lazy(async () => {
  const module = await loadGeneralSettings();
  return { default: module.GeneralSettings };
});
const NetworkSettings = lazy(async () => {
  const module = await loadNetworkSettings();
  return { default: module.NetworkSettings };
});
const GitSettings = lazy(async () => {
  const module = await loadGitSettings();
  return { default: module.GitSettings };
});
const AboutSettings = lazy(async () => {
  const module = await loadAboutSettings();
  return { default: module.AboutSettings };
});

const BrowserSettings = lazy(async () => {
  const module = await loadBrowserSettings();
  return { default: module.BrowserSettings };
});

const DesktopControlSettings = lazy(async () => {
  const module = await loadDesktopControlSettings();
  return { default: module.DesktopControlSettings };
});

type WorkspaceNotices = {
  conversationListRefreshError: boolean;
  stateLoading: boolean;
  onRefreshConversations: () => void;
};

export type SettingsOverlayProps = {
  sidebar: { collapsed: boolean; setCollapsed: (collapsed: boolean) => void };
  workspace: string;
  workspaces: PiWorkspace[];
  onOpenWorktree: (path: string) => Promise<void>;
  onOpenGitChanges: () => void;
  onChooseWorkspace: () => void;
  onOpenBrowser: (url?: string) => void;
  workspaceRef: RefObject<string>;
  sessionId?: string;
  activeWorkspaceName?: string;
  models: ModelOption[];
  defaultModelSelection: ModelSelection;
  settings: SettingsWorkspace;
  settingsError: string | null;
  draftGuard: SettingsDraftGuard;
  workspaceNotices: WorkspaceNotices;
  extensionOrder: ComponentProps<typeof InstalledExtensionsSection>['displayOrder'];
  appearance: ComponentProps<typeof GeneralSettings>;
  permission: {
    cwd: string;
    sessionId?: string;
    onPolicyChanged: (state: { available: boolean; mode: PermissionMode }) => void;
  };
  archives: ComponentProps<typeof ArchivedConversationsSettings>;
  about: ComponentProps<typeof AboutSettings>;
};

/**
 * Settings content beside the shared navigation, including lazy pages and their editors.
 */
export function SettingsOverlay({
  sidebar,
  workspace,
  workspaces,
  onOpenWorktree,
  onOpenGitChanges,
  onChooseWorkspace,
  onOpenBrowser,
  workspaceRef,
  sessionId,
  activeWorkspaceName,
  models: modelOptions,
  defaultModelSelection,
  settings,
  settingsError,
  draftGuard,
  workspaceNotices,
  extensionOrder,
  appearance,
  permission,
  archives,
  about,
}: SettingsOverlayProps) {
  const showToast = useSettingsToast();
  const { state, controller, submitEditor } = settings;
  const {
    settingsOpen: open,
    settingsTab: tab,
    settingsAnchor,
    setSettingsAnchor,
    pluginSection,
    agentSection,
    settingsData: data,
    settingsContentRef: contentRef,
    resourceWriteBusy,
    modelRefreshError,
    modelRefreshSummary,
    modelRefreshBusy,
    mcpRefreshError,
    mcpRefreshSummary,
    mcpRefreshBusy,
    extensionRefreshError,
    extensionRefreshBusy,
    skillRefreshError,
    skillRefreshSummary,
    skillRefreshBusy,
    enabledModels,
    defaultModelBusy,
    providerModels,
    providerCatalogState,
    providerDiscovery,
    expandedProvider,
    modelView,
    modelQuery,
    setModelView,
    setModelQuery,
    setProviderDiscovery,
    resourcePendingRef,
    openMcpDetail,
    skillRefreshRequestRef,
    editor: editorValue,
    editorError,
    editorLoading,
    editorSaving,
    editorCommitted,
    editorUnavailable,
    editorRequestId,
    providerDraft,
    setProviderDraft,
    customModel,
    setCustomModel,
    tokenUnits,
    resourceScope,
    setResourceScope,
    skillWorkspace,
    setSkillWorkspace,
    mcpDraft,
    setMcpDraft,
    mcpTesting,
    mcpTestResult,
    officialExtensions,
    officialExtensionsBusy,
    officialExtensionsError,
    officialExtensionBusyId,
    setExtensionDetail,
    setExtensionInstallerOpen,
    setExtensionInstallPreview,
    openSkillDetail,
    deleteSkill,
    toggleSkillTrust,
    setSettingsData,
  } = state;
  const notices = {
    ...workspaceNotices,
    modelRefreshError,
    modelRefreshSummary,
    modelRefreshBusy,
    mcpRefreshError,
    mcpRefreshSummary,
    mcpRefreshBusy,
    extensionRefreshError,
    extensionRefreshBusy,
    skillRefreshError,
    skillRefreshSummary,
    skillRefreshBusy,
    resourceWriteBusy,
  };
  const models = {
    models: modelOptions,
    enabledModels,
    defaultModelSelection,
    defaultModelBusy,
    recoveryPending: resourcePendingRef.current.models,
    providerModels,
    providerCatalogState,
    providerDiscovery,
    expandedProvider,
    modelView,
    modelQuery,
    setModelView,
    setModelQuery,
    setProviderDiscovery,
  };
  const mcp = {
    recoveryPending: resourcePendingRef.current.mcp,
    openDetail: openMcpDetail,
  };
  const skills = {
    workspace,
    workspaces,
    workspaceRef,
    activeWorkspaceName,
    skillRefreshRequestRef,
    recoveryPending: resourcePendingRef.current.skills,
    acceptSkillResources: controller.acceptSkillResources,
    reportSkillRefresh: controller.reportSkillRefresh,
    openSkillDetail,
    toggleSkillTrust,
    deleteSkill,
    notify: showToast,
  };
  const extensions = {
    officialExtensions,
    officialExtensionsBusy,
    officialExtensionsError,
    officialExtensionBusyId,
    setExtensionDetail,
    setExtensionInstallerOpen,
    setExtensionInstallPreview,
  };
  const error = settingsError;
  const updateData = (update: (current: SettingsSnapshot) => SettingsSnapshot) => {
    setSettingsData((current) => current ? update(current) : current);
  };
  const editingMcpServer = editorValue?.kind === 'mcp' && editorValue.editId
    ? data?.mcp.find(server => server.name === editorValue.editId)
    : undefined;
  const editor = {
    editor: editorValue,
    editorError,
    editorLoading,
    editorSaving,
    editorCommitted,
    editorUnavailable,
    editorRequestId,
    settingsData: data,
    mediaCandidates: [
      ...(providerDiscovery[providerDraft.providerId]?.models ?? []),
      ...(data?.customModels ?? []).filter(model => model.providerId === providerDraft.providerId)
        .map(model => ({ id: model.modelId, name: model.name })),
    ],
    providerDraft,
    setProviderDraft,
    apiTypeOptions,
    customModel,
    setCustomModel,
    tokenUnits,
    changeTokenUnit: controller.changeTokenUnit,
    toggleModelReasoning: controller.toggleModelReasoning,
    toggleModelThinkingLevel: controller.toggleModelThinkingLevel,
    mcpDraft,
    setMcpDraft,
    mcpTesting,
    mcpTestResult,
    testCurrentMcp: controller.testCurrentMcp,
    mcpOAuth: editingMcpServer ? {
      serverName: editingMcpServer.name,
      connected: editingMcpServer.oauthConnected,
      workspace,
      onCommitted: (_result: unknown, _cwd: string, summary: string) => {
        controller.reportMcpOAuthCommitted(summary);
      },
      onRecovered: (snapshot: SettingsSnapshot) => {
        controller.acceptMcpResources(snapshot);
      },
      onRefresh: async () => {
        const applied = await controller.refreshMcpEditorOAuth(workspace, editorRequestId);
        if (!applied) throw new Error('页面状态已变化，请重试刷新。');
      },
    } : null,
    resourceScope,
    setResourceScope,
    skillWorkspace,
    setSkillWorkspace,
    workspaces,
    skillWorkspaceOptions: state.skillWorkspaceOptions,
    onClose: (dismiss?: ModalDismiss) => void controller.closeEditor(dismiss),
    onRetryLoad: () => {
      if (editorValue?.editId) void controller.openEditor(editorValue.kind, editorValue.editId, editorValue.providerId, true);
    },
    onSubmit: submitEditor,
  };
  // Search, dialogs and popovers handle Escape before it closes Settings.
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || isComposingKey(event)) return;
      if (document.querySelector('dialog[open], [popover="auto"]:popover-open, [data-status-popover="open"]')) return;
      event.preventDefault();
      void controller.closeSettings();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [controller, open]);

  const expandRef = useRef<HTMLButtonElement>(null);
  const pluginTabsId = useId();
  const [pluginToolbar, setPluginToolbar] = useState<HTMLDivElement | null>(null);
  const onPluginHub = isPluginWorkspaceTab(tab);
  const hubSection = onPluginHub ? (pluginSection || 'plugins') : 'plugins';
  const clearSettingsAnchor = useCallback(() => setSettingsAnchor(undefined), [setSettingsAnchor]);
  useEffect(() => {
    if (open && sidebar.collapsed) expandRef.current?.focus({ preventScroll: true });
  }, [open, sidebar.collapsed]);
  useEffect(() => {
    if (!open) return undefined;
    const warm = () => {
      for (const id of Object.keys(TAB_PRELOADERS)) preloadSettingsTab(id);
    };
    if (typeof window.requestIdleCallback === 'function') {
      const handle = window.requestIdleCallback(warm, { timeout: 900 });
      return () => window.cancelIdleCallback(handle);
    }
    const timer = window.setTimeout(warm, 250);
    return () => window.clearTimeout(timer);
  }, [open]);
  useLayoutEffect(() => {
    if (open && contentRef.current) contentRef.current.scrollTop = 0;
  }, [open, tab, hubSection, contentRef]);

  if (!open) return null;
  const resourceBusy = notices.resourceWriteBusy;
  const select = (id: string) => { void controller.selectSettingsTab(id as SettingsTab); };
  const selectPluginSection = (section: PluginWorkspaceSection) => {
    void controller.selectPluginSection(section);
  };
  const boundaryKey = onPluginHub ? 'plugins' : tab;
  const needsSnapshot = tab === 'models' || tab === 'tools' || tab === 'harness' || tab === 'about' || onPluginHub;
  const waitingForSnapshot = needsSnapshot && !data && !error;
  const frameKey = `${boundaryKey}:${waitingForSnapshot ? 'loading' : 'ready'}`;
  let pluginActions: ReactNode;
  if (hubSection === 'mcp' && data?.mcp.length) {
    const refreshBusy = notices.mcpRefreshBusy;
    pluginActions = <>
      <PluginWorkspaceAction label={refreshBusy ? '正在刷新…' : '刷新状态'} ariaLabel="刷新 MCP 服务器状态"
        icon={<RotateCw className={refreshBusy ? 'spin' : undefined} aria-hidden="true" />}
        disabled={resourceBusy || refreshBusy || mcp.recoveryPending} onClick={() => void controller.refreshSavedMcpConfiguration()} />
      <PluginWorkspaceAction label="添加服务器" ariaLabel="添加 MCP 服务器" icon={<Plus aria-hidden="true" />}
        primary disabled={resourceBusy || refreshBusy} onClick={() => void controller.openEditor('mcp')} />
    </>;
  } else if (hubSection === 'skills') {
    pluginActions = <PluginWorkspaceAction label="添加技能" icon={<Plus aria-hidden="true" />} primary
      onClick={() => void controller.openEditor('skill')} />;
  } else if (hubSection === 'extensions') {
    pluginActions = <>
      <PluginWorkspaceAction label="开发与发布" icon={<BookOpen aria-hidden="true" />}
        onClick={() => void window.piApi.openExternal('https://github.com/huangrx6/pi-studio/blob/main/docs/extensions/distribution.md')} />
      <PluginWorkspaceAction label="重新加载" icon={<RotateCw className={notices.extensionRefreshBusy ? 'spin' : undefined} aria-hidden="true" />}
        disabled={resourceBusy || notices.extensionRefreshBusy} onClick={() => void controller.reloadExtensions()} />
      <PluginWorkspaceAction label="安装扩展" icon={<Plus aria-hidden="true" />} primary
        disabled={resourceBusy || notices.extensionRefreshBusy || Boolean(notices.extensionRefreshError)} onClick={() => {
          extensions.setExtensionInstallPreview(null);
          extensions.setExtensionInstallerOpen(true);
        }} />
    </>;
  }

  return (
    <SettingsDraftContext.Provider value={draftGuard}>
      <section className="settings-overlay" aria-labelledby="settings-window-title">
        <div className="content-region">
          <ShellHeader
            className="settings-header"
            onExpandSidebar={sidebar.collapsed ? () => sidebar.setCollapsed(false) : undefined}
            expandRef={expandRef}
          >
            <span id="settings-window-title">设置</span>
          </ShellHeader>
        <main className="shell-canvas settings-content" ref={contentRef as RefObject<HTMLElement>}>
          <DeferredSettingsBoundary
            key={boundaryKey}
            isGeneral={tab === 'general'}
            onOpenGeneral={() => select('general')}
          >
            <div className="settings-page-frame" key={frameKey}>
            {notices.conversationListRefreshError && (
              <SettingsToast message="操作已完成，但会话列表刷新失败。" tone="error">
                <button type="button" className="settings-outline" disabled={notices.stateLoading} onClick={notices.onRefreshConversations}>
                  {notices.stateLoading ? '正在刷新…' : '刷新会话列表'}
                </button>
              </SettingsToast>
            )}
            {error && <div className="settings-error" role="alert">{error}</div>}
            {tab === 'models' && notices.modelRefreshError && (
              <SettingsToast tone="error" message={`${notices.modelRefreshSummary}，刷新尚未完成。${notices.modelRefreshError}`}>
                <button type="button" className="settings-outline" disabled={notices.modelRefreshBusy} onClick={() => void controller.refreshSavedModelConfiguration()}>
                  {notices.modelRefreshBusy ? '正在刷新…' : '刷新模型配置'}
                </button>
              </SettingsToast>
            )}
            {onPluginHub && hubSection === 'mcp' && notices.mcpRefreshError && (
              <SettingsToast tone="error" message={`${notices.mcpRefreshSummary}，刷新尚未完成。${notices.mcpRefreshError}`}>
                <button type="button" className="settings-outline" disabled={notices.mcpRefreshBusy || notices.resourceWriteBusy} onClick={() => void controller.refreshSavedMcpConfiguration()}>
                  {notices.mcpRefreshBusy ? '正在刷新…' : '刷新 MCP 状态'}
                </button>
              </SettingsToast>
            )}
            {onPluginHub && hubSection === 'extensions' && notices.extensionRefreshError && (
              <SettingsToast tone="error" message={notices.extensionRefreshError}>
                <button type="button" className="settings-outline" disabled={notices.extensionRefreshBusy || notices.resourceWriteBusy} onClick={() => void controller.refreshSavedExtensionConfiguration()}>
                  {notices.extensionRefreshBusy ? '正在刷新…' : '刷新扩展状态'}
                </button>
              </SettingsToast>
            )}
            {onPluginHub && hubSection === 'skills' && notices.skillRefreshError && (
              <SettingsToast tone="error" message={`${notices.skillRefreshSummary}，刷新尚未完成。${notices.skillRefreshError}`}>
                <button type="button" className="settings-outline" disabled={notices.skillRefreshBusy || notices.resourceWriteBusy} onClick={() => void controller.refreshSavedSkillConfiguration()}>
                  {notices.skillRefreshBusy ? '正在刷新…' : '刷新技能状态'}
                </button>
              </SettingsToast>
            )}
            {waitingForSnapshot && (
              <div className="settings-loading-panel">
                <LoadingState variant="panel">正在加载设置…</LoadingState>
              </div>
            )}
            {tab === 'shortcuts' && <ShortcutSettings preferences={appearance.preferences} onChange={appearance.onChange} />}
            {tab === 'general' && <GeneralSettings {...appearance} onOpenBrowserSettings={() => select('browser')} />}
            {tab === 'network' && <NetworkSettings />}
            {tab === 'browser' && <BrowserSettings onOpenBrowser={(view) => {
              void controller.closeSettings({ restoreFocus: false }).then(closed => { if (closed) onOpenBrowser(view); });
            }} />}
            {tab === 'desktop-control' && <DesktopControlSettings />}
            {tab === 'secrets' && <SecretVaultSettings />}
            {tab === 'git' && <GitSettings cwd={workspace} workspaces={workspaces} preferences={appearance.preferences}
              onChange={appearance.onChange} onOpenWorktree={onOpenWorktree} onChooseWorkspace={onChooseWorkspace}
              onOpenChanges={sessionId ? () => {
                void controller.closeSettings({ restoreFocus: false }).then(closed => { if (closed) onOpenGitChanges(); });
              } : undefined} />}
            {tab === 'permissions' && (
              <PermissionPolicySettings
                cwd={permission.cwd}
                sessionId={permission.sessionId}
                initialProfiles={data?.permissionProfiles}
                onPolicyChanged={permission.onPolicyChanged}
                onProfilesUpdated={(permissionProfiles) => updateData((current) => ({ ...current, permissionProfiles }))}
              />
            )}
            {tab === 'archives' && <ArchivedConversationsSettings {...archives} />}
            {tab === 'storage' && <DeviceStorageSettings onOpenArchives={() => select('archives')} onOpenWorktrees={() => select('subagent-worktrees')} />}
            {data && tab === 'tools' && (
              <AgentToolsSettings
                cwd={skills.workspace}
                initialProfiles={data.toolProfiles}
                mcpServers={data.mcp}
                onOpenMcp={() => selectPluginSection('mcp')}
                onOpenExtensions={() => selectPluginSection('extensions')}
                onSaved={(snapshot) => updateData((current) => ({
                  ...current,
                  ...(snapshot.agentTools ? { agentTools: snapshot.agentTools } : {}),
                  toolProfiles: snapshot.toolProfiles,
                  ...(snapshot.temporaryCapabilities ? { temporaryCapabilities: snapshot.temporaryCapabilities } : {}),
                }))}
              />
            )}
            {data && tab === 'harness' && (
              <HarnessSettings
                key={skills.workspace}
                cwd={skills.workspace}
                initial={data.harness}
                enabledTools={[...data.agentTools.enabled.filter(name => !name.startsWith('mcp__')),
                  ...(data.mcp || []).flatMap(server => server.tools?.filter(tool => tool.enabled).map(tool => tool.name) || [])]}
                onUpdated={(harness) => updateData((current) => ({ ...current, harness }))}
                onCompactionRevealed={settingsAnchor === 'harness-compaction' ? clearSettingsAnchor : undefined}
              />
            )}
            {tab === 'agents' && (
              <AgentsSettings
                section={agentSection || 'main'}
                onSectionChange={(section) => void controller.selectAgentSection(section)}
                cwd={skills.workspace}
                workspaces={skills.workspaces}
                models={models.models}
                toolProfiles={data?.toolProfiles}
                permissionProfiles={data?.permissionProfiles}
                harness={data?.harness}
                temporaryCapabilities={data?.temporaryCapabilities}
                onToolProfilesChange={(toolProfiles, temporaryCapabilities) => updateData((current) => {
                  const main = toolProfiles.profiles.find(p => p.id === toolProfiles.activeMainProfileId);
                  return {
                    ...current,
                    toolProfiles,
                    ...(main ? { agentTools: { enabled: main.enabled, sources: main.sources } } : {}),
                    ...(temporaryCapabilities ? { temporaryCapabilities } : {}),
                  };
                })}
                onPermissionProfilesChange={(permissionProfiles) => updateData((current) => ({ ...current, permissionProfiles }))}
                onHarnessChange={(harness) => updateData((current) => ({ ...current, harness }))}
                onOpenTab={(target) => select(target)}
                onWorktreesRevealed={settingsAnchor === 'subagent-worktrees' ? clearSettingsAnchor : undefined}
              />
            )}
            {tab === 'usage' && <UsageSettings
              active={open}
              includeRemoved={appearance.preferences.usageIncludeRemovedProjects}
              onIncludeRemovedChange={value => appearance.onChange('usageIncludeRemovedProjects', value)}
              onOpenExtensions={() => selectPluginSection('extensions')}
            />}
            {data && tab === 'models' && <ModelSettings
              providers={data.providers}
              quotaAvailable={quotaExtensionAvailable(data.extensions)}
              models={models.models}
              enabledModels={models.enabledModels}
              defaultModelSelection={models.defaultModelSelection}
              defaultModelBusy={models.defaultModelBusy}
              settingsBusy={resourceBusy}
              recoveryPending={models.recoveryPending}
              providerModels={models.providerModels}
              providerCatalogState={models.providerCatalogState}
              providerDiscovery={models.providerDiscovery}
              expandedProvider={models.expandedProvider}
              modelView={models.modelView}
              modelQuery={models.modelQuery}
              actions={{
                onModelViewChange: models.setModelView,
                onModelQueryChange: models.setModelQuery,
                onSelectDefaultModel: (id) => void controller.selectDefaultModel(id),
                onSelectDefaultThinking: (level) => void controller.selectDefaultThinking(level),
                onAddProvider: () => void controller.openEditor('provider'),
                onEditProvider: (id) => void controller.openEditor('provider', id),
                onSetEnabled: (ids) => void controller.setEnabled(ids),
                onManageProvider: (id) => controller.loadProviderModels(id),
                onReloadProvider: (id) => controller.refreshProviderModels(id).catch(() => {}),
                onDiscoverProvider: (id) => void controller.discoverProviderModels(id),
                onOpenModelEditor: controller.openModelEditor,
                onDeleteModel: (id, item) => void controller.deleteCustomModel(id, item),
                onToggleProvider: (provider, enabled) => void controller.toggleProvider(provider, enabled),
                onDeleteProvider: (provider) => void controller.deleteProvider(provider),
                onDiscoverySelection: (id, selected) => models.setProviderDiscovery((current) => ({
                  ...current,
                  [id]: { ...current[id], selected },
                })),
                onDismissDiscovery: (id) => models.setProviderDiscovery((current) => {
                  const next = { ...current };
                  delete next[id];
                  return next;
                }),
                onImportModels: (id, items: DiscoveredModel[]) => void controller.importProviderModels(id, items),
              }}
            />}
            {data && onPluginHub && (
              <div className="settings-preference-page plugin-workspace" data-section={hubSection}>
                <PluginWorkspaceHeader id={pluginTabsId} section={hubSection} actions={pluginActions}
                  actionsRef={hubSection === 'plugins' ? setPluginToolbar : undefined} onChange={selectPluginSection} />
                <div className="plugin-workspace-panel" key={hubSection} role="tabpanel" tabIndex={0}
                  id={`${pluginTabsId}-panel`} aria-labelledby={`${pluginTabsId}-${hubSection}`}>
                {hubSection === 'plugins' && <PluginSettings
                  toolbar={pluginToolbar}
                  plugins={data.plugins || []}
                  busy={resourceBusy}
                  cwd={workspace}
                  onChanged={(settings, message) => {
                    controller.invalidateResourceReads();
                    controller.acceptRuntimeSnapshot(settings, message);
                  }}
                  onOpenResource={selectPluginSection}
                />}
                {hubSection === 'mcp' && <McpSettings
                  servers={data.mcp}
                  busy={resourceBusy}
                  recoveryPending={mcp.recoveryPending}
                  refreshBusy={notices.mcpRefreshBusy}
                  onAdd={() => void controller.openEditor('mcp')}
                  onOpen={mcp.openDetail}
                  onEdit={(name) => void controller.openEditor('mcp', name)}
                  onToggle={(name, enabled) => void controller.toggleMcp(name, enabled)}
                  onDelete={(name) => void controller.deleteMcp(name)}
                  onBrowsePlugins={() => selectPluginSection('plugins')}
                />}
                {hubSection === 'skills' && (
                  <div className="settings-sections">
                    <InstalledSkills
                      skills={data.skills}
                      errors={data.skillErrors}
                      paths={{ userStudio: data.skillsPath, userAgents: data.agentsSkillsPath, projectStudio: data.projectSkillsPath, projectAgents: data.projectAgentsSkillsPath }}
                      workspaceName={skills.activeWorkspaceName}
                      busy={resourceBusy || skills.recoveryPending}
                      onOpen={skills.openSkillDetail}
                      onTrust={(skill) => skills.toggleSkillTrust(skill, true)}
                      onDelete={(skill) => skills.deleteSkill(skill)}
                    />
                    <SkillHub
                      workspace={skills.workspace}
                      workspaces={skills.workspaces}
                      userSkillsPath={data.skillsPath}
                      sharedSkillsPath={data.agentsSkillsPath}
                      onCommitted={(result, cwd) => {
                        controller.invalidateResourceReads();
                        controller.reportSkillRefresh(cwd, `技能「${result.installed.name}」已安装`, result.projection.status === 'error' ? result.projection.message : '请刷新当前技能状态。');
                      }}
                      onInstalled={async (result, cwd) => {
                        if (skills.workspace !== skills.workspaceRef.current) return;
                        if (result.projection.status !== 'ready') throw new Error(result.projection.message);
                        const revision = skills.skillRefreshRequestRef.current;
                        try {
                          const snapshot = cwd === skills.workspace ? result.projection.value : await window.piApi.settings(skills.workspace);
                          if (skills.workspace !== skills.workspaceRef.current || revision !== skills.skillRefreshRequestRef.current) return;
                          skills.acceptSkillResources(snapshot, cwd);
                          skills.notify(`技能「${result.installed.name}」已安装`, 'success');
                        } catch (error) {
                          if (skills.workspace === skills.workspaceRef.current && revision === skills.skillRefreshRequestRef.current) skills.reportSkillRefresh(cwd, `技能「${result.installed.name}」已安装`, errorText(error));
                          throw error;
                        }
                      }}
                      onNotify={(message, tone = 'info') => skills.notify(message, tone)}
                    />
                  </div>
                )}
                {hubSection === 'extensions' && (
                  <div className="settings-sections extensions-settings">
                    <InstalledExtensionsSection
                      items={data.extensions}
                      displayOrder={extensionOrder}
                      publisherSettings={<PublisherTrustSettings />}
                      onOpenDetail={extensions.setExtensionDetail}
                    />
                    {data.extensionErrors.length > 0 && <div className="settings-error-list" role="group" aria-label="扩展诊断">
                      {data.extensionErrors.map(item => {
                        const extension = data.extensions.find(entry => entry.id === item.id || entry.source === item.path);
                        return <details key={`${item.path}:${item.message}`}>
                          <summary><strong>{extension?.name || item.id || '扩展'}</strong> <span>{item.message}</span></summary>
                          <code>{item.path}</code>
                        </details>;
                      })}
                    </div>}
                  </div>
                )}
                </div>
              </div>
            )}
            {data && tab === 'about' && <AboutSettings {...about} />}
            </div>
          </DeferredSettingsBoundary>
        </main>
          <div className="settings-toast-stack" />
        </div>
        {editor.editor && <SettingsEditorDialog {...editor} editor={editor.editor} />}
      </section>
    </SettingsDraftContext.Provider>
  );
}
