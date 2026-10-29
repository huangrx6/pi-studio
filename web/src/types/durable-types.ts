import type { ChatMessage, TurnDiff } from './chat-types';
import type { ModelSelection } from './model-types';

export type ConversationKind = 'conversation' | 'durable';

export type ConversationSummary = {
  id: string;
  cwd: string;
  title: string;
  kind: ConversationKind;
  goal: string;
  pinned: boolean;
  archived: boolean;
  createdAt: number;
  updatedAt: number;
  messageCount?: number;
  running?: boolean;
};

export type ConversationPageCursor = string;

export type ConversationPage = ConversationSummary & {
  messages: ChatMessage[];
  model: ModelSelection;
  turnDiffs: TurnDiff[];
  page: {
    hasOlder: boolean;
    nextCursor?: ConversationPageCursor;
  };
  messageStart: number;
  running: boolean;
  requestId: string;
  compacting: boolean;
  generation?: ChatMessage;
  retry?: { at: number; error: string };
  inbox: unknown[];
  tools: unknown[];
  nestedTools: unknown[];
  usage?: unknown;
  agent: Record<string, unknown>;
};

export type ConversationSnapshot = ConversationSummary & {
  model: ModelSelection;
  running: boolean;
  requestId: string;
  compacting: boolean;
  generation?: ChatMessage;
  retry?: { at: number; error: string };
  inbox: unknown[];
  tools: unknown[];
  nestedTools: unknown[];
  usage?: unknown;
  agent: Record<string, unknown>;
};

export type ConversationOutline = {
  id: string;
  items: Array<{
    sourceIndex: number;
    text: string;
    timestamp?: number;
  }>;
  totalMessages: number;
};

export type ConversationSubmitInput = {
  id: string;
  text: string;
  requestId: string;
  whenBusy?: 'steer' | 'followUp' | 'reject';
  mentions?: string[];
  attachments?: string[];
  images?: Array<{ type: 'image'; data: string; mimeType: string }>;
};

export type ConversationSubmitResult = {
  conversationId: string;
  submissionId: string;
  requestId: string;
  status: 'queued' | 'placed' | 'done' | 'unanswered';
  whenBusy: 'steer' | 'followUp' | 'reject';
};

export type ConversationTaskNode = {
  id: string;
  kind: string;
  conversationId: string;
  owner?: string;
  background: boolean;
  abortRequested: boolean;
  blocked?: {
    reason: 'missing_task' | 'task_too_old' | 'migration_failed' | 'restart_limit';
  };
  state:
    | { status: 'pending' | 'running'; phase: string }
    | { status: 'waiting'; phase: string; on: string[]; policy: 'allSettled' | 'failFast' }
    | { status: 'sleeping'; phase: string; until: number }
    | { status: 'completing'; outcome: 'completed' | 'failed' | 'aborted' | 'orphaned' | 'faulted' };
  conversations: string[];
};

export type ConversationTaskGraph = {
  conversationId: string;
  tasks: ConversationTaskNode[];
};

type EventBase<T extends string, P> = {
  type: T;
  conversationId: string;
  revision: number;
  payload: P;
};

export type ConversationEvent =
  | EventBase<'snapshot', {
      run?: { inputs: string[] };
      /** The whole Studio conversation, including owned background tasks. */
      running: boolean;
      generation?: ChatMessage;
      tools: unknown[];
      nestedTools: unknown[];
      compactions: unknown[];
      compactionFailure?: unknown;
      inbox: unknown[];
      agent: Record<string, unknown>;
      usage?: unknown;
    }>
  | EventBase<'run.started' | 'run.completed', { inputs: string[]; running: boolean }>
  | EventBase<'run.failed', {
      taskId: string;
      kind: string;
      message: string;
      running: boolean;
    }>
  | EventBase<'assistant.updated' | 'assistant.completed', { message: ChatMessage }>
  | EventBase<'transcript.appended', { messages: ChatMessage[] }>
  | EventBase<'inbox.updated', { items: unknown[] }>
  | EventBase<'submission.updated', { record: { id: string; status: string; reason?: string; detail?: unknown } }>
  | EventBase<'agent.updated', { agent: Record<string, unknown> }>
  | EventBase<'usage.updated', { usage: unknown }>
  | EventBase<'retry.updated', { active: boolean; attempt: number; at?: number; errorMessage?: string }>
  | EventBase<'compaction.started' | 'compaction.completed', Record<string, unknown>>
  | EventBase<'turn.diff', { diff: TurnDiff }>
  | EventBase<
      'tool.execution.started' | 'tool.execution.updated' | 'tool.execution.completed',
      Record<string, unknown>
    >;
