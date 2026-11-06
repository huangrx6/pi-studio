import type { ChatMessage } from '../../types/chat-types';

export type ComposerImagePayload = {
  type: 'image';
  data: string;
  mimeType: string;
};

/** Durable submission prepared from one composer draft. */
export type PreparedSubmission = {
  sessionId: string;
  requestId: string;
  displayText: string;
  outgoingText: string;
  content: ChatMessage['content'];
  persistentAttachments: NonNullable<ChatMessage['attachments']>;
  imagePayload: ComposerImagePayload[];
  mentions: string[];
  attachmentPaths: string[];
};

/** A queued prompt keeps enough input to edit, reorder and retry it. */
export type QueuedPrompt = {
  id: string;
  order: number;
  text: string;
  attachments: import('../../types/chat-types').ComposerAttachment[];
  submission: PreparedSubmission;
  /** Automatic draining pauses on rejected entries until the user retries. */
  autoRetryError?: string;
};

/** Original queue identity and slot retained while its text is edited. */
export type QueuedEditContext = { id: string; index: number };
