import { lazy, useEffect, type ComponentProps, type RefObject } from 'react';
import { BookOpen, FileCode2, Layers3, LoaderCircle, Plus, RotateCw } from 'lucide-react';
import type { DiscoveredModel } from '../features/models/model-settings-types';
import type { ModelOption, ModelSelection } from '../types/model-types';
import type { SettingsDraftGuard } from '../shared/settings-draft-guard';
import type { PermissionMode } from './app-shell-config';
import type {
  SettingsSnapshot,
  PiWorkspace,
} from './app-types';
import type { SettingsTab } from './app-shell-config';
import type { SettingsWorkspace } from './useSettingsWorkspace';
import { SettingsDraftContext } from '../shared/SettingsDraftGuard';
import { DeferredSettingsBoundary } from '../shared/DeferredSettingsBoundary';
import { SettingsPageHeader } from '../shared/SettingsPageHeader';
import { InfoHint } from '../shared/InfoHint';
import { errorText } from '../shared/error-text';
import { ExtensionSlot } from '../features/extensions/ExtensionSlot';
import { ConversationListNotice } from './ConversationListNotice';
import { SettingsEditorDialog } from './SettingsEditorDialog';
import { SettingsNavigation } from './SettingsNavigation';
import { SettingsSavedFlash } from './SettingsSavedFlash';
import { isComposingKey } from '../shared/keyboard-navigation';
import { apiTypeOptions, settingsPages } from './app-shell-config';

const AgentToolsSettings = lazy(async () => {
  const module = await import('../features/tools/AgentToolsSettings');
  return { default: module.AgentToolsSettings };
});
const HarnessSettings = lazy(async () => {
  const module = await import('../features/harness/HarnessSettings');
  return { default: module.HarnessSettings };
});
const PermissionPolicySettings = lazy(async () => {
  const module = await import('../features/permissions/PermissionPolicySettings');
  return { default: module.PermissionPolicySettings };
});
const SkillHub = lazy(async () => {
  const module = await import('../features/skills/SkillHub');
  return { default: module.SkillHub };
});
const SubagentSettings = lazy(async () => {
  const module = await import('../features/subagents/SubagentSettings');
  return { default: module.SubagentSettings };
});
const UsageSettings = lazy(async () => {
  const module = await import('../features/usage/UsageSettings');
  return { default: module.UsageSettings };
});
const ArchivedConversationsSettings = lazy(async () => {
  const module = await import('../features/archives/ArchivedConversationsSettings');
  return { default: module.ArchivedConversationsSettings };
});
const ShortcutSettings = lazy(async () => {
  const module = await import('./ShortcutSettings');
  return { default: module.ShortcutSettings };
});
const ModelSettings = lazy(async () => {
  const module = await import('../features/models/ModelSettings');
  return { default: module.ModelSettings };
});
const McpSettings = lazy(async () => {
  const module = await import('../features/mcp/McpSettings');
  return { default: module.McpSettings };
}) as typeof import('../features/mcp/McpSettings').McpSettings;
const InstalledSkills = lazy(async () => {
  const module = await import('../features/skills/InstalledSkills');
  return { default: module.InstalledSkills };
}) as typeof import('../features/skills/InstalledSkills').InstalledSkills;

const PublisherTrustSettings = lazy(async () => {
  const module = await import('../features/extensions/PublisherTrustSettings');
  return { default: module.PublisherTrustSettings };
});
const InstalledExtensionsSection = lazy(async () => {
  const module = await import('../features/extensions/InstalledExtensionsSection');
  return { default: module.InstalledExtensionsSection };
});
const GeneralSettings = lazy(async () => {
  const module = await import('../features/appearance/GeneralSettings');
  return { default: module.GeneralSettings };
});
const AboutSettings = lazy(async () => {
  const module = await import('../features/about/AboutSettings');
  return { default: module.AboutSettings };
});

type WorkspaceNotices = {
  conversationListRefreshError: boolean;
  stateLoading: boolean;
  onRefreshConversations: () => void;
};

export type SettingsOverlayProps = {
  workspace: string;
  workspaces: PiWorkspace[];
  workspaceRef: RefObject<string>;
  sessionId?: string;
  activeWorkspaceName?: string;
  models: ModelOption[];
  defaultModelSelection: ModelSelection;
  settings: SettingsWorkspace;
  settingsError: string | null;
  draftGuard: SettingsDraftGuard;
  workspaceNotices: WorkspaceNotices;
  appearance: ComponentProps<typeof GeneralSettings>;
  permission: {
    cwd: string;
    sessionId?: string;
    onPolicyChanged: (state: { available: boolean; mode: PermissionMode }) => void;
  };
  archives: ComponentProps<typeof ArchivedConversationsSettings>;
  skillActions: {
    notify: (message: string, tone?: 'success' | 'error' | 'info') => void;
  };
  extensionContext: {
    sendPrompt: ComponentProps<typeof ExtensionSlot>['onSendPrompt'];
    notify: NonNullable<ComponentProps<typeof ExtensionSlot>['onNotify']>;
    modelRef: string;
  };
  about: ComponentProps<typeof AboutSettings>;
};

/**
 * Full-screen settings surface. App retains ownership of state and IPC; this
 * component owns the page shell, lazy-page routing and editor placement.
 */
export function SettingsOverlay({
  workspace,
  workspaces,
  workspaceRef,
  sessionId,
  activeWorkspaceName,
  models: modelOptions,
  defaultModelSelection,
  settings,
  settingsError,
  draftGuard,
  workspaceNotices,
  appearance,
  permission,
  archives,
  skillActions,
  extensionContext,
  about,
}: SettingsOverlayProps) {
  const { state, controller, submitEditor } = settings;
  const {
    settingsOpen: open,
    settingsTab: tab,
    settingsData: data,
    settingsContentRef: contentRef,
    settingsBusy,
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
    settingsBusy,
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
    notify: skillActions.notify,
  };
  const extensions = {
    officialExtensions,
    officialExtensionsBusy,
    officialExtensionsError,
    officialExtensionBusyId,
    setExtensionDetail,
    setExtensionInstallerOpen,
    setExtensionInstallPreview,
    sendPrompt: extensionContext.sendPrompt,
    notify: extensionContext.notify,
    sessionId,
    modelRef: extensionContext.modelRef,
  };
  const error = settingsError;
  const updateData = (update: (current: SettingsSnapshot) => SettingsSnapshot) => {
    setSettingsData((current) => current ? update(current) : current);
  };
  const editor = {
    editor: editorValue,
    editorError,
    editorLoading,
    editorSaving,
    editorCommitted,
    editorUnavailable,
    editorRequestId,
    settingsData: data,
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
    resourceScope,
    setResourceScope,
    skillWorkspace,
    setSkillWorkspace,
    workspaces,
    skillWorkspaceOptions: state.skillWorkspaceOptions,
    onClose: () => void controller.closeEditor(),
    onRetryLoad: () => {
      if (editorValue?.editId) void controller.openEditor(editorValue.kind, editorValue.editId, editorValue.providerId, true);
    },
    onSubmit: submitEditor,
  };
  // Esc 退出设置：内层编辑器/native dialog 自己处理 Esc，搜索框在前方已 stopPropagation。
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || isComposingKey(event)) return;
      if (document.querySelector('dialog[open]')) return;
      event.preventDefault();
      void controller.closeSettings();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [controller, open]);

  if (!open) return null;
  const resourceBusy = notices.settingsBusy || notices.resourceWriteBusy;
  const close = () => { void controller.closeSettings(); };
  const select = (id: string) => { void controller.selectSettingsTab(id as SettingsTab); };

  return (
    <SettingsDraftContext.Provider value={draftGuard}>
      <div className="settings-overlay" role="dialog" aria-modal="true" aria-label="设置">
        <SettingsNavigation
          pages={settingsPages}
          activeId={tab}
          onSelect={select}
          onBack={close}
        />
        <section className="settings-content" ref={contentRef as RefObject<HTMLElement>}>
          <DeferredSettingsBoundary
            key={tab}
            isGeneral={tab === 'general'}
            onBack={close}
            onOpenGeneral={() => select('general')}
          >
            <div className="settings-page-frame">
            {notices.conversationListRefreshError && (
              <ConversationListNotice
                busy={notices.stateLoading}
                onRefresh={notices.onRefreshConversations}
              />
            )}
            {error && <div className="settings-error" role="alert">{error}</div>}
            {tab === 'models' && notices.modelRefreshError && !editor.editor && (
              <div className="model-refresh-notice" role="alert">
                <span>{notices.modelRefreshSummary}，刷新尚未完成。{notices.modelRefreshError}</span>
                <button type="button" className="settings-outline" disabled={notices.modelRefreshBusy} onClick={() => void controller.refreshSavedModelConfiguration()}>
                  {notices.modelRefreshBusy ? '正在刷新…' : '刷新模型配置'}
                </button>
              </div>
            )}
            {tab === 'mcp' && notices.mcpRefreshError && !editor.editor && (
              <div className="model-refresh-notice" role="alert">
                <span>{notices.mcpRefreshSummary}，刷新尚未完成。{notices.mcpRefreshError}</span>
                <button type="button" className="settings-outline" disabled={notices.mcpRefreshBusy || notices.resourceWriteBusy} onClick={() => void controller.refreshSavedMcpConfiguration()}>
                  {notices.mcpRefreshBusy ? '正在刷新…' : '刷新 MCP 状态'}
                </button>
              </div>
            )}
            {tab === 'extensions' && notices.extensionRefreshError && (
              <div className="model-refresh-notice" role="alert">
                <span>{notices.extensionRefreshError}</span>
                <button type="button" className="settings-outline" disabled={notices.extensionRefreshBusy || notices.resourceWriteBusy} onClick={() => void controller.refreshSavedExtensionConfiguration()}>
                  {notices.extensionRefreshBusy ? '正在刷新…' : '刷新扩展状态'}
                </button>
              </div>
            )}
            {tab === 'skills' && notices.skillRefreshError && !editor.editor && (
              <div className="model-refresh-notice" role="alert">
                <span>{notices.skillRefreshSummary}，刷新尚未完成。{notices.skillRefreshError}</span>
                <button type="button" className="settings-outline" disabled={notices.skillRefreshBusy || notices.resourceWriteBusy} onClick={() => void controller.refreshSavedSkillConfiguration()}>
                  {notices.skillRefreshBusy ? '正在刷新…' : '刷新技能状态'}
                </button>
              </div>
            )}
            {!data && !error && tab !== 'general' && tab !== 'usage' && tab !== 'archives' && tab !== 'permissions' && tab !== 'subagents' && (
              <div className="settings-loading" role="status"><LoaderCircle className="spin" />正在加载设置…</div>
            )}
            {tab === 'shortcuts' && <ShortcutSettings preferences={appearance.preferences} onChange={appearance.onChange} />}
            {tab === 'general' && <GeneralSettings {...appearance} />}
            {tab === 'permissions' && (
              <PermissionPolicySettings
                cwd={permission.cwd}
                sessionId={permission.sessionId}
                onPolicyChanged={permission.onPolicyChanged}
              />
            )}
            {tab === 'archives' && <ArchivedConversationsSettings {...archives} />}
            {data && tab === 'tools' && (
              <AgentToolsSettings
                cwd={skills.workspace}
                initialSelection={data.agentTools}
                onSaved={(snapshot) => updateData((current) => ({ ...current, agentTools: snapshot.agentTools }))}
              />
            )}
            {data && tab === 'harness' && (
              <HarnessSettings
                cwd={skills.workspace}
                initial={data.harness}
                enabledTools={data.agentTools.enabled}
                onUpdated={(harness) => updateData((current) => ({ ...current, harness }))}
              />
            )}
            {tab === 'subagents' && <SubagentSettings
              cwd={skills.workspace}
              workspaces={skills.workspaces}
              enabledAgentTools={data?.agentTools.enabled}
              onOpenAgentTools={() => select('tools')}
            />}
            {tab === 'usage' && <UsageSettings active={open} />}
            {data && tab === 'models' && <ModelSettings
              providers={data.providers}
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
            {data && tab === 'mcp' && <McpSettings
              servers={data.mcp}
              busy={resourceBusy}
              recoveryPending={mcp.recoveryPending}
              refreshBusy={notices.mcpRefreshBusy}
              onAdd={() => void controller.openEditor('mcp')}
              onRefresh={() => void controller.refreshSavedMcpConfiguration()}
              onOpen={mcp.openDetail}
              onEdit={(name) => void controller.openEditor('mcp', name)}
              onToggle={(name, enabled) => void controller.toggleMcp(name, enabled)}
              onDelete={(name) => void controller.deleteMcp(name)}
            />}
            {data && tab === 'skills' && (
              <div className="settings-sections">
                <SettingsPageHeader
                  icon={<FileCode2 />}
                  title="技能"
                  meta={<InfoHint label="项目技能默认不加载；目录内容变化后需要重新信任，配置会在下一次请求前生效。" />}
                  actions={<button type="button" className="settings-add-button" aria-label="添加技能" onClick={() => void controller.openEditor('skill')}><Plus />添加技能</button>}
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
              </div>
            )}
            {data && tab === 'extensions' && (
              <div className="settings-sections extensions-settings">
                <SettingsPageHeader
                  icon={<Layers3 />}
                  title="扩展"
                  meta={<InfoHint label="全局扩展安装后默认信任；项目扩展必须手动信任后才能加载可执行代码。启停和信任从下一次请求开始生效。" />}
                  actions={<>
                    <button type="button" className="settings-outline" onClick={() => void window.piApi.openExternal('https://github.com/huangrx6/pi-studio/blob/main/docs/extensions-distribution.md')}><BookOpen />开发与发布</button>
                    <button type="button" className="settings-outline" disabled={resourceBusy || notices.extensionRefreshBusy} onClick={() => void controller.reloadExtensions()}><RotateCw className={notices.extensionRefreshBusy ? 'spin' : ''} />重新加载</button>
                    <button type="button" className="settings-add-button" aria-label="安装扩展" disabled={resourceBusy || notices.extensionRefreshBusy || Boolean(notices.extensionRefreshError)} onClick={() => {
                      extensions.setExtensionInstallPreview(null);
                      extensions.setExtensionInstallerOpen(true);
                    }}><Plus />安装扩展</button>
                  </>}
                />
                <PublisherTrustSettings />
                <InstalledExtensionsSection
                  items={data.extensions}
                  busy={resourceBusy || notices.extensionRefreshBusy || Boolean(notices.extensionRefreshError)}
                  placements={appearance.preferences.extensionPlacements}
                  onPlacementChange={(contributionId, placement) => appearance.onChange('extensionPlacements', {
                    ...appearance.preferences.extensionPlacements,
                    [contributionId]: placement,
                  })}
                  onOpenDetail={extensions.setExtensionDetail}
                  onToggle={(extension, enabled) => void controller.toggleExtension(extension, enabled)}
                  onDelete={(id, name) => void controller.deleteExtension(id, name)}
                />
                {data.extensionErrors.length > 0 && <div className="settings-error-list">
                  {data.extensionErrors.map((item) => <div key={`${item.path}:${item.message}`}><code>{item.path}</code><span>{item.message}</span></div>)}
                </div>}
                <ExtensionSlot
                  slot="settings.panel"
                  cwd={skills.workspace}
                  sessionId={extensions.sessionId}
                  modelRef={extensions.modelRef}
                  onOpenSettings={(page) => { if (page) void controller.openSettings(page as SettingsTab); }}
                  onSendPrompt={extensions.sendPrompt}
                  onNotify={extensions.notify}
                />
              </div>
            )}
            {data && tab === 'about' && <AboutSettings {...about} />}
            </div>
          </DeferredSettingsBoundary>
        </section>
        {/* 即时设置落盘后的确认，不改变布局。 */}
        <SettingsSavedFlash signal={appearance.preferences} />
        {editor.editor && <SettingsEditorDialog {...editor} editor={editor.editor} />}
      </div>
    </SettingsDraftContext.Provider>
  );
}
