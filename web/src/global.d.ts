export {};

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

interface PiMessage {
  role: 'user' | 'assistant';
  text: string;
}

interface PiDetail {
  id: string;
  cwd: string;
  title: string;
  messages: PiMessage[];
}

interface SettingsSnapshot {
  customModels: Array<{ providerId: string; modelId: string; name: string; contextWindow?: number; maxTokens?: number; supportsImages: boolean; reasoning: boolean }>;
  providers: Array<{ id: string; name: string; mode: string; envName?: string; envAvailable?: boolean; models: number }>;
  mcp: Array<{ name: string; transport: string; enabled: boolean; target: string; description: string }>;
  skills: Array<{ name: string; description: string; path: string; scope: string }>;
  extensions: Array<{ name: string; scope: string; path: string; kind: string; source?: string }>;
  packages: Array<{ source: string; name: string }>;
  extensionData: string[];
  enabledModels: string[];
  authPath: string;
  mcpPath: string;
  modelsPath: string;
  model: { modelRef: string; label: string };
}

declare global {
  interface Window {
    piApi: {
      state(): Promise<{ workspaces: PiWorkspace[]; model: { modelRef: string; label: string }; cwd: string }>;
      createSession(cwd: string): Promise<PiDetail>;
      session(id: string): Promise<PiDetail | undefined>;
      prompt(payload: { sessionId: string; text: string; requestId: string }): Promise<void>;
      files(cwd: string, path: string): Promise<{ path: string; entries: Array<{ name: string; path: string; type: 'file' | 'directory'; size: number }> }>;
      file(cwd: string, path: string): Promise<{ path: string; size: number; binary: boolean; text: string }>;
      chooseWorkspace(): Promise<string | undefined>;
      models(): Promise<{ models: Array<{ id: string; provider: string; model: string; name: string }>; enabled: string[]; current: string }>;
      providerModels(providerId: string): Promise<{ models: Array<{ id: string; model: string; name: string; enabled: boolean; contextWindow?: number; maxTokens?: number; supportsImages?: boolean }> }>;
      providerConfig(providerId: string): Promise<{ providerId: string; baseUrl: string; api: string }>;
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
      addProvider(payload: { providerId: string; baseUrl: string; api: string; modelId: string; modelName: string; apiKey?: string; editing?: boolean }): Promise<{ settings: SettingsSnapshot; models: { models: Array<{ id: string; name: string }>; current: string; enabled: string[] } }>;
      addMcp(payload: { name: string; transport: string; command?: string; args: string[]; url?: string; description?: string; env?: string; originalName?: string }): Promise<SettingsSnapshot>;
      addSkill(payload: { scope: string; cwd?: string }): Promise<any>;
      addExtension(payload: { scope: string; cwd?: string }): Promise<any>;
      onOpenSettings(listener: () => void): () => void;
      setModel(modelRef: string): Promise<{ modelRef: string; label: string }>;
      onPrompt(listener: (payload: { requestId: string; type: 'delta' | 'tool' | 'done' | 'error'; text?: string; name?: string; status?: string; message?: string }) => void): () => void;
    };
  }
}
