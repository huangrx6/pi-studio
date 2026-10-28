export type TextBlock = { type: 'text'; text: string };
export type ImageBlock = { type: 'image'; data: string; mimeType: string };
export type ThinkingBlock = { type: 'thinking'; thinking: string; redacted?: boolean };
export type ToolCallBlock = { type: 'toolCall'; id: string; name: string; arguments: Record<string, unknown>; namespace?: string };
export type ContentBlock = TextBlock | ImageBlock | ThinkingBlock | ToolCallBlock;

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
};
