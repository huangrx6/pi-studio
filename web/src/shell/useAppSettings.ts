import { useEffect, useMemo } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import type { ActionConfirmOptions, useActionConfirmation } from '../shared/ConfirmDialog';
import type { CommittedProjection, MutationProjection } from '../types/mutation-types';
import type { ModelResourceSnapshot } from '../global.d';
import type {
  SettingsEditor,
  SettingsSnapshot,
} from './app-types';
import type { SettingsTab } from './app-shell-config';
import type {
  ConcreteThinkingLevel,
  ModelOption,
  ModelSelection,
  ThinkingLevel,
} from '../types/model-types';
import { concreteThinkingLevels } from '../types/model-types';
import {
  DEFAULT_MODEL_THINKING_LEVELS,
  emptyCustomModelConfig,
} from '../features/models/model-settings-types';
import type {
  DiscoveredModel,
  ProviderCatalogState,
  ProviderDiscoveryState,
  ProviderModelInfo,
} from '../features/models/model-settings-types';
import type {
  ExtensionHostItem,
  ExtensionInstallPreview,
  ExtensionMutationResult,
  OfficialExtensionCatalogItem,
  OfficialExtensionCatalogSnapshot,
} from '../types/extension-types';
import type {
  McpInfo,
  McpTestResult,
  PiWorkspace,
  SkillInfo,
} from './app-types';
import type { ChatMessage, ComposerAttachment } from '../types/chat-types';
import type { ContextPolicy } from '../features/conversation/ContextUsageChip';
import type { AppNotificationAction, NotificationTone } from './NotificationCenter';
import { contextUsage } from '../features/conversation/context-usage';
import { errorText } from '../shared/error-text';
import { runtimeRefreshFailure } from '../shared/runtime-refresh';
import type { createSettingsDraftGuard } from '../shared/settings-draft-guard';
import {
  automaticTokenUnit,
  convertTokenInput,
  tokenInputAsInteger,
  tokenInputValue,
  type TokenField,
  type TokenUnit,
} from '../shared/token-units';

type Setter<T> = Dispatch<SetStateAction<T>>;
type CustomModelDraft = ReturnType<typeof emptyCustomModelConfig>;
type ProviderDraft = {
  providerId: string;
  name: string;
  baseUrl: string;
  api: string;
  apiKey: string;
  icon: string;
  modelsUrl: string;
};
type McpDraft = {
  name: string;
  transport: string;
  command: string;
  args: string;
  cwd: string;
  url: string;
  description: string;
  env: string;
  headers: string;
  exposure: string;
  timeoutSeconds: string;
  toolExposure: string;
  clearEnv: boolean;
  clearHeaders: boolean;
};

type AppSettingsDependencies = {
  [key: string]: any;
  setModelSelection: Setter<ModelSelection>;
  setDefaultModelSelection: Setter<ModelSelection>;
  setModels: Setter<ModelOption[]>;
  setEnabledModels: Setter<string[]>;
  setSettingsOpen: Setter<boolean>;
  setSettingsTab: Setter<SettingsTab>;
  setSettingsData: Setter<SettingsSnapshot | null>;
  setSettingsError: Setter<string | null>;
  setExtensionDetail: Setter<ExtensionHostItem | null>;
  setOfficialExtensions: Setter<OfficialExtensionCatalogSnapshot | null>;
  setOfficialExtensionsBusy: Setter<boolean>;
  setOfficialExtensionsError: Setter<string | null>;
  setOfficialExtensionBusyId: Setter<string | null>;
  setExtensionInstallerOpen: Setter<boolean>;
  setExtensionInstallPreview: Setter<ExtensionInstallPreview | null>;
  setEditor: Setter<SettingsEditor | null>;
  setEditorError: Setter<string | null>;
  setEditorLoading: Setter<boolean>;
  setEditorSaving: Setter<boolean>;
  setEditorCommitted: Setter<boolean>;
  setResourceScope: Setter<'user' | 'project'>;
  setSkillWorkspace: Setter<string>;
  setDefaultModelBusy: Setter<boolean>;
  setProviderDraft: Setter<ProviderDraft>;
  setMcpDraft: (update: McpDraft | ((current: McpDraft) => McpDraft)) => void;
  setMcpDraftState: Setter<McpDraft>;
  setMcpTestResult: Setter<McpTestResult | null>;
  setMcpTesting: Setter<boolean>;
  setModelQuery: Setter<string>;
  setExpandedProvider: Setter<string | null>;
  setProviderModels: Setter<Record<string, ProviderModelInfo[]>>;
  setModelRefreshError: Setter<string | null>;
  setModelRefreshBusy: Setter<boolean>;
  setModelRefreshSummary: Setter<string>;
  setMcpRefreshError: Setter<string | null>;
  setMcpRefreshSummary: Setter<string>;
  setMcpRefreshBusy: Setter<boolean>;
  setSkillRefreshError: Setter<string | null>;
  setSkillRefreshSummary: Setter<string>;
  setSkillRefreshBusy: Setter<boolean>;
  setExtensionRefreshError: Setter<string | null>;
  setExtensionRefreshBusy: Setter<boolean>;
  setResourceWriteBusy: Setter<boolean>;
  setProviderCatalogState: Setter<Record<string, ProviderCatalogState>>;
  setProviderDiscovery: Setter<Record<string, ProviderDiscoveryState>>;
  setCustomModel: Setter<CustomModelDraft>;
  setTokenUnits: Setter<Record<TokenField, TokenUnit>>;
  setMcpDetailState: Setter<McpInfo | null>;
  setSkillDetail: (value: SkillInfo | null) => void;
  setSkillDetailError: Setter<string | null>;
  setCompaction: Setter<{ active: boolean; reason?: string }>;
  setContextPolicy: Setter<ContextPolicy | null>;
  setComposerFeedback: Setter<{ message: string; tone: 'info' | 'warning' } | null>;
  settingsData: SettingsSnapshot | null;
  providerModels: Record<string, ProviderModelInfo[]>;
  providerCatalogState: Record<string, ProviderCatalogState>;
  customModel: CustomModelDraft;
  tokenUnits: Record<TokenField, TokenUnit>;
  providerDraft: ProviderDraft;
  mcpDraft: McpDraft;
  workspaces: PiWorkspace[];
  models: ModelOption[];
  composerAttachments: ComposerAttachment[];
  settingsDraftGuard: ReturnType<typeof createSettingsDraftGuard>;
  settingsLeaveConfirmation: ReturnType<typeof useActionConfirmation>;
  actionConfirmation: ReturnType<typeof useActionConfirmation>;
};

export function useAppSettingsController(deps: AppSettingsDependencies) {
  const {
    workspace,
    workspaceRef,
    sessionId,
    sessionRef,
    sessionLoadRef,
    workspaces,
    modelSelection,
    setModelSelection,
    setDefaultModelSelection,
    models,
    setModels,
    enabledModels,
    setEnabledModels,
    modelRevisionRef,
    modelWritesRef,
    modelWriteResultsRef,
    defaultModelWorkspaceRef,
    settingsRequestRef,
    catalogRequestRef,
    settingsOpen,
    setSettingsOpen,
    settingsTab,
    setSettingsTab,
    settingsData,
    setSettingsData,
    setSettingsError,
    settingsBusy,
    settingsDraftGuard,
    settingsLeaveConfirmation,
    settingsReturnFocusRef,
    actionConfirmation,
    setExtensionDetail,
    officialExtensions,
    setOfficialExtensions,
    setOfficialExtensionsBusy,
    setOfficialExtensionsError,
    officialExtensionBusyId,
    setOfficialExtensionBusyId,
    setExtensionInstallerOpen,
    setExtensionInstallPreview,
    editor,
    setEditor,
    setEditorError,
    editorLoading,
    setEditorLoading,
    setEditorSaving,
    setEditorCommitted,
    editorSaveRef,
    editorRecoveryRef,
    editorScopeRef,
    editorBaselineRef,
    editorDirtyRef,
    editorCloseRef,
    editorRequestRef,
    setResourceScope,
    skillWorkspace,
    setSkillWorkspace,
    setDefaultModelBusy,
    providerDraft,
    setProviderDraft,
    mcpDraft,
    mcpDraftRef,
    setMcpDraft,
    setMcpDraftState,
    setMcpTestResult,
    setMcpTesting,
    setModelQuery,
    expandedProvider,
    setExpandedProvider,
    providerModels,
    setProviderModels,
    setModelRefreshError,
    setModelRefreshBusy,
    setModelRefreshSummary,
    setMcpRefreshError,
    setMcpRefreshSummary,
    setMcpRefreshBusy,
    setSkillRefreshError,
    setSkillRefreshSummary,
    setSkillRefreshBusy,
    skillRefreshRequestRef,
    skillRefreshLockRef,
    skillRefreshTargetsRef,
    extensionMutationReceiptsRef,
    extensionRefreshRequestRef,
    extensionRefreshLockRef,
    setExtensionRefreshError,
    setExtensionRefreshBusy,
    mcpRefreshRequestRef,
    mcpRefreshLockRef,
    resourceWriteRef,
    resourceCommitRef,
    resourcePendingRef,
    setResourceWriteBusy,
    modelRefreshLockRef,
    modelRefreshRequestRef,
    providerCatalogState,
    setProviderCatalogState,
    providerCatalogRequestsRef,
    providerDiscoveryRequestsRef,
    setProviderDiscovery,
    customModel,
    setCustomModel,
    tokenUnits,
    setTokenUnits,
    setMcpDetailState,
    mcpDetailRef,
    mcpDetailGenerationRef,
    skillDetailRef,
    skillDetailGenerationRef,
    setSkillDetail,
    closeSkillDetail,
    setSkillDetailError,
    messages,
    compaction,
    setCompaction,
    contextPolicy,
    setContextPolicy,
    turnActiveRef,
    transcriptCacheRef,
    composerAttachments,
    setComposerFeedback,
    showComposerFeedback,
    pushNotification,
    officialCatalogRequestRef,
    originalMcpArgsRef,
    mcpTestRequestRef,
    mcpTestLockRef,
  } = deps;

  function acceptRuntimeSnapshot(snapshot: SettingsSnapshot, successMessage?: string) {
    setSettingsData(snapshot);
    const failure = runtimeRefreshFailure(snapshot.runtimeRefresh);
    if (failure) {
      setSettingsError(failure);
    } else if (successMessage) {
      setSettingsError(null);
      pushNotification(successMessage, 'success');
    }
  }

  /**
   * 打开设置页并刷新快照。
   * 设置页与对话共用同一个窗口，所以关闭后把焦点还给触发元素。
   */
  async function canLeaveSettings() {
    if (!settingsOpen) return true;
    const allowed = await settingsDraftGuard.canLeave((labels) => settingsLeaveConfirmation.confirm({
      title: '丢弃未保存的设置更改？',
      description: `尚未保存：${labels.join('、')}。离开会丢弃这些编辑；已提交的保存仍会继续。`,
      confirmLabel: '丢弃并离开',
      cancelLabel: '继续编辑',
      tone: 'danger',
    }));
    if (allowed) discardEditor();
    return allowed;
  }

  async function selectSettingsTab(tab: SettingsTab) {
    if (tab === settingsTab) return;
    if (!await canLeaveSettings()) return;
    setSettingsTab(tab);
    setModelQuery('');
  }

  async function closeSettings() {
    if (await canLeaveSettings()) setSettingsOpen(false);
  }

  async function openSettings(tab?: SettingsTab) {
    if (settingsOpen && tab && tab !== settingsTab && !await canLeaveSettings()) return;
    if (!settingsOpen) settingsReturnFocusRef.current = document.activeElement as HTMLElement;
    if (tab) setSettingsTab(tab);
    setSettingsOpen(true);
    setSettingsError(null);
    const request = ++settingsRequestRef.current;
    const revision = modelRevisionRef.current.get(`default:${workspace}`) ?? 0;
    const generation = sessionLoadRef.current;
    try {
      const [snapshot, modelResult] = await Promise.all([window.piApi.settings(workspace), window.piApi.models(workspace)]);
      if (request !== settingsRequestRef.current || workspace !== workspaceRef.current) return;
      setSettingsData(snapshot);
      setModels(modelResult.models);
      setEnabledModels(modelResult.enabled ?? []);
      if (revision === (modelRevisionRef.current.get(`default:${workspace}`) ?? 0) && !modelWritesRef.current.has(`default:${workspace}`)) {
        defaultModelWorkspaceRef.current = workspace;
        setDefaultModelSelection(modelResult.defaultSelection ?? modelResult.selection);
        if (!sessionRef.current && generation === sessionLoadRef.current) setModelSelection(modelResult.defaultSelection ?? modelResult.selection);
      }
    } catch (error) {
      if (request === settingsRequestRef.current && workspace === workspaceRef.current) setSettingsError(errorText(error));
    }
  }

  async function loadOfficialExtensions() {
    const request = ++officialCatalogRequestRef.current;
    setOfficialExtensionsBusy(true);
    setOfficialExtensionsError(null);
    try {
      const snapshot = await window.piApi.officialExtensions({ cwd: workspace || undefined });
      if (request !== officialCatalogRequestRef.current) return;
      if (!snapshot) throw new Error('官方扩展目录没有返回数据。');
      setOfficialExtensions(snapshot);
      if (snapshot.autoUpdate?.updated.length) {
        const next = await window.piApi.settings(workspace);
        if (request !== officialCatalogRequestRef.current) return;
        acceptRuntimeSnapshot(
          next,
          `${snapshot.autoUpdate.updated.length} 个官方扩展已在安全边界内自动更新。`,
        );
      }
    } catch (error) {
      if (request === officialCatalogRequestRef.current) {
        setOfficialExtensionsError(errorText(error));
      }
    } finally {
      if (request === officialCatalogRequestRef.current) setOfficialExtensionsBusy(false);
    }
  }

  async function previewOfficialExtension(item: OfficialExtensionCatalogItem) {
    if (officialExtensionBusyId) return;
    setOfficialExtensionBusyId(item.id);
    setOfficialExtensionsError(null);
    try {
      const preview = await window.piApi.prepareOfficialExtension(item.id);
      setExtensionInstallPreview(preview);
      setExtensionInstallerOpen(true);
    } catch (error) {
      setOfficialExtensionsError(errorText(error));
    } finally {
      setOfficialExtensionBusyId(null);
    }
  }

  async function toggleOfficialAutoUpdate(
    item: OfficialExtensionCatalogItem,
    enabled: boolean,
  ) {
    if (!item.officialManaged || officialExtensionBusyId) return;
    setOfficialExtensionBusyId(item.id);
    setOfficialExtensionsError(null);
    try {
      const updated = await window.piApi.setOfficialExtensionAutoUpdate({
        id: item.id,
        enabled,
      });
      setOfficialExtensions((current) => current ? {
        ...current,
        extensions: current.extensions.map((entry) => entry.id === updated.id ? updated : entry),
      } : current);
    } catch (error) {
      setOfficialExtensionsError(errorText(error));
    } finally {
      setOfficialExtensionBusyId(null);
    }
  }

  function discardEditor() {
    editorRequestRef.current += 1;
    editorSaveRef.current = false;
    setEditorSaving(false);
    mcpTestRequestRef.current += 1;
    mcpTestLockRef.current = false;
    editorRecoveryRef.current = null;
    editorBaselineRef.current = null;
    editorDirtyRef.current = false;
    setEditor(null);
    setEditorError(null);
    setEditorCommitted(false);
    setMcpTesting(false);
    setMcpTestResult(null);
    // Drop entered secrets when their editor no longer owns a visible form.
    setProviderDraft(current => ({ ...current, apiKey: '' }));
    setMcpDraftState(current => {
      const next = { ...current, env: '', headers: '' };
      mcpDraftRef.current = next;
      return next;
    });
  }

  async function closeEditor() {
    if (editorSaveRef.current || editorCloseRef.current) return;
    const owner = editorRequestRef.current;
    editorCloseRef.current = true;
    try {
      if (editorDirtyRef.current && !await settingsLeaveConfirmation.confirm({
        title: '丢弃未保存的更改？', description: '关闭后将丢弃本次编辑。',
        confirmLabel: '丢弃更改', cancelLabel: '继续编辑', tone: 'danger',
      })) return;
      if (owner === editorRequestRef.current && !editorSaveRef.current) discardEditor();
    } finally { editorCloseRef.current = false; }
  }

  function editorOwner() {
    const generation = editorRequestRef.current;
    const cwd = editorScopeRef.current;
    return { cwd, current: () => generation === editorRequestRef.current && cwd === workspaceRef.current };
  }

  async function finishEditorRefresh(owner: ReturnType<typeof editorOwner>, refresh: () => Promise<void>) {
    try {
      await refresh();
      if (owner.current()) discardEditor();
    } catch (error) {
      if (owner.current()) setEditorError(`保存已完成，但列表刷新失败。${errorText(error)}`);
    }
  }

  async function runEditorWrite(write: (owner: ReturnType<typeof editorOwner>) => Promise<(() => Promise<void>) | null>) {
    if (!editor || editorLoading || editorSaveRef.current || editorRecoveryRef.current || resourceWriteRef.current || resourceCommitRef.current || settingsBusy) return;
    const owner = editorOwner();
    if (!owner.current()) return;
    editorSaveRef.current = true;
    invalidateResourceReads();
    setEditorSaving(true);
    setEditorError(null);
    const commitOwner = { cwd: owner.cwd };
    resourceCommitRef.current = commitOwner;
    setResourceWriteBusy(true);
    try {
      let refresh: (() => Promise<void>) | null;
      try { refresh = await write(owner); }
      finally {
        if (resourceCommitRef.current === commitOwner) resourceCommitRef.current = null;
        setResourceWriteBusy(Boolean(resourceWriteRef.current || resourceCommitRef.current));
      }
      if (!owner.current() || !refresh) return;
      editorRecoveryRef.current = refresh;
      setEditorCommitted(true);
      editorDirtyRef.current = false;
      await finishEditorRefresh(owner, refresh);
    } catch (error) {
      if (owner.current()) setEditorError(errorText(error));
    } finally {
      if (owner.current()) { editorSaveRef.current = false; setEditorSaving(false); }
    }
  }

  async function retryEditorRefresh() {
    const refresh = editorRecoveryRef.current;
    if (!refresh || editorSaveRef.current) return;
    const owner = editorOwner();
    if (!owner.current()) return;
    editorSaveRef.current = true;
    setEditorSaving(true);
    setEditorError(null);
    try { await finishEditorRefresh(owner, refresh); }
    finally { if (owner.current()) { editorSaveRef.current = false; setEditorSaving(false); } }
  }

  /**
   * 打开某个资源的编辑弹窗。
   * 用 request id 防竞态：用户在加载完成前关掉弹窗，旧请求的结果会被丢弃。
   */
  async function openEditor(kind: SettingsEditor['kind'], editId?: string, providerId?: string, reload = false) {
    if (editorSaveRef.current || resourceWriteRef.current || resourceCommitRef.current) return;
    const request = ++editorRequestRef.current;
    const scope = workspaceRef.current;
    editorScopeRef.current = scope;
    const current = () => request === editorRequestRef.current && scope === workspaceRef.current;
    editorBaselineRef.current = null;
    editorRecoveryRef.current = null;
    setEditorCommitted(false);
    setEditor({ kind, editId, providerId });
    setEditorError(null);
    setEditorLoading(Boolean(editId && kind !== 'skill'));
    setResourceScope('user');
    setSkillWorkspace(workspace);
    setMcpTestResult(null);
    setMcpTesting(false);
    originalMcpArgsRef.current = null;
    setProviderDraft({ providerId: '', name: '', baseUrl: '', api: 'openai-completions', apiKey: '', icon: '', modelsUrl: '' });
    setMcpDraft({
      name: '',
      transport: 'stdio',
      command: '',
      args: '',
      cwd: '',
      url: '',
      description: '',
      env: '',
      headers: '',
      exposure: 'deferred',
      timeoutSeconds: '60',
      toolExposure: '',
      clearEnv: false,
      clearHeaders: false,
    });
    setCustomModel({ ...emptyCustomModelConfig(), providerId: providerId || '' });
    setTokenUnits({ contextWindow: 'k', maxTokens: 'k' });
    try {
      if (kind === 'provider' && editId) {
        const config = await window.piApi.providerConfig(editId);
        if (current()) setProviderDraft({ ...config, apiKey: '' });
      }
      if (kind === 'mcp' && editId) {
        const config = await window.piApi.mcpConfig(editId);
        if (current()) {
          originalMcpArgsRef.current = config.args;
          setMcpDraft({
            name: config.name,
            transport: config.transport,
            command: config.command,
            args: config.args.join('\n'),
            cwd: config.cwd || '',
            url: config.url,
            description: config.description,
            env: config.env,
            headers: config.headers,
            exposure: config.exposure,
            timeoutSeconds: String(config.timeoutSeconds),
            toolExposure: Object.entries(config.toolExposure || {})
              .map(([pattern, exposure]) => `${pattern}=${exposure}`)
              .join('\n'),
            clearEnv: false,
            clearHeaders: false,
          });
        }
      }
      if (kind === 'model' && editId && providerId) {
        const modelsForProvider = (!reload && providerModels[providerId])
          || await refreshProviderModels(providerId);
        const model = modelsForProvider.find((item) => item.model === editId);
        const config = settingsData?.customModels?.find((item) => item.providerId === providerId && item.modelId === editId);
        const effective = model || config;
        if (!effective) throw new Error('模型配置已不可用，请刷新模型列表后重试。');
        if (effective) {
          const contextUnit = automaticTokenUnit(effective.contextWindow);
          const maxUnit = automaticTokenUnit(effective.maxTokens);
          if (current()) {
            setTokenUnits({ contextWindow: contextUnit, maxTokens: maxUnit });
            setCustomModel({
              providerId,
              modelId: editId,
              name: effective.name || editId,
              contextWindow: tokenInputValue(effective.contextWindow, contextUnit),
              maxTokens: tokenInputValue(effective.maxTokens, maxUnit),
              supportsImages: Boolean(effective.supportsImages),
              reasoning: Boolean(effective.reasoning),
              thinkingLevels: effective.thinkingLevels?.length
                ? effective.thinkingLevels
                : effective.reasoning
                  ? [...DEFAULT_MODEL_THINKING_LEVELS]
                  : [],
              origin: model?.origin || config?.origin || 'builtin',
            });
          }
        }
      }
    } catch (error) {
      if (current()) setEditorError(errorText(error));
    } finally { if (current()) setEditorLoading(false); }
  }

  function openModelEditor(providerId: string, model?: ProviderModelInfo) {
    void openEditor('model', model?.model, providerId);
  }

  /** 切换单位时同步换算当前值，避免用户切换后还要重新抄一遍数字。 */
  function changeTokenUnit(field: TokenField, unit: TokenUnit) {
    const previousUnit = tokenUnits[field];
    if (previousUnit === unit) return;
    setCustomModel((current) => ({
      ...current,
      [field]: convertTokenInput(String(current[field] ?? ''), previousUnit, unit),
    }));
    setTokenUnits((current) => ({ ...current, [field]: unit }));
  }

  async function refreshProviderModels(providerId: string) {
    const cwd = workspaceRef.current;
    const request = (providerCatalogRequestsRef.current.get(providerId) ?? 0) + 1;
    providerCatalogRequestsRef.current.set(providerId, request);
    setProviderCatalogState((current) => ({ ...current, [providerId]: { loading: true } }));
    try {
      const result = await window.piApi.providerModels(providerId);
      if (cwd === workspaceRef.current && providerCatalogRequestsRef.current.get(providerId) === request) {
        setProviderModels((current) => ({ ...current, [providerId]: result.models }));
        setProviderCatalogState((current) => ({ ...current, [providerId]: { loading: false } }));
      }
      return result.models;
    } catch (error) {
      if (cwd === workspaceRef.current && providerCatalogRequestsRef.current.get(providerId) === request) {
        setProviderCatalogState((current) => ({ ...current, [providerId]: { loading: false, error: errorText(error) } }));
      }
      throw error;
    }
  }

  /** 展开某个来源下的模型列表；同一来源只请求一次。 */
  async function loadProviderModels(providerId: string) {
    if (expandedProvider === providerId) { setExpandedProvider(null); return; }
    setExpandedProvider(providerId);
    setModelQuery('');
    if (!providerModels[providerId] || providerCatalogState[providerId]?.loading || providerCatalogState[providerId]?.error) {
      try {
        await refreshProviderModels(providerId);
      } catch { /* The local directory keeps its error and retry action. */ }
    }
  }

  async function setEnabled(next: string[]) {
    await runResourceWrite('models', {
      summary: '模型启用状态已更新',
      write: cwd => window.piApi.setEnabledModels({ models: next, cwd }),
      apply: acceptModelResources,
      onCommitted: () => {
        setEnabledModels(next);
        const selected = new Set(next);
        setProviderModels(current => Object.fromEntries(Object.entries(current).map(([id, list]) => [id, list.map(model => ({ ...model, enabled: selected.has(model.id) }))])));
      },
    });
  }

  function toggleModelReasoning(reasoning: boolean) {
    setCustomModel((current) => ({
      ...current,
      reasoning,
      thinkingLevels: reasoning
        ? current.thinkingLevels.length > 0
          ? current.thinkingLevels
          : [...DEFAULT_MODEL_THINKING_LEVELS]
        : [],
    }));
  }

  function toggleModelThinkingLevel(level: ConcreteThinkingLevel) {
    setCustomModel((current) => {
      const selected = current.thinkingLevels.includes(level);
      if (selected && current.thinkingLevels.length === 1) {
        setEditorError('推理模型至少需要保留一个可用等级。');
        return current;
      }
      setEditorError(null);
      return {
        ...current,
        thinkingLevels: selected
          ? current.thinkingLevels.filter((item) => item !== level)
          : concreteThinkingLevels.filter((item) => item === level || current.thinkingLevels.includes(item)),
      };
    });
  }

  function invalidateMcpRefresh() {
    mcpRefreshRequestRef.current += 1;
    mcpRefreshLockRef.current = false;
    setMcpRefreshBusy(false);
  }

  function invalidateResourceReads() {
    extensionRefreshRequestRef.current += 1;
    invalidateModelRefresh();
    invalidateMcpRefresh();
    skillRefreshRequestRef.current += 1;
    skillRefreshLockRef.current = false;
    setSkillRefreshBusy(false);
    settingsRequestRef.current += 1;
    catalogRequestRef.current += 1;
  }

  function invalidateProviderCatalog(providerId: string) {
    providerDiscoveryRequestsRef.current.set(providerId, (providerDiscoveryRequestsRef.current.get(providerId) ?? 0) + 1);
    providerCatalogRequestsRef.current.set(providerId, (providerCatalogRequestsRef.current.get(providerId) ?? 0) + 1);
    setProviderModels(current => { const next = { ...current }; delete next[providerId]; return next; });
    setProviderCatalogState(current => { const next = { ...current }; delete next[providerId]; return next; });
  }

  function acceptMcpResources(snapshot: SettingsSnapshot) {
    settingsRequestRef.current += 1;
    setSettingsData(current => current ? { ...current, mcp: snapshot.mcp } : snapshot);
    resourcePendingRef.current.mcp = false;
    setMcpRefreshError(null);
  }

  /** One lock covers confirmation and mutation. A committed error only enables read recovery. */
  async function runResourceWrite<T>(domain: 'models' | 'mcp' | 'skills', options: {
    summary: string;
    confirm?: ActionConfirmOptions;
    write: (cwd: string) => Promise<CommittedProjection<T>>;
    apply: (value: T, owner: ReturnType<typeof modelProjectionOwner>) => void;
    onCommitted?: () => void;
    onError?: (message: string) => void;
  }) {
    if (resourceWriteRef.current || resourceCommitRef.current || editorSaveRef.current || settingsBusy || resourcePendingRef.current[domain]) return;
    const owner = { cwd: workspaceRef.current };
    resourceWriteRef.current = owner;
    setResourceWriteBusy(true);
    const current = () => resourceWriteRef.current === owner && workspaceRef.current === owner.cwd;
    let committed = false;
    const report = (message: string) => {
      resourcePendingRef.current[domain] = true;
      if (domain === 'models') { setModelRefreshSummary(options.summary); setModelRefreshError(message); }
      else if (domain === 'mcp') { setMcpRefreshSummary(options.summary); setMcpRefreshError(message); }
      else reportSkillRefresh(owner.cwd, options.summary, message);
    };
    try {
      if (options.confirm && !await actionConfirmation.confirm(options.confirm)) return;
      if (!current()) return;
      invalidateResourceReads();
      setSettingsError(null);
      const modelOwner = modelProjectionOwner(owner.cwd);
      resourceCommitRef.current = owner;
      const result = await options.write(owner.cwd);
      if (!current()) {
        invalidateResourceReads();
        if (domain === 'skills') reportSkillRefresh(owner.cwd, options.summary, '请刷新当前技能状态。');
        else {
          resourcePendingRef.current[domain] = true;
          if (domain === 'models') { setModelRefreshSummary(options.summary); setModelRefreshError('请刷新当前模型配置。'); defaultModelWorkspaceRef.current = ''; }
          else { setMcpRefreshSummary(options.summary); setMcpRefreshError('请刷新当前 MCP 状态。'); }
        }
        return;
      }
      committed = true;
      settingsRequestRef.current += 1;
      if (domain === 'models') { catalogRequestRef.current += 1; defaultModelWorkspaceRef.current = ''; }
      options.onCommitted?.();
      if (result.projection.status === 'error') report(result.projection.message);
      else { options.apply(result.projection.value, modelOwner); pushNotification(options.summary, 'success'); }
    } catch (error) {
      if (!current()) return;
      if (committed) report('操作已完成，列表暂时无法更新。请重试刷新。');
      else if (options.onError) options.onError(errorText(error));
      else setSettingsError(errorText(error));
    } finally {
      if (resourceCommitRef.current === owner) resourceCommitRef.current = null;
      if (resourceWriteRef.current === owner) resourceWriteRef.current = null;
      setResourceWriteBusy(Boolean(resourceWriteRef.current || resourceCommitRef.current));
    }
  }

  async function refreshSavedMcpConfiguration() {
    if (mcpRefreshLockRef.current || resourceWriteRef.current || resourceCommitRef.current || editorSaveRef.current) return;
    mcpRefreshLockRef.current = true;
    const request = ++mcpRefreshRequestRef.current;
    const cwd = workspaceRef.current;
    setMcpRefreshBusy(true);
    try {
      const snapshot = await window.piApi.refreshMcp(cwd);
      if (request === mcpRefreshRequestRef.current && cwd === workspaceRef.current) acceptMcpResources(snapshot);
    } catch (error) {
      if (request === mcpRefreshRequestRef.current && cwd === workspaceRef.current) setMcpRefreshError(errorText(error));
    } finally {
      if (request === mcpRefreshRequestRef.current) { mcpRefreshLockRef.current = false; setMcpRefreshBusy(false); }
    }
  }

  function reportSkillRefresh(cwd: string, summary: string, message: string) {
    skillRefreshTargetsRef.current.add(cwd);
    resourcePendingRef.current.skills = true;
    setSkillRefreshSummary(summary);
    setSkillRefreshError(message);
  }

  function acceptSkillResources(snapshot: SettingsSnapshot, completedCwd = workspaceRef.current) {
    settingsRequestRef.current += 1;
    setSettingsData(current => current ? { ...current, skills: snapshot.skills, skillErrors: snapshot.skillErrors } : snapshot);
    skillRefreshTargetsRef.current.delete(completedCwd);
    if (!skillRefreshTargetsRef.current.size) {
      resourcePendingRef.current.skills = false;
      setSkillRefreshError(null);
    }
  }

  async function refreshSavedSkillConfiguration() {
    if (skillRefreshLockRef.current || resourceWriteRef.current || resourceCommitRef.current || editorSaveRef.current) return;
    skillRefreshLockRef.current = true;
    const request = ++skillRefreshRequestRef.current;
    const cwd = workspaceRef.current;
    const current = () => request === skillRefreshRequestRef.current && cwd === workspaceRef.current;
    const detailGeneration = skillDetailGenerationRef.current;
    setSkillRefreshBusy(true);
    try {
      let snapshot: SettingsSnapshot | undefined;
      const targets = [...skillRefreshTargetsRef.current];
      for (const target of targets.length ? targets : [cwd]) {
        const result = await window.piApi.refreshSkills(target);
        if (!current()) return;
        skillRefreshTargetsRef.current.delete(target);
        if (target === cwd) snapshot = result;
      }
      snapshot ??= await window.piApi.settings(cwd);
      if (!current()) return;
      acceptSkillResources(snapshot);
      if (skillDetailGenerationRef.current === detailGeneration && skillDetailRef.current) {
        const updated = snapshot.skills.find(item => item.path === skillDetailRef.current?.path);
        setSkillDetailError(null);
        if (updated) setSkillDetail(updated);
        else closeSkillDetail();
      }
    } catch (error) {
      if (current()) setSkillRefreshError(errorText(error));
    } finally {
      if (current()) { skillRefreshLockRef.current = false; setSkillRefreshBusy(false); }
    }
  }

  function invalidateModelRefresh() {
    modelRefreshRequestRef.current += 1;
    modelRefreshLockRef.current = false;
    setModelRefreshBusy(false);
  }

  function modelProjectionOwner(cwd = workspaceRef.current) {
    const scope = `default:${cwd}`;
    return { cwd, scope, revision: modelRevisionRef.current.get(scope) ?? 0, generation: sessionLoadRef.current };
  }

  function acceptModelResources(value: ModelResourceSnapshot, owner: ReturnType<typeof modelProjectionOwner>) {
    settingsRequestRef.current += 1;
    catalogRequestRef.current += 1;
    setSettingsData(current => current ? { ...current, providers: value.settings.providers, customModels: value.settings.customModels, enabledModels: value.settings.enabledModels, model: value.settings.model } : value.settings);
    setModels(value.models.models);
    setEnabledModels(value.models.enabled ?? value.settings.enabledModels);
    if (owner.cwd === workspaceRef.current && owner.revision === (modelRevisionRef.current.get(owner.scope) ?? 0) && !modelWritesRef.current.has(owner.scope)) {
      const selection = value.models.defaultSelection ?? value.models.selection;
      defaultModelWorkspaceRef.current = owner.cwd;
      setDefaultModelSelection(selection);
      if (!sessionRef.current && owner.generation === sessionLoadRef.current) setModelSelection(selection);
    }
    setModelRefreshError(null);
    resourcePendingRef.current.models = false;
  }

  /** This remains available after dismissing a committed editor. It never writes config. */
  async function refreshSavedModelConfiguration() {
    if (modelRefreshLockRef.current || resourceWriteRef.current || resourceCommitRef.current || editorSaveRef.current) return;
    modelRefreshLockRef.current = true;
    const request = ++modelRefreshRequestRef.current;
    const cwd = workspaceRef.current;
    setModelRefreshBusy(true);
    try {
      const selectionOwner = modelProjectionOwner(cwd);
      const value = await window.piApi.refreshModels(cwd);
      if (request !== modelRefreshRequestRef.current || cwd !== workspaceRef.current) return;
      acceptModelResources(value, selectionOwner);
      for (const [id, revision] of providerCatalogRequestsRef.current) providerCatalogRequestsRef.current.set(id, revision + 1);
      setProviderModels({});
      setProviderCatalogState({});
      setExpandedProvider(null);
    } catch (error) {
      if (request === modelRefreshRequestRef.current && cwd === workspaceRef.current) setModelRefreshError(errorText(error));
    } finally {
      if (request === modelRefreshRequestRef.current) { modelRefreshLockRef.current = false; setModelRefreshBusy(false); }
    }
  }

  function modelEditorRecovery(owner: ReturnType<typeof editorOwner>, providerId: string,
    projection: MutationProjection<ModelResourceSnapshot>, selectionOwner: ReturnType<typeof modelProjectionOwner>, revealProvider = false) {
    let needsRuntime = projection.status === 'error';
    let initialError = projection.status === 'error' ? projection.message : null;
    if (owner.current()) {
      providerCatalogRequestsRef.current.set(providerId, (providerCatalogRequestsRef.current.get(providerId) ?? 0) + 1);
      if (projection.status === 'ready') acceptModelResources(projection.value, selectionOwner);
      else {
        resourcePendingRef.current.models = true;
        setModelRefreshSummary('配置已保存');
        setModelRefreshError(projection.message);
      }
    } else {
      invalidateResourceReads();
      defaultModelWorkspaceRef.current = '';
      resourcePendingRef.current.models = true;
      setModelRefreshSummary('配置已保存');
      setModelRefreshError('请刷新当前模型配置。');
    }
    return async () => {
      // Report the actual failed phase before any user-requested retry.
      if (initialError) { const message = initialError; initialError = null; throw new Error(message); }
      if (!owner.current()) return;
      if (needsRuntime) {
        const selectionOwner = modelProjectionOwner(owner.cwd);
        const value = await window.piApi.refreshModels(owner.cwd);
        if (!owner.current()) return;
        acceptModelResources(value, selectionOwner);
        needsRuntime = false;
      }
      const request = (providerCatalogRequestsRef.current.get(providerId) ?? 0) + 1;
      providerCatalogRequestsRef.current.set(providerId, request);
      setProviderCatalogState(current => ({ ...current, [providerId]: { loading: true } }));
      try {
        const result = await window.piApi.providerModels(providerId);
        if (!owner.current() || providerCatalogRequestsRef.current.get(providerId) !== request) return;
        setProviderModels(current => ({ ...current, [providerId]: result.models }));
        setProviderCatalogState(current => ({ ...current, [providerId]: { loading: false } }));
        if (revealProvider) { setExpandedProvider(providerId); setModelQuery(''); }
      } catch (error) {
        if (owner.current() && providerCatalogRequestsRef.current.get(providerId) === request) {
          setProviderCatalogState(current => ({ ...current, [providerId]: { loading: false, error: errorText(error) } }));
        }
        throw error;
      } finally {
        if (!owner.current() && providerCatalogRequestsRef.current.get(providerId) === request) {
          invalidateProviderCatalog(providerId);
          setExpandedProvider(current => current === providerId ? null : current);
        }
      }
    };
  }

  /** 保存自定义模型，并刷新设置快照与模型目录。 */
  async function saveCustomModel() {
    if (customModel.reasoning && customModel.thinkingLevels.length === 0) {
      setEditorError('推理模型至少需要选择一个可用等级。');
      return;
    }
    await runEditorWrite(async owner => {
      invalidateModelRefresh();
      const providerId = customModel.providerId;
      const selectionOwner = modelProjectionOwner(owner.cwd);
      const result = await window.piApi.addCustomModel({
        editing: Boolean(editor?.editId), providerId,
        modelId: customModel.modelId, name: customModel.name || customModel.modelId,
        contextWindow: tokenInputAsInteger(String(customModel.contextWindow), tokenUnits.contextWindow),
        maxTokens: tokenInputAsInteger(String(customModel.maxTokens), tokenUnits.maxTokens),
        supportsImages: customModel.supportsImages, reasoning: customModel.reasoning,
        thinkingLevels: customModel.reasoning ? customModel.thinkingLevels : [],
        origin: customModel.origin, cwd: owner.cwd,
      });
      return modelEditorRecovery(owner, providerId, result.projection, selectionOwner);
    });
  }

  async function deleteMcp(name: string) {
    await runResourceWrite('mcp', {
      summary: `MCP「${name}」已删除`,
      confirm: {
        title: '删除 MCP 服务器？',
        description: `「${name}」的连接配置、工具覆盖和已保存凭据都会被删除，此操作不可撤销。`,
        confirmLabel: '删除服务器', tone: 'danger',
      },
      write: cwd => window.piApi.removeMcp(name, cwd),
      apply: acceptMcpResources,
      onCommitted: () => setSettingsData(current => current ? { ...current, mcp: current.mcp.filter(server => server.name !== name) } : current),
    });
  }

  function acceptExtensionResources(snapshot: SettingsSnapshot) {
    settingsRequestRef.current += 1;
    setSettingsData(current => current ? { ...current, extensions: snapshot.extensions, extensionErrors: snapshot.extensionErrors } : snapshot);
    setExtensionDetail(current => current ? snapshot.extensions.find(item => item.id === current.id) || null : null);
  }

  async function runExtensionWrite(options: {
    summary: string;
    confirm?: ActionConfirmOptions;
    write: (cwd: string) => Promise<ExtensionMutationResult>;
    onCommitted?: () => void;
  }) {
    if (resourceWriteRef.current || resourceCommitRef.current || editorSaveRef.current || settingsBusy
      || extensionRefreshLockRef.current || extensionMutationReceiptsRef.current.size) return;
    const owner = { cwd: workspaceRef.current };
    resourceWriteRef.current = owner;
    setResourceWriteBusy(true);
    const current = () => resourceWriteRef.current === owner && workspaceRef.current === owner.cwd;
    let committed = false;
    try {
      if (options.confirm && !await actionConfirmation.confirm(options.confirm)) return;
      if (!current()) return;
      invalidateResourceReads();
      setSettingsError(null);
      resourceCommitRef.current = owner;
      const result = await options.write(owner.cwd);
      committed = true;
      invalidateResourceReads();
      extensionMutationReceiptsRef.current.set(result.recoveryToken, { result, cwd: owner.cwd, summary: options.summary });
      if (current()) options.onCommitted?.();
      if (result.projection.status === 'ready' && current()) {
        acceptExtensionResources(result.projection.value);
        extensionMutationReceiptsRef.current.delete(result.recoveryToken);
        void window.piApi.disposeExtensionMutationRecovery(result.recoveryToken).catch(() => {});
        setExtensionRefreshError(null);
        pushNotification(options.summary, 'success');
      } else {
        setExtensionRefreshError(`${options.summary}。${result.projection.status === 'error' ? result.projection.message : '请刷新当前扩展状态。'}`);
      }
    } catch (error) {
      if (committed) setExtensionRefreshError(`${options.summary}，页面更新未完成。请重试刷新。`);
      else if (current()) setSettingsError(errorText(error));
    } finally {
      if (resourceCommitRef.current === owner) resourceCommitRef.current = null;
      if (resourceWriteRef.current === owner) resourceWriteRef.current = null;
      setResourceWriteBusy(Boolean(resourceWriteRef.current || resourceCommitRef.current));
    }
  }

  async function refreshSavedExtensionConfiguration() {
    if (extensionRefreshLockRef.current || resourceWriteRef.current || resourceCommitRef.current || editorSaveRef.current || settingsBusy) return;
    extensionRefreshLockRef.current = true;
    const request = ++extensionRefreshRequestRef.current;
    const cwd = workspaceRef.current;
    const current = () => request === extensionRefreshRequestRef.current && cwd === workspaceRef.current;
    const receipts = [...extensionMutationReceiptsRef.current.entries()];
    setExtensionRefreshBusy(true);
    try {
      for (const [, record] of receipts) {
        if (record.result.projection.status === 'error') record.result = await window.piApi.refreshExtensionMutation(record.result.recoveryToken);
        if (!current()) return;
        if (record.result.projection.status === 'error') throw new Error(record.result.projection.message);
      }
      // Receipts prove post-processing finished; their cached snapshots may be
      // from another workspace or predate newer changes. Always read current data.
      const snapshot = await window.piApi.settings(cwd);
      if (!current()) return;
      acceptExtensionResources(snapshot);
      for (const [token] of receipts) {
        extensionMutationReceiptsRef.current.delete(token);
        void window.piApi.disposeExtensionMutationRecovery(token).catch(() => {});
      }
      setExtensionRefreshError(null);
    } catch (error) {
      if (current()) setExtensionRefreshError(errorText(error));
    } finally {
      // Keep the physical read lock until completion even if its presentation
      // was superseded by a different domain's write.
      extensionRefreshLockRef.current = false;
      setExtensionRefreshBusy(false);
    }
  }

  async function deleteExtension(id: string, name: string) {
    await runExtensionWrite({
      summary: `已卸载扩展「${name}」`,
      confirm: { title: '卸载扩展？', description: `「${name}」的受管代码会从当前来源删除。扩展运行数据会保留，之后重新安装仍可继续使用。`, confirmLabel: '卸载扩展', tone: 'danger' },
      write: cwd => window.piApi.removeExtension({ id, cwd }),
      onCommitted: () => {
        setSettingsData(current => current ? { ...current, extensions: current.extensions.filter(item => item.id !== id) } : current);
        setExtensionDetail(current => current?.id === id ? null : current);
      },
    });
  }

  async function toggleExtension(item: ExtensionHostItem, enabled: boolean) {
    await runExtensionWrite({
      summary: `${item.name} 已${enabled ? '启用' : '停用'}`,
      write: cwd => window.piApi.setExtensionEnabled({ id: item.id, enabled, cwd }),
    });
  }

  async function trustExtension(item: ExtensionHostItem, trusted: boolean) {
    const verb = trusted ? '信任' : '撤销信任';
    await runExtensionWrite({
      summary: `${item.name} 已${verb}`,
      confirm: {
        title: `${verb}扩展？`,
        description: trusted
          ? `「${item.name}」的扩展代码将在 Electron 主进程中运行，并可访问当前用户有权限访问的本机资源。请先确认来源和内容。`
          : `撤销后，「${item.name}」会立即从后续请求和能力目录中移除；已产生的历史记录不会改写。`,
        confirmLabel: trusted ? '信任并启用' : '撤销信任', tone: trusted ? 'default' : 'danger',
      },
      write: cwd => window.piApi.setExtensionTrusted({ id: item.id, trusted, cwd }),
    });
  }

  async function reloadExtensions() {
    if (extensionMutationReceiptsRef.current.size) return refreshSavedExtensionConfiguration();
    if (resourceWriteRef.current || resourceCommitRef.current || extensionRefreshLockRef.current || settingsBusy) return;
    const cwd = workspaceRef.current;
    const request = ++extensionRefreshRequestRef.current;
    extensionRefreshLockRef.current = true;
    setExtensionRefreshBusy(true);
    try {
      await window.piApi.reloadExtensions(cwd);
      const snapshot = await window.piApi.settings(cwd);
      if (cwd !== workspaceRef.current || request !== extensionRefreshRequestRef.current) return;
      acceptExtensionResources(snapshot);
      setSettingsError(null);
    } catch (error) {
      if (cwd === workspaceRef.current && request === extensionRefreshRequestRef.current) setSettingsError(errorText(error));
    } finally { extensionRefreshLockRef.current = false; setExtensionRefreshBusy(false); }
  }

  async function rollbackExtension(item: ExtensionHostItem) {
    if (!item.installation?.canRollback) return;
    await runExtensionWrite({
      summary: `扩展「${item.name}」已回滚`,
      confirm: { title: '回滚扩展版本？', description: `「${item.name}」将切换到上一个保留版本。扩展运行数据会继续保留，项目扩展的内容信任可能需要重新确认。`, confirmLabel: '回滚版本' },
      write: cwd => window.piApi.rollbackExtension({ id: item.id, scope: item.scope === 'project' ? 'project' : 'user', cwd }),
    });
  }

  async function deleteCustomModel(providerId: string, model: ProviderModelInfo) {
    const restoring = model.origin === 'override';
    await runResourceWrite('models', {
      summary: restoring ? `「${model.name}」已恢复内置参数` : `模型「${model.name}」已删除`,
      confirm: {
        title: restoring ? '恢复内置模型参数？' : '删除模型？',
        description: restoring ? `移除「${model.name}」的自定义配置，并恢复 Pi 内置参数？` : `从「${providerId}」删除模型「${model.name}」？`,
        confirmLabel: restoring ? '恢复参数' : '删除模型', tone: 'danger',
      },
      write: cwd => window.piApi.removeCustomModel({ providerId, modelId: model.model, cwd }),
      apply: acceptModelResources,
      onCommitted: () => {
        invalidateProviderCatalog(providerId);
        setExpandedProvider(current => current === providerId ? null : current);
        if (!restoring) {
          setModels(current => current.filter(item => item.id !== model.id));
          setEnabledModels(current => current.filter(id => id !== model.id));
        }
      },
    });
  }

  async function discoverProviderModels(providerId: string) {
    const cwd = workspaceRef.current;
    const request = (providerDiscoveryRequestsRef.current.get(providerId) ?? 0) + 1;
    providerDiscoveryRequestsRef.current.set(providerId, request);
    const current = () => cwd === workspaceRef.current && providerDiscoveryRequestsRef.current.get(providerId) === request;
    setProviderDiscovery(state => ({ ...state, [providerId]: { loading: true } }));
    try {
      const result = await window.piApi.discoverProviderModels(providerId);
      if (current()) setProviderDiscovery(state => ({ ...state, [providerId]: { endpoint: result.endpoint, models: result.models, selected: [] } }));
    } catch (error) {
      if (current()) setProviderDiscovery(state => ({ ...state, [providerId]: { error: errorText(error) } }));
    }
  }

  async function importProviderModels(providerId: string, discovered: DiscoveredModel[]) {
    if (!discovered.length) return;
    await runResourceWrite('models', {
      summary: `已添加 ${discovered.length} 个模型`,
      write: cwd => window.piApi.importProviderModels({ providerId, models: discovered, cwd }),
      apply: acceptModelResources,
      onCommitted: () => {
        invalidateProviderCatalog(providerId);
        setExpandedProvider(current => current === providerId ? null : current);
        setProviderDiscovery(current => { const next = { ...current }; delete next[providerId]; return next; });
      },
    });
  }

  /** 保存模型来源（新建或编辑），完成后重建模型目录。 */
  async function saveProvider() {
    await runEditorWrite(async owner => {
      invalidateModelRefresh();
      const providerId = providerDraft.providerId.trim();
      const selectionOwner = modelProjectionOwner(owner.cwd);
      const result = await window.piApi.addProvider({ ...providerDraft, editing: Boolean(editor?.editId), cwd: owner.cwd });
      if (owner.current()) {
        setProviderDraft(current => ({ ...current, apiKey: '' }));
        setProviderModels(current => { const next = { ...current }; delete next[providerId]; return next; });
        setProviderDiscovery(current => { const next = { ...current }; delete next[providerId]; return next; });
      }
      return modelEditorRecovery(owner, providerId, result.projection, selectionOwner, true);
    });
  }

  async function toggleProvider(provider: SettingsSnapshot['providers'][number], enabled: boolean) {
    await runResourceWrite('models', {
      summary: `模型来源「${provider.name}」已${enabled ? '启用' : '停用'}`,
      write: cwd => window.piApi.setProviderEnabled({ providerId: provider.id, enabled, cwd }),
      apply: acceptModelResources,
      onCommitted: () => {
        invalidateProviderCatalog(provider.id);
        setExpandedProvider(current => current === provider.id ? null : current);
        setSettingsData(current => current ? { ...current, providers: current.providers.map(item => item.id === provider.id ? { ...item, enabled } : item) } : current);
      },
    });
  }

  async function deleteProvider(provider: SettingsSnapshot['providers'][number]) {
    await runResourceWrite('models', {
      summary: `模型来源「${provider.name}」已删除`,
      confirm: {
        title: '删除模型来源？',
        description: `「${provider.name}」的来源连接、${provider.models} 个模型配置和加密保存的凭据都会被删除，此操作不可撤销。`,
        confirmLabel: '删除来源', tone: 'danger',
      },
      write: cwd => window.piApi.removeProvider({ providerId: provider.id, cwd }),
      apply: acceptModelResources,
      onCommitted: () => {
        invalidateProviderCatalog(provider.id);
        setSettingsData(current => current ? { ...current, providers: current.providers.filter(item => item.id !== provider.id) } : current);
        setModels(current => current.filter(item => item.provider !== provider.id));
        setEnabledModels(current => current.filter(id => !id.startsWith(`${provider.id}/`)));
        setProviderDiscovery(current => { const next = { ...current }; delete next[provider.id]; return next; });
        setExpandedProvider(current => current === provider.id ? null : current);
      },
    });
  }

  /**
   * 保存 MCP 服务器。
   * 编辑时如果参数文本没有改动就沿用原始数组，参数里的空格不会被重新切分。
   */
  function currentMcpPayload() {
    const originalArgs = originalMcpArgsRef.current;
    const args = originalArgs && mcpDraft.args === originalArgs.join('\n')
      ? originalArgs
      : mcpDraft.args.split('\n').filter((arg) => arg.length > 0);
    const toolExposure = Object.fromEntries(mcpDraft.toolExposure
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const index = line.indexOf('=');
        if (index <= 0) throw new Error(`工具暴露规则格式无效：${line}`);
        const pattern = line.slice(0, index).trim();
        const exposure = line.slice(index + 1).trim();
        if (!pattern || !['direct', 'deferred', 'hidden'].includes(exposure)) {
          throw new Error(`工具暴露规则格式无效：${line}`);
        }
        return [pattern, exposure as 'direct' | 'deferred' | 'hidden'];
      }));
    return {
        name: mcpDraft.name,
        transport: mcpDraft.transport as 'stdio' | 'http',
        command: mcpDraft.command,
        args,
        mcpCwd: mcpDraft.cwd,
        url: mcpDraft.url,
        description: mcpDraft.description,
        env: mcpDraft.env,
        headers: mcpDraft.headers,
        clearEnv: mcpDraft.clearEnv,
        clearHeaders: mcpDraft.clearHeaders,
        exposure: mcpDraft.exposure as 'direct' | 'deferred' | 'hidden',
        timeoutSeconds: Number(mcpDraft.timeoutSeconds) || 60,
        toolExposure,
        originalName: editor?.editId,
        cwd: workspace,
    };
  }

  async function testCurrentMcp() {
    if (editor?.kind !== 'mcp' || editorLoading || mcpTestLockRef.current || editorSaveRef.current || editorRecoveryRef.current) return;
    const owner = editorOwner();
    if (!owner.current()) return;
    const request = ++mcpTestRequestRef.current;
    mcpTestLockRef.current = true;
    setMcpTesting(true);
    setMcpTestResult(null);
    setEditorError(null);
    const current = () => owner.current() && request === mcpTestRequestRef.current;
    try {
      const result = await window.piApi.testMcp(currentMcpPayload());
      if (current()) setMcpTestResult(result);
    } catch (error) {
      if (current()) setEditorError(errorText(error));
    } finally {
      if (current()) { mcpTestLockRef.current = false; setMcpTesting(false); }
    }
  }

  async function saveMcp() {
    await runEditorWrite(async owner => {
      invalidateMcpRefresh();
      mcpTestRequestRef.current += 1;
      mcpTestLockRef.current = false;
      setMcpTesting(false);
      const result = await window.piApi.addMcp({ ...currentMcpPayload(), cwd: owner.cwd });
      let needsRefresh = result.projection.status === 'error';
      let initialError = result.projection.status === 'error' ? result.projection.message : null;
      if (owner.current()) {
        if (result.projection.status === 'ready') acceptMcpResources(result.projection.value);
        else {
          setMcpRefreshSummary('MCP 配置已保存');
          setMcpRefreshError(result.projection.message);
          resourcePendingRef.current.mcp = true;
        }
      } else {
        invalidateResourceReads();
        resourcePendingRef.current.mcp = true;
        setMcpRefreshSummary('MCP 配置已保存');
        setMcpRefreshError('请刷新当前 MCP 状态。');
      }
      return async () => {
        if (initialError) { const message = initialError; initialError = null; throw new Error(message); }
        if (!owner.current()) return;
        if (needsRefresh) {
          const snapshot = await window.piApi.refreshMcp(owner.cwd);
          if (!owner.current()) return;
          acceptMcpResources(snapshot);
          needsRefresh = false;
        }
      };
    });
  }

  /** Cancelled folder selection is not a committed import. */
  async function importSkillResource(scope: 'user' | 'project') {
    const targetCwd = scope === 'project' ? skillWorkspace : workspaceRef.current;
    if (scope === 'project' && !targetCwd) { setEditorError('请选择要添加项目技能的工作区。'); return; }
    await runEditorWrite(async owner => {
      const result = await window.piApi.addSkill({ scope, cwd: targetCwd });
      if (!result) return null;
      const targetName = workspaces.find(item => item.cwd === targetCwd)?.name || targetCwd;
      const summary = scope === 'project' ? `技能已添加到「${targetName}」` : '技能已添加';
      let snapshot = result.projection.status === 'ready' ? result.projection.value : null;
      let initialError = result.projection.status === 'error' ? result.projection.message : null;
      if (owner.current() && initialError) reportSkillRefresh(targetCwd, summary, initialError);
      if (!owner.current()) {
        invalidateResourceReads();
        reportSkillRefresh(targetCwd, summary, '请刷新当前技能状态。');
      }
      return async () => {
        if (initialError) { const message = initialError; initialError = null; throw new Error(message); }
        if (!owner.current()) return;
        try {
          if (!snapshot) snapshot = await window.piApi.refreshSkills(targetCwd);
          if (!owner.current()) return;
          const currentSnapshot = targetCwd === owner.cwd ? snapshot : await window.piApi.settings(owner.cwd);
          if (!owner.current()) return;
          acceptSkillResources(currentSnapshot, targetCwd);
          pushNotification(summary, 'success');
        } catch (error) {
          if (owner.current()) reportSkillRefresh(targetCwd, summary, errorText(error));
          throw error;
        }
      };
    });
  }

  async function toggleMcp(name: string, enabled: boolean) {
    await runResourceWrite('mcp', {
      summary: `MCP「${name}」已${enabled ? '启用' : '停用'}`,
      write: cwd => window.piApi.setMcpEnabled({ name, enabled, cwd }),
      apply: acceptMcpResources,
      onCommitted: () => setSettingsData(current => current ? { ...current, mcp: current.mcp.map(server => server.name === name ? { ...server, enabled } : server) } : current),
    });
  }

  async function refreshMcpDetail(name: string, ownerGeneration: number, ownerWorkspace: string) {
    const revision = settingsRequestRef.current;
    const isCurrent = () => mcpDetailGenerationRef.current === ownerGeneration
      && mcpDetailRef.current?.name === name && workspaceRef.current === ownerWorkspace && revision === settingsRequestRef.current;
    if (!isCurrent()) return;
    const snapshot = await window.piApi.settings(ownerWorkspace).catch(error => {
      if (isCurrent()) throw error;
      return null;
    });
    if (!snapshot) return;
    if (!isCurrent()) return;
    setSettingsData(current => current ? { ...current, mcp: snapshot.mcp } : snapshot);
    const next = snapshot.mcp.find((server) => server.name === name) || null;
    mcpDetailRef.current = next;
    setMcpDetailState(next);
    return true;
  }

  /** 供模型选择器使用：拉取目录并同步到本地状态。 */
  async function loadModelCatalog(cwd = workspaceRef.current) {
    const request = ++catalogRequestRef.current;
    const generation = sessionLoadRef.current;
    const scope = `default:${cwd}`;
    const revision = modelRevisionRef.current.get(scope) ?? 0;
    const result = await window.piApi.models(cwd);
    if (cwd !== workspaceRef.current || request !== catalogRequestRef.current) return result;
    setModels(result.models);
    setEnabledModels(result.enabled ?? []);
    if (revision === (modelRevisionRef.current.get(scope) ?? 0) && !modelWritesRef.current.has(scope)) {
      const nextDefault = result.defaultSelection ?? result.selection;
      defaultModelWorkspaceRef.current = cwd;
      setDefaultModelSelection(nextDefault);
      if (!sessionRef.current && generation === sessionLoadRef.current) setModelSelection(nextDefault);
    }
    return result;
  }

  // Lock the authoritative scope across picker/settings entry points. A view
  // transition invalidates presentation, but must not launch concurrent writes.
  async function writeModelSelection(
    change: { modelRef: string } | { thinkingLevel: ThinkingLevel },
    defaults = false,
  ) {
    const cwd = workspaceRef.current;
    const id = defaults ? undefined : sessionRef.current?.id;
    const scope = id ? `session:${id}` : `default:${cwd}`;
    if (modelWritesRef.current.has(scope)) throw new Error('模型设置正在保存，请稍后再试。');
    modelWritesRef.current.add(scope);
    modelRevisionRef.current.set(scope, (modelRevisionRef.current.get(scope) ?? 0) + 1);
    if (id) transcriptCacheRef.current.delete(id);
    try {
      const result = id
        ? await window.piApi.conversationConfigure({ id, ...change })
        : 'modelRef' in change
          ? await window.piApi.setDefaultModel(change.modelRef, cwd)
          : await window.piApi.setDefaultThinkingLevel({ level: change.thinkingLevel, cwd });
      modelWriteResultsRef.current.set(scope, { revision: modelRevisionRef.current.get(scope) ?? 0, selection: result });
      if (cwd !== workspaceRef.current) return;
      if (!id) {
        defaultModelWorkspaceRef.current = cwd;
        setDefaultModelSelection(result);
      }
      if ((sessionRef.current?.id ?? undefined) !== id) return;
      setModelSelection(id ? { ...result, pending: turnActiveRef.current } : result);
    } finally {
      if (id) transcriptCacheRef.current.delete(id);
      modelWritesRef.current.delete(scope);
      modelRevisionRef.current.set(scope, (modelRevisionRef.current.get(scope) ?? 0) + 1);
    }
  }

  async function selectModel(next: string) {
    const target = models.find((item) => item.id === next);
    if (target?.supportsImages === false && composerAttachments.some((item) => item.kind === 'image')) {
      const message = `${target.name || target.id} 不支持图片输入。请先移除输入框中的图片，再切换模型。`;
      showComposerFeedback(message);
      throw new Error(message);
    }
    setComposerFeedback(null);
    // 会话配置写入下一次请求；正在生成时也不禁用，当前回复不受影响。
    await writeModelSelection({ modelRef: next });
  }

  /**
   * 当前模型的上下文窗口与自动压缩阈值。模型切换、从设置页回来、压缩状态变化时
   * 重新读取一次即可；真正的压缩判断在 Durable 里，这里只用于展示与提示。
   */
  useEffect(() => {
    if (!modelSelection.modelRef) { setContextPolicy(null); return; }
    let disposed = false;
    void window.piApi.contextPolicy({ modelRef: modelSelection.modelRef })
      .then((next) => { if (!disposed) setContextPolicy(next); })
      .catch(() => { if (!disposed) setContextPolicy(null); });
    return () => { disposed = true; };
  }, [modelSelection.modelRef, sessionId, settingsOpen, compaction.active]);

  /** 手动压缩：Durable 在空闲时立即应用，运行中排到下一个边界，不会丢掉当前回合。 */
  async function compactContext() {
    const id = sessionRef.current?.id;
    if (!id || compaction.active) return;
    try {
      setCompaction({ active: true, reason: 'manual' });
      await window.piApi.conversationCompact({ id });
    } catch (error) {
      setCompaction({ active: false });
      showComposerFeedback(errorText(error), 'warning');
    }
  }

  // A previous model's policy must not label the new selection while its read is pending.
  const activeContextPolicy = contextPolicy?.modelRef === modelSelection.modelRef ? contextPolicy : null;
  // 上下文占用只从会话已有的用量读数推算，不再单独请求用量。
  const contextUsageInfo = useMemo(
    () => contextUsage(messages, activeContextPolicy?.contextWindow ?? 0),
    [messages, activeContextPolicy],
  );

  async function selectThinking(level: ThinkingLevel) {
    await writeModelSelection({ thinkingLevel: level });
  }

  /** Settings always writes this workspace's defaults, never the open session. */
  async function saveDefaultSelection(change: { modelRef: string } | { thinkingLevel: ThinkingLevel }) {
    if (modelWritesRef.current.has(`default:${workspaceRef.current}`)) return;
    const cwd = workspaceRef.current;
    const request = settingsRequestRef.current;
    setDefaultModelBusy(true);
    setSettingsError(null);
    try {
      await writeModelSelection(change, true);
    } catch (error) {
      if (cwd === workspaceRef.current && request === settingsRequestRef.current) setSettingsError(errorText(error));
    } finally {
      setDefaultModelBusy(modelWritesRef.current.has(`default:${workspaceRef.current}`));
    }
  }

  async function selectDefaultModel(next: string) {
    await saveDefaultSelection({ modelRef: next });
  }

  async function selectDefaultThinking(level: ThinkingLevel) {
    await saveDefaultSelection({ thinkingLevel: level });
  }

  // __SETTINGS_ACTIONS_CONTINUE__

  return {
    acceptRuntimeSnapshot,
    canLeaveSettings,
    selectSettingsTab,
    closeSettings,
    openSettings,
    loadOfficialExtensions,
    previewOfficialExtension,
    toggleOfficialAutoUpdate,
    discardEditor,
    closeEditor,
    editorOwner,
    finishEditorRefresh,
    runEditorWrite,
    retryEditorRefresh,
    openEditor,
    openModelEditor,
    changeTokenUnit,
    refreshProviderModels,
    loadProviderModels,
    setEnabled,
    toggleModelReasoning,
    toggleModelThinkingLevel,
    invalidateMcpRefresh,
    invalidateResourceReads,
    invalidateProviderCatalog,
    acceptMcpResources,
    runResourceWrite,
    refreshSavedMcpConfiguration,
    reportSkillRefresh,
    acceptSkillResources,
    refreshSavedSkillConfiguration,
    invalidateModelRefresh,
    modelProjectionOwner,
    acceptModelResources,
    refreshSavedModelConfiguration,
    modelEditorRecovery,
    saveCustomModel,
    deleteMcp,
    acceptExtensionResources,
    runExtensionWrite,
    refreshSavedExtensionConfiguration,
    deleteExtension,
    toggleExtension,
    trustExtension,
    reloadExtensions,
    rollbackExtension,
    deleteCustomModel,
    discoverProviderModels,
    importProviderModels,
    saveProvider,
    toggleProvider,
    deleteProvider,
    currentMcpPayload,
    testCurrentMcp,
    saveMcp,
    importSkillResource,
    toggleMcp,
    refreshMcpDetail,
    loadModelCatalog,
    writeModelSelection,
    selectModel,
    activeContextPolicy,
    contextUsageInfo,
    compactContext,
    selectThinking,
    saveDefaultSelection,
    selectDefaultModel,
    selectDefaultThinking,
  };
}
