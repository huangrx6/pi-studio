export type BrowserGuestTab = {
  id: string;
  url: string;
  title: string;
  address: string;
  loading: boolean;
  failed: string;
  devToolsOpen: boolean;
};

export function createBrowserGuestTab(input: {
  id: string;
  url?: string;
  title?: string;
}): BrowserGuestTab {
  const url = String(input.url || '').trim() || 'about:blank';
  return {
    id: input.id,
    url,
    title: input.title || (url === 'about:blank' ? '新标签页' : url),
    address: url === 'about:blank' ? '' : url,
    loading: false,
    failed: '',
    devToolsOpen: false,
  };
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
