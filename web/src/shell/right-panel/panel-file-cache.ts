/** Workspace paths and session-authorized paths have distinct cache ownership. */
export type PanelFileIdentity = { path: string; source: 'workspace' | 'attachment' | 'diff' | 'external'; cwd?: string; sessionId?: string };
export function panelFileKey(file: PanelFileIdentity): string {
  return JSON.stringify([file.source, file.source === 'workspace' ? file.cwd || '' : file.sessionId || 'draft', file.path]);
}

export const PANEL_FILE_CACHE_MAX_BYTES = 32 * 1024 * 1024;

/**
 * Conservative payload accounting, not a measurement of the JavaScript heap.
 * Count UTF-16 strings (including inline media) without copying/serializing
 * their content. The file's on-disk `size` is just a number, not retained data.
 * Repeated string fields count separately; shared object references count once.
 * Decoded media, DOM/GPU resources and the active preview are outside this LRU.
 */
export function estimatePreviewBytes(value: unknown): number {
  const seen = new Set<object>();
  const pending: unknown[] = [value];
  let bytes = 0;
  while (pending.length) {
    const item = pending.pop();
    if (typeof item === 'string') bytes += 16 + item.length * 2;
    else if (typeof item === 'number' || typeof item === 'boolean') bytes += 8;
    else if (item && typeof item === 'object' && !seen.has(item)) {
      seen.add(item);
      bytes += 64;
      for (const [key, child] of Object.entries(item)) {
        bytes += 16 + key.length * 2;
        pending.push(child);
      }
    }
  }
  return bytes;
}

/** Bounded LRU of immutable, reloadable previews; tab lifetime is independent. */
export function createPanelFileCache<T>(limit = 8, maxEstimatedBytes = PANEL_FILE_CACHE_MAX_BYTES) {
  const itemLimit = Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : 8;
  const byteLimit = Number.isFinite(maxEstimatedBytes) ? Math.max(0, maxEstimatedBytes) : PANEL_FILE_CACHE_MAX_BYTES;
  const values = new Map<string, { value: T; bytes: number }>();
  const requests = new Map<string, symbol>();
  let estimatedBytes = 0;
  const remove = (key: string) => {
    const entry = values.get(key);
    if (!entry) return;
    estimatedBytes -= entry.bytes;
    values.delete(key);
  };
  return {
    get(key: string) {
      const entry = values.get(key);
      if (entry) { values.delete(key); values.set(key, entry); }
      return entry?.value;
    },
    begin(key: string) { const token = Symbol(key); requests.set(key, token); return token; },
    current(key: string, token: symbol) { return requests.get(key) === token; },
    put(key: string, token: symbol, value: T) {
      if (requests.get(key) !== token) return false;
      requests.delete(key);
      remove(key);
      const bytes = estimatePreviewBytes(value) + 64 + key.length * 2;
      // `true` means this read is current, so App may display its full result.
      // An oversized preview remains usable but is not retained after leaving
      // its tab. Do not truncate it or evict unrelated entries to make room.
      if (!itemLimit || bytes > byteLimit) return true;
      values.set(key, { value, bytes });
      estimatedBytes += bytes;
      while (values.size > itemLimit || estimatedBytes > byteLimit) remove(values.keys().next().value!);
      return true;
    },
    finish(key: string, token: symbol) { if (requests.get(key) === token) requests.delete(key); },
    drop(key: string) { requests.delete(key); remove(key); },
    clear() { requests.clear(); values.clear(); estimatedBytes = 0; },
    get size() { return values.size; },
    get pending() { return requests.size; },
    get estimatedBytes() { return estimatedBytes; },
  };
}
