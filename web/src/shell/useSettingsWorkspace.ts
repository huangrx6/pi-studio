import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { Dispatch, MutableRefObject, SetStateAction } from 'react';
import type { ChatMessage, ComposerAttachment } from '../types/chat-types';
import type { ConversationPage } from '../types/durable-types';
import type { ModelSelection, ModelOption } from '../types/model-types';
import type { TokenField, TokenUnit } from '../shared/token-units';
import type { OutlineData } from '../features/conversation/outline-model';
import type { ContextPolicy } from '../features/conversation/ContextUsageChip';
import type { SubagentChild } from '../types/subagent-types';
import type {
  ExtensionHostItem,
  ExtensionInstallPreview,
  ExtensionMutationResult,
  OfficialExtensionCatalogSnapshot,
} from '../types/extension-types';
import type {
  DiscoveredModel,
  ProviderCatalogState,
  ProviderDiscoveryState,
  ProviderModelInfo,
} from '../features/models/model-settings-types';
import { emptyCustomModelConfig } from '../features/models/model-settings-types';
import type { McpInfo, McpTestResult, PiWorkspace, SettingsEditor, SettingsSnapshot, SkillInfo } from './app-types';
import type { SettingsTab } from './app-shell-config';
import type { useActionConfirmation } from '../shared/ConfirmDialog';
import type { createSettingsDraftGuard } from '../shared/settings-draft-guard';
import type { NotificationTone } from './NotificationCenter';
import type { AppNotificationAction } from './NotificationCenter';
import { useAppSettingsController } from './useAppSettings';

type Setter<T> = Dispatch<SetStateAction<T>>;

type SettingsWorkspaceOptions = {
  workspace: string;
  workspaceRef: MutableRefObject<string>;
  sessionId?: string;
  sessionRef: MutableRefObject<{
    id: string;
    cwd: string;
    title: string;
  } | null>;
  sessionLoadRef: MutableRefObject<number>;
  workspaces: PiWorkspace[];
  modelSelection: ModelSelection;
  setModelSelection: Setter<ModelSelection>;
  setDefaultModelSelection: Setter<ModelSelection>;
  models: ModelOption[];
  setModels: Setter<ModelOption[]>;
  modelRevisionRef: MutableRefObject<Map<string, number>>;
  modelWritesRef: MutableRefObject<Set<string>>;
  modelWriteResultsRef: MutableRefObject<Map<string, { revision: number; selection: ModelSelection }>>;
  defaultModelWorkspaceRef: MutableRefObject<string>;
  settingsRequestRef: MutableRefObject<number>;
  catalogRequestRef: MutableRefObject<number>;
  setSettingsError: Setter<string | null>;
  settingsDraftGuard: ReturnType<typeof createSettingsDraftGuard>;
  settingsLeaveConfirmation: ReturnType<typeof useActionConfirmation>;
  actionConfirmation: ReturnType<typeof useActionConfirmation>;
  messages: ChatMessage[];
  compaction: { active: boolean; reason?: string };
  setCompaction: Setter<{ active: boolean; reason?: string }>;
  contextPolicy: ContextPolicy | null;
  setContextPolicy: Setter<ContextPolicy | null>;
  turnActiveRef: MutableRefObject<boolean>;
  transcriptCacheRef: MutableRefObject<Map<string, {
    at: number;
    detail: ConversationPage;
    outline?: OutlineData;
    children: SubagentChild[];
  }>>;
  composerAttachments: ComposerAttachment[];
  setComposerFeedback: Setter<{ message: string; tone: 'info' | 'warning' } | null>;
  showComposerFeedback: (message: string, tone?: 'info' | 'warning') => void;
  pushNotification: (
    message: string,
    tone?: NotificationTone,
    title?: string,
    sessionId?: string,
    action?: AppNotificationAction,
  ) => void;
};

/**
 * Owns settings-only state and the settings controller. The main application
 * keeps the active workspace, session and model selection that settings read
 * but does not need to know about editor drafts or resource refresh receipts.
 */
export function useSettingsWorkspace(options: SettingsWorkspaceOptions) {
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
    modelRevisionRef,
    modelWritesRef,
    modelWriteResultsRef,
    defaultModelWorkspaceRef,
    settingsRequestRef,
    catalogRequestRef,
    setSettingsError,
    settingsDraftGuard,
    settingsLeaveConfirmation,
    actionConfirmation,
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
  } = options;

  const [modelQuery, setModelQuery] = useState('');
  const [modelView, setModelView] = useState<'all' | 'provider'>('all');
  const [enabledModels, setEnabledModels] = useState<string[]>([]);
  const [expandedProvider, setExpandedProvider] = useState<string | null>(null);
  const [providerModels, setProviderModels] = useState<Record<string, ProviderModelInfo[]>>({});
  const [modelRefreshError, setModelRefreshError] = useState<string | null>(null);
  const [modelRefreshBusy, setModelRefreshBusy] = useState(false);
  const [modelRefreshSummary, setModelRefreshSummary] = useState('配置已保存');
  const [mcpRefreshError, setMcpRefreshError] = useState<string | null>(null);
  const [mcpRefreshSummary, setMcpRefreshSummary] = useState('MCP 配置已保存');
  const [mcpRefreshBusy, setMcpRefreshBusy] = useState(false);
  const [skillRefreshError, setSkillRefreshError] = useState<string | null>(null);
  const [skillRefreshSummary, setSkillRefreshSummary] = useState('技能更改已完成');
  const [skillRefreshBusy, setSkillRefreshBusy] = useState(false);
  const skillRefreshRequestRef = useRef(0);
  const skillRefreshLockRef = useRef(false);
  const skillRefreshTargetsRef = useRef(new Set<string>());
  const extensionMutationReceiptsRef = useRef(new Map<string, {
    result: ExtensionMutationResult;
    cwd: string;
    summary: string;
  }>());
  const extensionRefreshRequestRef = useRef(0);
  const extensionRefreshLockRef = useRef(false);
  const [extensionRefreshError, setExtensionRefreshError] = useState<string | null>(null);
  const [extensionRefreshBusy, setExtensionRefreshBusy] = useState(false);
  const mcpRefreshRequestRef = useRef(0);
  const mcpOAuthRecoveryRef = useRef<{ cwd: string; request: number; generation: number } | null>(null);
  const mcpRefreshLockRef = useRef(false);
  const resourceWriteRef = useRef<{ cwd: string } | null>(null);
  const resourceCommitRef = useRef<{ cwd: string } | null>(null);
  const resourcePendingRef = useRef({ models: false, mcp: false, skills: false });
  const [resourceWriteBusy, setResourceWriteBusy] = useState(false);
  const modelRefreshLockRef = useRef(false);
  const modelRefreshRequestRef = useRef(0);
  const [providerCatalogState, setProviderCatalogState] = useState<Record<string, ProviderCatalogState>>({});
  const providerCatalogRequestsRef = useRef(new Map<string, number>());
  const providerDiscoveryRequestsRef = useRef(new Map<string, number>());
  const [providerDiscovery, setProviderDiscovery] = useState<Record<string, ProviderDiscoveryState>>({});
  const [customModel, setCustomModel] = useState(emptyCustomModelConfig);
  const [tokenUnits, setTokenUnits] = useState<Record<TokenField, TokenUnit>>({
    contextWindow: 'k',
    maxTokens: 'k',
  });
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsTab, setSettingsTab] = useState<SettingsTab>('general');
  const [settingsData, setSettingsData] = useState<SettingsSnapshot | null>(null);
  const [extensionInstallerOpen, setExtensionInstallerOpen] = useState(false);
  const [extensionInstallPreview, setExtensionInstallPreview] = useState<ExtensionInstallPreview | null>(null);
  const [extensionDetail, setExtensionDetail] = useState<ExtensionHostItem | null>(null);
  const [officialExtensions, setOfficialExtensions] = useState<OfficialExtensionCatalogSnapshot | null>(null);
  const [officialExtensionsBusy, setOfficialExtensionsBusy] = useState(false);
  const [officialExtensionsError, setOfficialExtensionsError] = useState<string | null>(null);
  const [officialExtensionBusyId, setOfficialExtensionBusyId] = useState<string | null>(null);
  const [editor, setEditor] = useState<SettingsEditor | null>(null);
  const [editorError, setEditorError] = useState<string | null>(null);
  const [editorLoading, setEditorLoading] = useState(false);
  const [editorSaving, setEditorSaving] = useState(false);
  const [editorCommitted, setEditorCommitted] = useState(false);
  const editorSaveRef = useRef(false);
  const editorRecoveryRef = useRef<null | (() => Promise<void>)>(null);
  const editorScopeRef = useRef('');
  const editorBaselineRef = useRef<string | null>(null);
  const editorDirtyRef = useRef(false);
  const editorCloseRef = useRef(false);
  const editorRequestRef = useRef(0);
  const mcpTestRequestRef = useRef(0);
  const mcpTestLockRef = useRef(false);
  const [resourceScope, setResourceScope] = useState<'user' | 'project'>('user');
  const [skillWorkspace, setSkillWorkspace] = useState('');
  const [settingsBusy, setSettingsBusy] = useState(false);
  const [defaultModelBusy, setDefaultModelBusy] = useState(false);
  const [providerDraft, setProviderDraft] = useState({
    providerId: '',
    name: '',
    baseUrl: '',
    api: 'openai-completions',
    apiKey: '',
    icon: '',
    modelsUrl: '',
  });
  const [mcpDraft, setMcpDraftState] = useState({
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
  const mcpDraftRef = useRef(mcpDraft);
  const [mcpTestResult, setMcpTestResult] = useState<McpTestResult | null>(null);
  const [mcpTesting, setMcpTesting] = useState(false);
  const [skillDetail, setSkillDetailState] = useState<SkillInfo | null>(null);
  const skillDetailRef = useRef<SkillInfo | null>(null);
  const skillDetailGenerationRef = useRef(0);
  const [skillDetailError, setSkillDetailError] = useState<string | null>(null);
  const [mcpDetail, setMcpDetailState] = useState<McpInfo | null>(null);
  const mcpDetailRef = useRef<McpInfo | null>(null);
  const mcpDetailGenerationRef = useRef(0);
  const mcpDetailOwnerGeneration = mcpDetailGenerationRef.current;
  const settingsContentRef = useRef<HTMLElement>(null);
  const settingsReturnFocusRef = useRef<HTMLElement | null>(null);
  const officialCatalogRequestRef = useRef(0);
  const originalMcpArgsRef = useRef<string[] | null>(null);

  function setMcpDraft(update: typeof mcpDraft | ((current: typeof mcpDraft) => typeof mcpDraft)) {
    const next = typeof update === 'function' ? update(mcpDraftRef.current) : update;
    mcpDraftRef.current = next;
    mcpTestRequestRef.current += 1;
    mcpTestLockRef.current = false;
    setMcpTesting(false);
    setMcpTestResult(null);
    setMcpDraftState(next);
  }

  function setSkillDetail(value: SkillInfo | null) {
    skillDetailRef.current = value;
    setSkillDetailState(value);
  }

  function openMcpDetail(server: McpInfo) {
    mcpDetailGenerationRef.current += 1;
    mcpDetailRef.current = server;
    setMcpDetailState(server);
  }

  function closeMcpDetail() {
    mcpDetailGenerationRef.current += 1;
    mcpDetailRef.current = null;
    setMcpDetailState(null);
  }

  useEffect(() => { closeMcpDetail(); }, [workspace]);

  useEffect(() => {
    extensionRefreshRequestRef.current += 1;
    modelRefreshRequestRef.current += 1;
    modelRefreshLockRef.current = false;
    setModelRefreshBusy(false);
    mcpRefreshRequestRef.current += 1;
    mcpRefreshLockRef.current = false;
    setMcpRefreshBusy(false);
    resourceWriteRef.current = null;
    skillRefreshRequestRef.current += 1;
    skillRefreshLockRef.current = false;
    setSkillRefreshBusy(false);
    setResourceWriteBusy(Boolean(resourceCommitRef.current));
    for (const [id, request] of providerCatalogRequestsRef.current) providerCatalogRequestsRef.current.set(id, request + 1);
    for (const [id, request] of providerDiscoveryRequestsRef.current) providerDiscoveryRequestsRef.current.set(id, request + 1);
    setProviderModels({});
    setProviderCatalogState({});
    setProviderDiscovery({});
    setExpandedProvider(null);
    return () => {
      modelRefreshRequestRef.current += 1;
      mcpRefreshRequestRef.current += 1;
      skillRefreshRequestRef.current += 1;
      resourceWriteRef.current = null;
    };
  }, [workspace]);

  const controller = useAppSettingsController({
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
  });

  function openSkillDetail(skill: SkillInfo) {
    skillDetailGenerationRef.current += 1;
    setSkillDetail(skill);
    setSkillDetailError(null);
  }

  async function deleteSkill(skill: SkillInfo) {
    const generation = skillDetailGenerationRef.current;
    const ownsDetail = () => skillDetailRef.current?.path === skill.path
      && skillDetailGenerationRef.current === generation;
    await controller.runResourceWrite('skills', {
      summary: `技能「${skill.name}」已删除`,
      confirm: {
        title: '删除技能？',
        description: `「${skill.name}」所在的完整技能目录会被删除，此操作不可撤销。`,
        confirmLabel: '删除技能',
        tone: 'danger',
      },
      write: (cwd) => window.piApi.removeSkill(skill.path, cwd),
      apply: (snapshot) => controller.acceptSkillResources(snapshot),
      onCommitted: () => {
        setSettingsData((current) => current
          ? { ...current, skills: current.skills.filter((item) => item.path !== skill.path) }
          : current);
        if (ownsDetail()) closeSkillDetail();
      },
      onError: (message) => {
        if (ownsDetail()) setSkillDetailError(message);
        else setSettingsError(message);
      },
    });
  }

  async function toggleSkillTrust(skill: SkillInfo, trusted: boolean) {
    const generation = skillDetailGenerationRef.current;
    const ownsDetail = () => skillDetailRef.current?.path === skill.path
      && skillDetailGenerationRef.current === generation;
    await controller.runResourceWrite('skills', {
      summary: `技能「${skill.name}」已${trusted ? '信任' : '撤销信任'}`,
      confirm: trusted ? {
        title: '信任项目技能？',
        description: `「${skill.name}」可以指示模型运行脚本或修改文件。只有在你审查过目录内容和来源后才应信任；目录变化后旧信任会自动失效。`,
        confirmLabel: '信任技能',
      } : undefined,
      write: (cwd) => window.piApi.setSkillTrusted({ path: skill.path, trusted, cwd }),
      onCommitted: () => {
        if (ownsDetail()) {
          setSkillDetailError(null);
          setSkillDetail({ ...skill, trusted });
        }
      },
      apply: (snapshot) => {
        controller.acceptSkillResources(snapshot);
        const updated = snapshot.skills.find((item) => item.path === skill.path);
        if (ownsDetail() && updated) setSkillDetail(updated);
      },
      onError: (message) => {
        if (ownsDetail()) setSkillDetailError(message);
        else setSettingsError(message);
      },
    });
  }

  function closeSkillDetail() {
    skillDetailGenerationRef.current += 1;
    setSkillDetail(null);
    setSkillDetailError(null);
  }

  const editorFingerprint = JSON.stringify(editor?.kind === 'provider' ? providerDraft
    : editor?.kind === 'model' ? [customModel, tokenUnits]
      : editor?.kind === 'mcp' ? mcpDraft : [resourceScope, skillWorkspace]);
  useLayoutEffect(() => {
    if (editor && !editorLoading && editorBaselineRef.current === null) editorBaselineRef.current = editorFingerprint;
    editorDirtyRef.current = Boolean(editor && !editorCommitted && (editorSaving || (!editorLoading && editorBaselineRef.current !== editorFingerprint)));
  }, [editor, editorLoading, editorSaving, editorCommitted, editorFingerprint]);
  useLayoutEffect(() => settingsDraftGuard.register(
    Symbol('resource-editor'),
    () => ({ label: '资源编辑', dirty: editorDirtyRef.current }),
  ), [settingsDraftGuard]);
  useEffect(() => {
    if (editor && editorScopeRef.current !== workspace) controller.discardEditor();
  }, [workspace, editor, controller.discardEditor]);

  const editorUnavailable = Boolean(editor?.editId && (
    editor.kind === 'provider'
      ? !providerDraft.providerId
      : editor.kind === 'mcp'
        ? !originalMcpArgsRef.current
        : editor.kind === 'model'
          ? !customModel.modelId
          : false
  )) || Boolean(editor?.kind === 'skill' && resourceScope === 'project' && !skillWorkspace);
  const skillWorkspaceOptions = workspaces.map((item) => ({
    value: item.cwd,
    label: item.name || item.cwd,
    description: item.cwd,
  }));

  function submitEditor() {
    if (!editor || editorLoading || editorSaveRef.current || editorUnavailable) return;
    if (editorRecoveryRef.current) { void controller.retryEditorRefresh(); return; }
    if (editor.kind === 'provider') void controller.saveProvider();
    else if (editor.kind === 'model') void controller.saveCustomModel();
    else if (editor.kind === 'mcp') void controller.saveMcp();
    else void controller.importSkillResource(resourceScope);
  }

  const state = {
    settingsOpen,
    setSettingsOpen,
    settingsTab,
    setSettingsTab,
    settingsData,
    setSettingsData,
    settingsBusy,
    defaultModelBusy,
    modelQuery,
    setModelQuery,
    modelView,
    setModelView,
    enabledModels,
    expandedProvider,
    providerModels,
    modelRefreshError,
    modelRefreshBusy,
    modelRefreshSummary,
    mcpRefreshError,
    mcpRefreshSummary,
    mcpRefreshBusy,
    setMcpRefreshError,
    setMcpRefreshSummary,
    skillRefreshError,
    skillRefreshSummary,
    skillRefreshBusy,
    extensionRefreshError,
    extensionRefreshBusy,
    resourceWriteBusy,
    providerCatalogState,
    providerDiscovery,
    setProviderDiscovery,
    customModel,
    setCustomModel,
    tokenUnits,
    extensionInstallerOpen,
    setExtensionInstallerOpen,
    extensionInstallPreview,
    setExtensionInstallPreview,
    extensionDetail,
    setExtensionDetail,
    officialExtensions,
    officialExtensionsBusy,
    officialExtensionsError,
    officialExtensionBusyId,
    editor,
    editorError,
    editorLoading,
    editorSaving,
    editorCommitted,
    editorUnavailable,
    editorRequestId: editorRequestRef.current,
    resourceScope,
    setResourceScope,
    skillWorkspace,
    setSkillWorkspace,
    providerDraft,
    setProviderDraft,
    mcpDraft,
    setMcpDraft,
    mcpTesting,
    mcpTestResult,
    skillDetail,
    skillDetailError,
    skillDetailRef,
    skillDetailGenerationRef,
    setSkillDetail,
    setSkillDetailError,
    closeSkillDetail,
    openSkillDetail,
    deleteSkill,
    toggleSkillTrust,
    mcpDetail,
    openMcpDetail,
    closeMcpDetail,
    mcpDetailOwnerGeneration,
    settingsContentRef,
    settingsReturnFocusRef,
    skillRefreshRequestRef,
    mcpOAuthRecoveryRef,
    mcpRefreshRequestRef,
    resourcePendingRef,
    mcpDetailGenerationRef,
    skillWorkspaceOptions,
  };

  return { state, controller, submitEditor };
}

export type SettingsWorkspace = ReturnType<typeof useSettingsWorkspace>;
export type SettingsWorkspaceState = SettingsWorkspace['state'];
