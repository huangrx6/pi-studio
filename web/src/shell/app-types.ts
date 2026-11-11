import type { AgentToolSelection } from '../types/agent-tool-types';
import type { TurnDiff, TurnDiffFile } from '../types/chat-types';
import type { ConversationSummary } from '../types/durable-types';
import type { ExtensionHostSnapshot } from '../types/extension-types';
import type { FilePreviewResult } from '../types/file-preview-types';
import type { HarnessSettingsSnapshot } from '../types/harness-types';
import type { ThinkingLevel } from '../types/model-types';
import type { RuntimeRefreshSnapshot } from '../types/runtime-types';
import type { SubagentChild } from '../types/subagent-types';
import type { CustomModelConfig, ModelProvider } from '../features/models/model-settings-types';

export type PiSessionSummary = ConversationSummary;

export type DispatchOutcome =
  | { state: 'rejected'; current: boolean; error: string }
  | { state: 'admitted'; current: boolean }
  | { state: 'admitted-but-postcommit-read-failed'; current: boolean; error: string };

export type PiWorkspace = {
  cwd: string;
  name: string;
  sessions: PiSessionSummary[];
  sessionCount?: number;
  archivedCount?: number;
};

export type MenuBarPreference = { available: boolean; enabled: boolean; platform: string };

/** 设置页当前打开的编辑弹窗；editId 为空表示新建。 */
export type SettingsEditor = { kind: 'provider' | 'model' | 'mcp' | 'skill'; editId?: string; providerId?: string };

export type SettingsSnapshot = {
  customModels: CustomModelConfig[];
  providers: ModelProvider[];
  mcp: Array<{
    name: string;
    transport: string;
    enabled: boolean;
    target: string;
    cwd: string;
    description: string;
    exposure: 'direct' | 'deferred' | 'hidden';
    toolExposure: Record<string, 'direct' | 'deferred' | 'hidden'>;
    timeoutSeconds: number;
    envKeys: string[];
    headerKeys: string[];
    oauthConnected: boolean;
    connected: boolean;
    toolCount: number;
    error: string;
    stderr: string;
    tools: Array<{ name: string; originalName: string; description: string; exposure: 'direct' | 'deferred' | 'hidden' }>;
  }>;
  skills: Array<{
    name: string;
    description: string;
    path: string;
    baseDir: string;
    scope: 'user' | 'project';
    origin: 'studio' | 'agents';
    bytes: number;
    version: string;
    promptTokens: number;
    resourceCount: number;
    totalBytes: number;
    fingerprint: string;
    trusted: boolean;
    trustChanged: boolean;
    available: boolean;
    disableModelInvocation: boolean;
    warnings: string[];
  }>;
  skillErrors: Array<{ path: string; message: string }>;
  extensions: ExtensionHostSnapshot['extensions'];
  extensionErrors: ExtensionHostSnapshot['errors'];
  extensionApiVersion: number;
  extensionRegistryUrl: string;
  enabledModels: string[];
  agentTools: AgentToolSelection;
  harness: HarnessSettingsSnapshot;
  storagePath: string;
  databasePath: string;
  skillsPath: string;
  agentsSkillsPath: string;
  projectSkillsPath: string;
  projectAgentsSkillsPath: string;
  extensionsPath: string;
  projectExtensionsPath: string;
  model: { modelRef: string; label: string };
  runtimeRefresh?: RuntimeRefreshSnapshot;
};

export type SkillInfo = SettingsSnapshot['skills'][number];
export type McpInfo = SettingsSnapshot['mcp'][number];
export type McpTestResult = Awaited<ReturnType<typeof window.piApi.testMcp>>;

export type PanelFile = {
  path: string;
  size: number;
  binary: boolean;
  text: string;
  /** 工作区文件带结构化预览（Markdown/JSON/CSV/PDF/HTML 等），由共享预览组件渲染。 */
  preview?: FilePreviewResult;
};

export type PanelFileSource = 'workspace' | 'attachment' | 'diff' | 'external';

export type ModelComparisonContext = {
  parentId: string;
  cwd: string;
  prompt: string;
  mentions: string[];
  attachments: string[];
  images: Array<{ type: 'image'; data: string; mimeType: string }>;
  initialModelRef: string;
  initialThinkingLevel: ThinkingLevel;
};

export type PanelTab = {
  id: string;
  kind: 'files' | 'file' | 'diff' | 'changes' | 'temporary' | 'terminal' | 'services' | 'browser' | 'comparison';
  title: string;
  tooltip?: string;
  path?: string;
  source?: PanelFileSource;
  cwd?: string;
  sessionId?: string;
  diff?: TurnDiffFile;
  url?: string;
  review?: { sessionId: string; initial: TurnDiff; turns: TurnDiff[]; focusPath?: string };
};

export type AgentView =
  | { kind: 'conversation' }
  | { kind: 'extensions'; itemId?: string }
  | { kind: 'agents'; child?: SubagentChild }
  | { kind: 'trace' };
