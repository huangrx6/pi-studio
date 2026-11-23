/**
 * Recent navigation history for the in-app browser shell.
 * Stored in renderer localStorage; never crosses into Durable.
 */

export type BrowserHistoryEntry = {
  url: string;
  title: string;
  visitedAt: number;
};

const STORAGE_KEY = 'pi.studio.browser.history.v1';
const MAX_ENTRIES = 50;

function storage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

export function loadBrowserHistory(store: Storage | null = storage()): BrowserHistoryEntry[] {
  if (!store) return [];
  try {
    const raw = store.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((entry) => entry && typeof entry.url === 'string' && entry.url)
      .map((entry) => ({
        url: String(entry.url),
        title: typeof entry.title === 'string' ? entry.title : '',
        visitedAt: Number(entry.visitedAt) || 0,
      }))
      .slice(0, MAX_ENTRIES);
  } catch {
    return [];
  }
}

export function saveBrowserHistory(
  entries: BrowserHistoryEntry[],
  store: Storage | null = storage(),
): BrowserHistoryEntry[] {
  const next = entries.slice(0, MAX_ENTRIES);
  if (!store) return next;
  try {
    store.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Quota or private mode: keep the in-memory list only.
  }
  return next;
}

export function recordBrowserHistoryVisit(
  entries: BrowserHistoryEntry[],
  visit: { url: string; title?: string; visitedAt?: number },
): BrowserHistoryEntry[] {
  const url = String(visit.url || '').trim();
  if (!url || url === 'about:blank' || url.startsWith('devtools:')) return entries;
  const visitedAt = visit.visitedAt ?? Date.now();
  const title = String(visit.title || '').trim();
  const without = entries.filter((entry) => entry.url !== url);
  return [
    { url, title: title || without.find((entry) => entry.url === url)?.title || url, visitedAt },
    ...without,
  ].slice(0, MAX_ENTRIES);
}

export function clearBrowserHistory(store: Storage | null = storage()): BrowserHistoryEntry[] {
  if (store) {
    try {
      store.removeItem(STORAGE_KEY);
    } catch {
      // Ignore storage failures while clearing.
    }
  }
  return [];
}
