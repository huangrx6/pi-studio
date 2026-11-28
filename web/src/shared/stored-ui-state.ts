import type { KeyValueStorage } from './preferences';

const RESERVED_OBJECT_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const MAX_WORKSPACES = 512;
const MAX_SESSIONS_PER_WORKSPACE = 2_000;
const MAX_ID_LENGTH = 256;
const MAX_PATH_LENGTH = 4_096;

export const STORED_UI_KEYS = {
  workspaceOrder: 'pi-studio:workspace-order',
  sessionOrder: 'pi-studio:session-order',
} as const;

export type StoredSessionOrder = Record<string, string[]>;

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
