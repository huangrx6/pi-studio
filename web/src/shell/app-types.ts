import type {
  AgentToolSelection,
  TemporaryCapabilitiesSnapshot,
  ToolProfilesSnapshot,
} from '../types/agent-tool-types';
import type { PermissionProfilesSnapshot } from '../types/permission-types';
import type { TurnDiff, TurnDiffFile } from '../types/chat-types';
import type { ConversationSummary } from '../types/durable-types';
import type { ExtensionHostSnapshot } from '../types/extension-types';
import type { FilePreviewResult } from '../types/file-preview-types';
import type { HarnessSettingsSnapshot } from '../types/harness-types';
import type { RuntimeRefreshSnapshot, StudioRuntimeVersions } from '../types/runtime-types';
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
    ownerPluginId?: string;
    origin?: 'plugin' | 'user' | 'builtin';
    managed?: boolean;
    userOverride?: boolean;
    oauthConnected: boolean;
    connected: boolean;
    toolCount: number;
    error: string;
    stderr: string;
    tools: Array<{ name: string; originalName: string; description: string; exposure: 'direct' | 'deferred' | 'hidden'; enabled: boolean }>;
  }>;
  plugins?: Array<{
    id: string;
    name: string;
    version: string;
    publisher: string;
    description: string;
    icon: string;
    category: string;
    homepage: string;
    sourcePath: string;
    installPath: string;
    provides: {
      mcp?: Array<{ name: string; transport?: string; description?: string }>;
      skills?: Array<{ path: string; name?: string }>;
      cli?: Array<{ id: string; name: string; kind?: string; description?: string; pathEnv?: boolean; commands?: Array<{ summary?: string; example?: string }> }>;
      extension?: { path: string } | null;
    };
    enabled: boolean;
    contentHash: string;
    installedAt: number;
    updatedAt: number;
  }>;
  skills: Array<{
    name: string;
    description: string;
    path: string;
    baseDir: string;
    scope: 'user' | 'project';
    origin: 'studio' | 'agents' | 'plugin';
    ownerPluginId?: string;
    managed?: boolean;
    userOverride?: boolean;
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
  toolProfiles: ToolProfilesSnapshot;
  permissionProfiles: PermissionProfilesSnapshot;
  temporaryCapabilities?: TemporaryCapabilitiesSnapshot;
  harness: HarnessSettingsSnapshot;
  storagePath: string;
  runtimeVersions: StudioRuntimeVersions;
  databasePath: string;
  attachmentsPath: string;
  backupsPath: string;
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
  /** Actual successful preview source, retained across fallback and cache reuse. */
  actionSource?: PanelFileSource;
  changeKey?: string;
  path: string;
  size: number;
  binary: boolean;
  text: string;
  /** 工作区文件带结构化预览（Markdown/JSON/CSV/PDF/HTML 等），由共享预览组件渲染。 */
  preview?: FilePreviewResult;
};

export type PanelFileSource = 'workspace' | 'attachment' | 'diff' | 'external';

export type PanelTab = {
  id: string;
  kind: 'files' | 'file' | 'diff' | 'changes' | 'temporary' | 'terminal' | 'services' | 'browser'
    | 'progress' | 'trace' | 'subagents' | 'git' | 'extension';
  title: string;
  tooltip?: string;
  path?: string;
  source?: PanelFileSource;
  cwd?: string;
  sessionId?: string;
  diff?: TurnDiffFile;
  turnAt?: number;
  url?: string;
  /** 浏览器面板：递增后通知内部打开新的网页标签。 */
  openNonce?: number;
  /** Agent browser_open ack token while the guest is attaching. */
  commandRequestId?: string;
  browserLibrary?: { id: string; view: import('../features/browser/browser-history').BrowserLibraryView };
  /** 终端重启计数：变化后以同一个 id 重新挂载并重建 PTY。 */
  restart?: number;
  /** 用户手动改过标题：shell 的 OSC 标题不再覆盖它。 */
  customTitle?: boolean;
  review?: { sessionId: string; initial: TurnDiff; turns: TurnDiff[]; focusPath?: string };
  progressPage?: 'summary' | 'tasks' | 'history';
  childKey?: string;
  gitPage?: import('../types/git-types').GitTab;
  extensionPanel?: { extensionId: string; panelId: string; global?: boolean };
};
