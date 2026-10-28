export type TextBlock = { type: 'text'; text: string };
export type ImageBlock = { type: 'image'; data: string; mimeType: string };
export type ThinkingBlock = { type: 'thinking'; thinking: string; redacted?: boolean };
export type ToolCallBlock = { type: 'toolCall'; id: string; name: string; arguments: Record<string, unknown>; namespace?: string };
export type ContentBlock = TextBlock | ImageBlock | ThinkingBlock | ToolCallBlock;

export type ChatAttachment = { name: string; path: string; bytes: number; lines: number; kind?: 'text' | 'file'; mime?: string };
export type ComposerAttachment = { id: string; kind: 'image' | 'file'; name: string; mime: string; bytes: number; data?: string; path?: string; lines?: number; marker?: string };
export type TodoTask = { id: number; subject: string; description?: string; activeForm?: string; status: 'pending' | 'in_progress' | 'completed' | 'deleted'; blockedBy?: number[]; archivedAt?: number; closedAt?: number; closedReason?: string; createdAt?: number; updatedAt?: number };
export type TodoDetails = { schemaVersion?: number; tasks: TodoTask[]; nextId: number };
export type UploadedAttachment = { name: string; path: string; bytes: number; lines: number; kind: 'file'; mime: string; marker: string };

export type ChatMessage = {
  role: 'user' | 'assistant' | 'toolResult';
  content: ContentBlock[];
  timestamp?: number;
  streaming?: boolean;
  stopReason?: string;
  errorMessage?: string;
  model?: string;
  provider?: string;
  usage?: unknown;
  thinkingLevel?: string;
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
  durationMs?: number;
  attachments?: ChatAttachment[];
  details?: unknown;
};

export type ComposerCommandSource = 'builtin' | 'extension' | 'prompt' | 'skill';
export type ComposerCommand = { name: string; description: string; source: ComposerCommandSource; argumentHint?: string };
export type ComposerFile = { name: string; path: string; type: 'file' | 'directory' };
