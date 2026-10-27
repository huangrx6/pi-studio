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
      models(): Promise<{ models: Array<{ id: string; provider: string; model: string; name: string }>; current: string }>;
      settings(): Promise<{ providers: Array<{ id: string; name: string; mode: string; models: number }>; mcp: Array<{ name: string; transport: string; enabled: boolean; target: string; description: string }>; skills: Array<{ name: string; description: string; path: string; scope: string }>; authPath: string; mcpPath: string; model: { modelRef: string; label: string } }>;
      setKey(payload: { providerId: string; apiKey: string }): Promise<any>;
      setMcpEnabled(payload: { name: string; enabled: boolean }): Promise<any>;
      setModel(modelRef: string): Promise<{ modelRef: string; label: string }>;
      onPrompt(listener: (payload: { requestId: string; type: 'delta' | 'tool' | 'done' | 'error'; text?: string; name?: string; status?: string; message?: string }) => void): () => void;
    };
  }
}
