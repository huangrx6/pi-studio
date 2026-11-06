import type { ModelComparisonStartResult } from '../types/comparison-types';
import type { ThinkingLevel } from '../types/model-types';
import type { KeyValueStorage } from './preferences';

const RESERVED_OBJECT_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const THINKING_LEVELS = new Set<ThinkingLevel>([
  'default',
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
]);
const MAX_WORKSPACES = 512;
const MAX_SESSIONS_PER_WORKSPACE = 2_000;
const MAX_MODEL_COMPARISONS = 64;
const MAX_ID_LENGTH = 256;
const MAX_PATH_LENGTH = 4_096;

export const STORED_UI_KEYS = {
  expanded: 'pi-studio:expanded-workspaces',
  workspaceOrder: 'pi-studio:workspace-order',
  sessionOrder: 'pi-studio:session-order',
  activeSession: 'pi-studio:active-session',
  comparisons: 'pi-studio:model-comparisons',
} as const;

export type StoredSessionOrder = Record<string, string[]>;

export type StoredActiveSession = {
  id: string;
  cwd: string;
} | null;

export type StoredModelComparison = {
  result: ModelComparisonStartResult;
  cwd: string;
  initialModelRef: string;
  initialThinkingLevel: ThinkingLevel;
};

export type StoredModelComparisonMap = Record<string, StoredModelComparison>;

function browserStorage(): KeyValueStorage | null {
  try {
    return typeof globalThis.localStorage === 'undefined'
      ? null
      : globalThis.localStorage;
  } catch {
    return null;
  }
}

function safeId(value: unknown): string {
  if (typeof value !== 'string') return '';
  const id = value.trim();
  return id && id.length <= MAX_ID_LENGTH && !RESERVED_OBJECT_KEYS.has(id)
    ? id
    : '';
}

function safeWorkspacePath(value: unknown): string {
  if (typeof value !== 'string') return '';
  const workspace = value.trim();
  const looksAbsolute = workspace.startsWith('/')
    || /^[A-Za-z]:[\\/]/.test(workspace)
    || workspace.startsWith('\\\\');
  return workspace
    && workspace.length <= MAX_PATH_LENGTH
    && !RESERVED_OBJECT_KEYS.has(workspace)
    && looksAbsolute
    ? workspace
    : '';
}

function uniqueStrings(
  value: unknown,
  limit: number,
  normalize: (candidate: unknown) => string,
): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const output: string[] = [];
  for (const candidate of value) {
    if (output.length >= limit) break;
    const normalized = normalize(candidate);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    output.push(normalized);
  }
  return output;
}

export function normalizeExpandedWorkspaces(value: unknown): string[] {
  return uniqueStrings(value, MAX_WORKSPACES, safeWorkspacePath);
}

export function normalizeWorkspaceOrder(value: unknown): string[] {
  return uniqueStrings(value, MAX_WORKSPACES, safeWorkspacePath);
}

export function normalizeStoredSessionOrder(value: unknown): StoredSessionOrder {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const output: StoredSessionOrder = {};
  for (const [rawWorkspace, rawOrder] of Object.entries(value)) {
    if (Object.keys(output).length >= MAX_WORKSPACES) break;
    const workspace = safeWorkspacePath(rawWorkspace);
    if (!workspace || !Array.isArray(rawOrder)) continue;
    output[workspace] = uniqueStrings(rawOrder, MAX_SESSIONS_PER_WORKSPACE, safeId);
  }
  return output;
}

export function normalizeStoredActiveSession(value: unknown): StoredActiveSession {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const candidate = value as { id?: unknown; cwd?: unknown };
  const id = safeId(candidate.id);
  const cwd = safeWorkspacePath(candidate.cwd);
  return id && cwd ? { id, cwd } : null;
}

function validComparisonBranch(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const branch = value as Record<string, unknown>;
  return Boolean(
    safeId(branch.sessionId)
    && typeof branch.label === 'string'
    && typeof branch.modelRef === 'string'
    && branch.modelRef.trim()
    && THINKING_LEVELS.has(branch.thinkingLevel as ThinkingLevel)
    && typeof branch.worktreeId === 'string'
    && branch.worktreeId.trim(),
  );
}

function normalizeComparisonEntry(
  parentId: string,
  value: unknown,
): StoredModelComparison | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const entry = value as Partial<StoredModelComparison>;
  const result = entry.result;
  if (
    !result
    || typeof result !== 'object'
    || Array.isArray(result)
    || safeId(result.id) !== result.id
    || result.parentId !== parentId
    || typeof result.prompt !== 'string'
    || !result.prompt.trim()
    || !Number.isFinite(result.createdAt)
    || result.createdAt <= 0
    || !Array.isArray(result.branches)
    || result.branches.length !== 2
    || !result.branches.every(validComparisonBranch)
  ) return undefined;
  const cwd = safeWorkspacePath(entry.cwd);
  const initialModelRef = typeof entry.initialModelRef === 'string'
    ? entry.initialModelRef.trim()
    : '';
  if (
    !cwd
    || !initialModelRef
    || !THINKING_LEVELS.has(entry.initialThinkingLevel as ThinkingLevel)
  ) return undefined;

  const branches = result.branches.map((branch) => ({
    sessionId: branch.sessionId,
    label: branch.label,
    modelRef: branch.modelRef,
    thinkingLevel: branch.thinkingLevel,
    worktreeId: branch.worktreeId,
  })) as [
    ModelComparisonStartResult['branches'][0],
    ModelComparisonStartResult['branches'][1],
  ];
  return {
    result: {
      id: result.id,
      parentId,
      prompt: result.prompt,
      createdAt: result.createdAt,
      branches,
    },
    cwd,
    initialModelRef,
    initialThinkingLevel: entry.initialThinkingLevel as ThinkingLevel,
  };
}

export function normalizeStoredModelComparisons(value: unknown): StoredModelComparisonMap {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const output: StoredModelComparisonMap = {};
  for (const [rawParentId, candidate] of Object.entries(value)) {
    if (Object.keys(output).length >= MAX_MODEL_COMPARISONS) break;
    const parentId = safeId(rawParentId);
    if (!parentId) continue;
    const normalized = normalizeComparisonEntry(parentId, candidate);
    if (normalized) output[parentId] = normalized;
  }
  return output;
}

function readNormalized<T>(
  storage: KeyValueStorage | null,
  key: string,
  fallback: () => T,
  normalize: (value: unknown) => T,
): T {
  if (!storage) return fallback();
  let raw: string | null;
  try {
    raw = storage.getItem(key);
  } catch {
    return fallback();
  }
  if (raw === null) return fallback();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = undefined;
  }
  const normalized = normalize(parsed);
  const canonical = JSON.stringify(normalized);
  if (canonical !== raw) {
    try { storage.setItem(key, canonical); } catch {
      // The validated value remains usable when repair storage is unavailable.
    }
  }
  return normalized;
}

export function loadStoredExpandedWorkspaces(
  storage: KeyValueStorage | null = browserStorage(),
): string[] {
  return readNormalized(
    storage,
    STORED_UI_KEYS.expanded,
    () => [],
    normalizeExpandedWorkspaces,
  );
}

export function loadStoredWorkspaceOrder(
  storage: KeyValueStorage | null = browserStorage(),
): string[] {
  return readNormalized(
    storage,
    STORED_UI_KEYS.workspaceOrder,
    () => [],
    normalizeWorkspaceOrder,
  );
}

export function loadStoredSessionOrder(
  storage: KeyValueStorage | null = browserStorage(),
): StoredSessionOrder {
  return readNormalized(
    storage,
    STORED_UI_KEYS.sessionOrder,
    () => ({}),
    normalizeStoredSessionOrder,
  );
}

export function loadStoredActiveSession(
  storage: KeyValueStorage | null = browserStorage(),
): StoredActiveSession {
  return readNormalized(
    storage,
    STORED_UI_KEYS.activeSession,
    () => null,
    normalizeStoredActiveSession,
  );
}

export function loadStoredModelComparisons(
  storage: KeyValueStorage | null = browserStorage(),
): StoredModelComparisonMap {
  return readNormalized(
    storage,
    STORED_UI_KEYS.comparisons,
    () => ({}),
    normalizeStoredModelComparisons,
  );
}
