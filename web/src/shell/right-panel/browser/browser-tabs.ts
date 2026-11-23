/**
 * Pure helpers for guest tabs inside the workbench browser panel.
 */

export type BrowserGuestTab = {
  id: string;
  url: string;
  title: string;
  address: string;
  loading: boolean;
  failed: string;
};

export function createBrowserGuestTab(input: {
  id?: string;
  url?: string;
  title?: string;
  createId?: () => string;
} = {}): BrowserGuestTab {
  const createId = input.createId || (() => `guest:${Math.random().toString(36).slice(2, 10)}`);
  const url = String(input.url || '').trim() || 'about:blank';
  return {
    id: input.id || createId(),
    url,
    title: input.title || (url === 'about:blank' ? '新标签页' : url),
    address: url === 'about:blank' ? '' : url,
    loading: false,
    failed: '',
  };
}

export function upsertBrowserGuestTab(
  tabs: BrowserGuestTab[],
  input: { url?: string; title?: string; createId?: () => string },
): { tabs: BrowserGuestTab[]; activeId: string } {
  const url = String(input.url || '').trim();
  if (url) {
    const existing = tabs.find((tab) => tab.url === url);
    if (existing) return { tabs, activeId: existing.id };
  }
  const tab = createBrowserGuestTab(input);
  return { tabs: [...tabs, tab], activeId: tab.id };
}

export function closeBrowserGuestTab(
  tabs: BrowserGuestTab[],
  activeId: string,
  closeId: string,
  createId?: () => string,
): { tabs: BrowserGuestTab[]; activeId: string } {
  if (tabs.length <= 1) {
    const blank = createBrowserGuestTab({ createId });
    return { tabs: [blank], activeId: blank.id };
  }
  const index = tabs.findIndex((tab) => tab.id === closeId);
  if (index < 0) return { tabs, activeId };
  const next = tabs.filter((tab) => tab.id !== closeId);
  if (activeId !== closeId) return { tabs: next, activeId };
  const fallback = next[Math.max(0, index - 1)] || next[0];
  return { tabs: next, activeId: fallback.id };
}

export function patchBrowserGuestTab(
  tabs: BrowserGuestTab[],
  id: string,
  patch: Partial<BrowserGuestTab>,
): BrowserGuestTab[] {
  return tabs.map((tab) => (tab.id === id ? { ...tab, ...patch } : tab));
}

export function browserTabLabel(tab: Pick<BrowserGuestTab, 'title' | 'url' | 'address'>): string {
  const title = String(tab.title || '').trim();
  if (title && title !== 'about:blank') return title;
  const url = String(tab.url || tab.address || '').trim();
  if (!url || url === 'about:blank') return '新标签页';
  try {
    const parsed = new URL(url);
    return parsed.hostname || url;
  } catch {
    return url;
  }
}
