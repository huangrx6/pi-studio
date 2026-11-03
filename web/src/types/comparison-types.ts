import type { ThinkingLevel } from './model-types';

export type ModelComparisonBranchInput = {
  label: string;
  modelRef: string;
  thinkingLevel: ThinkingLevel;
};

export type ModelComparisonInput = {
  parentId: string;
  prompt: string;
  mentions?: string[];
  attachments?: string[];
  images?: Array<{ type: 'image'; data: string; mimeType: string }>;
  branches: [ModelComparisonBranchInput, ModelComparisonBranchInput];
};

export type ModelComparisonBranchIdentity = {
  sessionId: string;
  label: string;
  modelRef: string;
  thinkingLevel: ThinkingLevel;
  worktreeId: string;
};

export type ModelComparisonStartResult = {
  id: string;
  parentId: string;
  prompt: string;
  createdAt: number;
  branches: [ModelComparisonBranchIdentity, ModelComparisonBranchIdentity];
};

export type ModelComparisonSnapshotInput = {
  branches: Array<Pick<ModelComparisonBranchIdentity, 'sessionId' | 'label' | 'modelRef' | 'worktreeId'>>;
};

export type ModelComparisonAdoptInput = {
  sessionId: string;
  worktreeId: string;
};

export type ModelComparisonAdoptResult = {
  ok: boolean;
  sessionId: string;
  changedFiles: number;
};

export type ModelComparisonDiscardInput = {
  sessionId: string;
  worktreeId: string;
};

export type ModelComparisonDiscardResult = {
  ok: boolean;
  sessionId: string;
};

export type ModelComparisonAnswer = {
  text: string;
  streaming: boolean;
  error?: string;
  stopReason?: string;
  model?: string;
  provider?: string;
  thinkingLevel?: string;
};

export type ModelComparisonBranchStatus = {
  sessionId: string;
  label: string;
  modelRef: string;
  worktreeId: string;
  status: 'running' | 'completed' | 'failed' | 'unanswered' | 'missing' | 'discarded';
  title: string;
  cwd: string;
  running: boolean;
  compacting: boolean;
  answer?: ModelComparisonAnswer;
  worktree?: {
    id: string;
    status: 'active' | 'finished' | 'applied' | 'discarded' | 'failed' | 'removed';
    changedFiles: number;
    files: Array<{
      path: string;
      status: 'added' | 'modified' | 'deleted';
      added: number;
      removed: number;
      binary: boolean;
    }>;
    sizeBytes: number;
    error: string;
    directoryExists: boolean;
  };
  metrics: {
    requests: number;
    tokens: number;
    costUsd: number;
    tps?: number;
    ttftMs?: number;
    durationMs?: number;
  };
};

export type ModelComparisonSnapshot = [
  ModelComparisonBranchStatus,
  ModelComparisonBranchStatus,
];
