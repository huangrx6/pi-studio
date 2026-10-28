export {};
import type { ChatAttachment, ChatMessage, ComposerAttachment, ComposerCommand, ComposerFile, UploadedAttachment } from './chat-types';
import type { ModelCatalog, ModelSelection, ThinkingLevel } from './model-types';

interface PiSessionSummary {
  id: string;
  cwd: string;
  title: string;
  updatedAt: number;
  messageCount: number;
}

interface PiWorkspace {
  cwd: string;
  name: string;
  sessions: PiSessionSummary[];
}

interface PiDetail {
  id: string;
  cwd: string;
  title: string;
  messages: ChatMessage[];
}

interface SettingsSnapshot {
  customModels: Array<{ providerId: string; modelId: string; name: string; contextWindow?: number; maxTokens?: number; supportsImages: boolean; reasoning: boolean }>;
  providers: Array<{ id: string; name: string; mode: string; authConfigured?: boolean; envName?: string; envAvailable?: boolean; icon?: string; models: number }>;
  mcp: Array<{ name: string; transport: string; enabled: boolean; target: string; description: string }>;
  skills: Array<{ name: string; description: string; path: string; scope: string }>;
  extensions: Array<{ name: string; scope: string; path: string; kind: string; source?: string }>;
  packages: Array<{ source: string; name: string }>;
  extensionData: string[];
  enabledModels: string[];
  authPath: string;
  mcpPath: string;
  modelsPath: string;
  model: ModelSelection;
}

declare global {
  interface Window {
    piApi: {
      state(cwd?: string): Promise<{ workspaces: PiWorkspace[]; model: ModelSelection; cwd: string }>;
      createSession(cwd: string): Promise<PiDetail>;
      session(id: string): Promise<PiDetail | undefined>;
      prompt(payload: { sessionId: string; text: string; requestId: string; mentions?: string[]; attachments?: string[]; images?: Array<{ type: 'image'; data: string; mimeType: string }> }): Promise<void>;
      files(cwd: string, path: string): Promise<{ path: string; entries: Array<{ name: string; path: string; type: 'file' | 'directory'; size: number }> }>;
      file(cwd: string, path: string): Promise<{ path: string; size: number; binary: boolean; text: string }>;
      fileActions(payload: { cwd: string; path: string }): Promise<{ apps: Array<{ name: string; path: string; icon?: string }> }>;
      openWith(payload: { cwd: string; path: string; appPath?: string }): Promise<{ ok: boolean }>;
      revealFile(payload: { cwd: string; path: string }): Promise<{ ok: boolean }>;
      openExternal(url: string): Promise<{ ok: boolean }>;
      openLink(url: string, mode: 'external' | 'window'): Promise<{ ok: boolean }>;
      composerResources(payload: { sessionId?: string; cwd?: string }): Promise<{ commands: ComposerCommand[] }>;
      searchFiles(payload: { cwd: string; query: string }): Promise<{ files: ComposerFile[] }>;
      saveAttachment(payload: { sessionId: string; text: string }): Promise<ChatAttachment & { notice: string; promptText: string }>;
      queuePrompt(payload: { sessionId: string; text: string; behavior: 'queue' | 'steer'; mentions?: string[]; attachments?: string[]; images?: Array<{ type: 'image'; data: string; mimeType: string }> }): Promise<{ disposition: string }>;
      runExtensionCommand(payload: { sessionId: string; command: string }): Promise<{ ok: boolean }>;
      pickAttachments(payload: { sessionId?: string }): Promise<{ attachments: ComposerAttachment[] }>;
      saveUpload(payload: { sessionId?: string; name: string; mime: string; data: string }): Promise<UploadedAttachment>;
      chooseWorkspace(): Promise<string | undefined>;
      models(cwd?: string): Promise<ModelCatalog>;
      providerModels(providerId: string): Promise<{ models: Array<{ id: string; model: string; name: string; enabled: boolean; contextWindow?: number; maxTokens?: number; supportsImages?: boolean }> }>;
      providerConfig(providerId: string): Promise<{ providerId: string; baseUrl: string; api: string; icon: string }>;
      mcpConfig(name: string): Promise<{ name: string; transport: string; command: string; args: string[]; url: string; description: string; env: string }>;
      setEnabledModels(models: string[]): Promise<any>;
      addCustomModel(payload: { providerId: string; modelId: string; name: string; contextWindow?: number; maxTokens?: number; supportsImages?: boolean; reasoning?: boolean; editing?: boolean }): Promise<SettingsSnapshot>;
      addPackage(source: string): Promise<any>;
      removePackage(source: string): Promise<any>;
      removeMcp(name: string): Promise<any>;
      removeSkill(path: string): Promise<any>;
      removeExtension(path: string): Promise<any>;
      removeCustomModel(payload: { providerId: string; modelId: string }): Promise<any>;
      settings(cwd?: string): Promise<SettingsSnapshot>;
      setKey(payload: { providerId: string; apiKey: string }): Promise<any>;
      setMcpEnabled(payload: { name: string; enabled: boolean }): Promise<any>;
      addProvider(payload: { providerId: string; baseUrl: string; api: string; modelId: string; modelName: string; apiKey?: string; editing?: boolean }): Promise<{ settings: SettingsSnapshot; models: ModelCatalog }>;
      addMcp(payload: { name: string; transport: string; command?: string; args: string[]; url?: string; description?: string; env?: string; originalName?: string }): Promise<SettingsSnapshot>;
      addSkill(payload: { scope: string; cwd?: string }): Promise<any>;
      addExtension(payload: { scope: string; cwd?: string }): Promise<any>;
      onOpenSettings(listener: () => void): () => void;
      setModel(modelRef: string, cwd?: string): Promise<ModelSelection>;
      setThinkingLevel(payload: { modelRef: string; level: ThinkingLevel; cwd?: string }): Promise<ModelSelection>;
      extensionState(sessionId: string): Promise<{ statuses: Array<[string, string]>; footer: string }>;
      onExtensionStatus(listener: (payload: { sessionId: string; key: string; text: string }) => void): () => void;
      onExtensionFooter(listener: (payload: { sessionId: string; text: string }) => void): () => void;
      onExtensionNotify(listener: (payload: { sessionId: string; message: string; type: 'info' | 'warning' | 'error' }) => void): () => void;
      onPrompt(listener: (payload: { requestId: string; type: 'message_start' | 'message_update' | 'message_end' | 'retry-start' | 'retry-end' | 'done' | 'error'; message?: ChatMessage; error?: string; attempt?: number; maxAttempts?: number; delayMs?: number; success?: boolean; finalError?: string; errorMessage?: string }) => void): () => void;
    };
  }
}
