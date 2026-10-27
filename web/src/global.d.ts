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
      onPrompt(listener: (payload: { requestId: string; type: 'delta' | 'tool' | 'done' | 'error'; text?: string; name?: string; status?: string; message?: string }) => void): () => void;
    };
  }
}
