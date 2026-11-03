import type { ChatMessage } from './chat-types';
import type { RuntimeRefreshSnapshot } from './runtime-types';

/** Pi Durable 支持的 thinking 强度。空字符串表示沿用父智能体。 */
export type SubagentThinking = '' | 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export type SubagentConfig = {
  defaultModel: string;
  defaultProvider: string;
  defaultThinking: SubagentThinking;
  maxThinking: SubagentThinking;
  /** 空数组表示沿用父智能体当前提供给模型的工具。 */
  allowedTools: string[];
  backgroundEnabled: boolean;
  defaultMode: 'foreground' | 'background';
  supervisorEnabled: boolean;
  maxConcurrent: number;
  maxSpawns: number;
  waitTimeoutMs: number;
  /** off shares the parent tree; background isolates background children; always isolates every child. */
  worktreeIsolation: 'off' | 'background' | 'always';
  /** Maximum preserved worktrees in one Git repository before another child is blocked. */
  worktreeLimit: number;
  /** 0 disables the token budget. */
  budgetTokens: number;
  /** 0 disables the reference-cost budget. */
  budgetCostUsd: number;
  budgetAction: 'warn' | 'stop';
};

export type SubagentModelOption = {
  modelRef: string;
  provider: string;
  label: string;
  reasoning: boolean;
  thinkingLevels: Exclude<SubagentThinking, ''>[];
};

export type SubagentSettingsSnapshot = {
  installed: boolean;
  userPath: string;
  projectPath: string;
  projectRoot: string;
  projectRootExists: boolean;
  user: SubagentConfig;
  project: SubagentConfig;
  models: SubagentModelOption[];
  currentModel: string;
  thinkingLevels: Exclude<SubagentThinking, ''>[];
  worktrees: ManagedWorktree[];
  runtimeRefresh?: RuntimeRefreshSnapshot;
};

export type SubagentBudgetSnapshot = {
  parentConversationId: string;
  tokens: number;
  costUsd: number;
  requests: number;
  budgetTokens: number;
  budgetCostUsd: number;
  budgetAction: 'warn' | 'stop';
  exceeded: boolean;
};

export type ManagedWorktree = {
  id: string;
  parentConversationId: string;
  childConversationId: string;
  name: string;
  workspace: string;
  repositoryRoot: string;
  path: string;
  baseCommit: string;
  status: 'active' | 'finished' | 'applied' | 'discarded' | 'removed' | 'failed';
  createdAt: number;
  updatedAt: number;
  finishedAt?: number;
  error: string;
  changed?: boolean;
  changedFiles?: number;
  files?: Array<{
    path: string;
    status: 'added' | 'modified' | 'deleted';
    added: number;
    removed: number;
    binary: boolean;
  }>;
  totalAdded?: number;
  totalRemoved?: number;
  sizeBytes: number;
  fileEntries: number;
  sizeTruncated: boolean;
  directoryExists: boolean;
  inspectionError?: string;
};

export type SubagentStatus = 'pending' | 'running' | 'completed' | 'failed' | 'stopped' | 'paused' | 'waiting';

/** 主会话中的一张子智能体卡片。key 由主进程生成，渲染层只把它当作稳定句柄。 */
export type SubagentChild = {
  key: string;
  runId: string;
  index: number;
  agent: string;
  name?: string;
  task: string;
  status: SubagentStatus;
  source: 'foreground' | 'background';
  context?: 'fresh' | 'fork';
  model: string;
  thinking: string;
  cwd: string;
  isolation: 'workspace' | 'worktree';
  worktreeId?: string;
  startedAt?: number;
  updatedAt?: number;
  durationMs?: number;
  tokens?: number;
  referenceCostUsd?: number;
  providerRequests?: number;
  toolCount?: number;
  turnCount?: number;
  currentTool?: string;
  supervisorPending?: number;
  supervisorRequests?: Array<{ id: string; question: string; createdAt?: number }>;
  lastReporterId?: string;
  preview: string;
  error?: string;
  hasTranscript: boolean;
};

export type SubagentTranscript = {
  child: SubagentChild;
  messages: ChatMessage[];
  totalMessages: number;
  hasMore?: boolean;
  messageStart?: number;
};
