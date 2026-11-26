/**
 * In-app browser panel (Phase 1 shell).
 *
 * Guest pages stay in isolated webviews on `persist:pi-browser`. This panel
 * owns multi-tab browsing, recent history, download list and profile clearing.
 * Agent can read and act via main-process tools; users can pause takeover here.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  Clock3,
  Download,
  ExternalLink,
  Globe,
  Hand,
  Monitor,
  MoreHorizontal,
  Play,
  Plus,
  RotateCw,
  Shield,
  Square,
  Trash2,
  Unplug,
  X,
} from 'lucide-react';
import { useActionConfirmation } from '../../shared/ConfirmDialog';
import { errorText } from '../../shared/error-text';
import { normalizeBrowserTarget } from './browser-target.ts';
import {
  clearBrowserHistory,
  clearBrowserProfile,
  BROWSER_CLEAR_DESCRIPTION,
  BROWSER_HISTORY_CLEARED,
  loadBrowserHistory,
  recordBrowserHistoryVisit,
  saveBrowserHistory,
  type BrowserHistoryEntry,
  type BrowserLibraryView,
} from '../../features/browser/browser-history.ts';
import {
  browserTabLabel,
  closeBrowserGuestTab,
  createBrowserGuestTab,
  patchBrowserGuestTab,
  upsertBrowserGuestTab,
  type BrowserGuestTab,
} from './browser/browser-tabs.ts';

type WebviewElement = HTMLElement & {
  loadURL(url: string): Promise<void>;
  reload(): void;
  goBack(): void;
  goForward(): void;
  canGoBack(): boolean;
  canGoForward(): boolean;
  getURL(): string;
  getTitle(): string;
  getWebContentsId?: () => number;
  addEventListener(type: string, listener: (event: unknown) => void): void;
  removeEventListener(type: string, listener: (event: unknown) => void): void;
};

type BrowserViewportOverride = {
  width: number;
  height: number;
  label?: string;
};

type BrowserAgentActivity = {
  active: boolean;
  tabId?: string;
  action?: string;
  label?: string;
};

type BrowserCommand = {
  type: string;
  requestId?: string;
  url?: string;
  tabId?: string;
  newTab?: boolean;
  viewport?: BrowserViewportOverride | null;
};

const VIEWPORT_PRESETS: Array<{ id: string; label: string; viewport: BrowserViewportOverride | null }> = [
  { id: 'reset', label: '自适应面板', viewport: null },
  { id: 'desktop', label: '桌面 1440×900', viewport: { width: 1440, height: 900, label: '桌面 1440×900' } },
  { id: 'laptop', label: '笔记本 1280×800', viewport: { width: 1280, height: 800, label: '笔记本 1280×800' } },
  { id: 'tablet', label: '平板 768×1024', viewport: { width: 768, height: 1024, label: '平板 768×1024' } },
  { id: 'mobile', label: '手机 390×844', viewport: { width: 390, height: 844, label: '手机 390×844' } },
];

type BrowserDownload = {
  id: string;
  url: string;
  filename: string;
  path: string;
  state: string;
  receivedBytes: number;
  totalBytes: number;
  mimeType: string;
  risky: boolean;
  error: string;
  startedAt: number;
  endedAt: number | null;
};

const Webview = 'webview' as unknown as React.FC<Record<string, unknown>>;

function createId() {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? `guest:${crypto.randomUUID()}`
    : `guest:${Date.now().toString(36)}`;
}

function formatBytes(value: number) {
  if (!Number.isFinite(value) || value <= 0) return '';
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

function downloadLabel(item: BrowserDownload) {
  if (item.state === 'completed') return '已完成';
  if (item.state === 'cancelled') return '已取消';
  if (item.state === 'failed' || item.state === 'interrupted') return item.error || '失败';
  if (item.totalBytes > 0) return `${formatBytes(item.receivedBytes)} / ${formatBytes(item.totalBytes)}`;
  return formatBytes(item.receivedBytes) || '下载中';
}

function GuestFrame({
  tab,
  active,
  onReady,
  onPatch,
  onHistory,
  registerView,
}: {
  tab: BrowserGuestTab;
  active: boolean;
  onReady: (id: string, webContentsId: number | null) => void;
  onPatch: (id: string, patch: Partial<BrowserGuestTab>) => void;
  onHistory: (url: string, title: string) => void;
  registerView: (id: string, node: WebviewElement | null) => void;
}) {
  const viewRef = useRef<WebviewElement | null>(null);
  // React must not reassign src after guest navigations/redirects.
  const initialSrc = useRef(tab.url || 'about:blank');

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return () => {};
    registerView(tab.id, view);
    const handleReady = () => {
      let webContentsId: number | null = null;
      try {
        const id = view.getWebContentsId?.();
        if (typeof id === 'number' && Number.isSafeInteger(id) && id > 0) webContentsId = id;
      } catch {
        webContentsId = null;
      }
      onReady(tab.id, webContentsId);
    };
    const handleNavigate = (event: unknown) => {
      const detail = event as { url?: string; isMainFrame?: boolean };
      if (detail.isMainFrame === false) return;
      const next = detail.url;
      if (typeof next !== 'string' || !next) return;
      let title = '';
      try {
        title = view.getTitle() || '';
      } catch {
        title = '';
      }
      onPatch(tab.id, {
        url: next,
        address: next === 'about:blank' ? '' : next,
        title: title || (next === 'about:blank' ? '新标签页' : next),
        failed: '',
      });
      if (next !== 'about:blank') onHistory(next, title || next);
    };
    const handleStart = () => onPatch(tab.id, { loading: true, failed: '' });
    const handleStop = () => {
      onPatch(tab.id, { loading: false });
      try {
        const title = view.getTitle() || '';
        const currentUrl = view.getURL() || '';
        if (title) onPatch(tab.id, { title });
        if (currentUrl && currentUrl !== 'about:blank') onHistory(currentUrl, title || currentUrl);
      } catch {
        // Guest may already be gone.
      }
    };
    const handleFail = (event: unknown) => {
      const detail = event as { errorDescription?: string; errorCode?: number; isMainFrame?: boolean };
      if (detail.isMainFrame === false || detail.errorCode === -3) return;
      onPatch(tab.id, { failed: detail.errorDescription || '页面加载失败', loading: false });
    };
    const handleTitle = (event: unknown) => {
      const detail = event as { title?: string };
      if (typeof detail.title === 'string' && detail.title) onPatch(tab.id, { title: detail.title });
    };
    view.addEventListener('dom-ready', handleReady);
    view.addEventListener('did-navigate', handleNavigate);
    view.addEventListener('did-navigate-in-page', handleNavigate);
    view.addEventListener('did-start-loading', handleStart);
    view.addEventListener('did-stop-loading', handleStop);
    view.addEventListener('did-fail-load', handleFail);
    view.addEventListener('page-title-updated', handleTitle);
    return () => {
      view.removeEventListener('dom-ready', handleReady);
      view.removeEventListener('did-navigate', handleNavigate);
      view.removeEventListener('did-navigate-in-page', handleNavigate);
      view.removeEventListener('did-start-loading', handleStart);
      view.removeEventListener('did-stop-loading', handleStop);
      view.removeEventListener('did-fail-load', handleFail);
      view.removeEventListener('page-title-updated', handleTitle);
      registerView(tab.id, null);
    };
  }, [tab.id, onReady, onPatch, onHistory, registerView]);

  return <Webview
    ref={viewRef}
    src={initialSrc.current}
    partition="persist:pi-browser"
    webpreferences="contextIsolation=yes,sandbox=yes,nodeIntegration=no,plugins=no"
    allowpopups="false"
    className={`browser-frame ${active ? 'is-active' : ''}`}
    style={{ display: active ? 'flex' : 'none' }}
  />;
}

export function BrowserPanel({
  url,
  openNonce = 0,
  commandRequestId = '',
  libraryRequest,
  onLibraryOpened,
  onUrlChange,
  onTitleChange,
  onClose,
  onCommandHandled,
}: {
  url: string;
  openNonce?: number;
  /** Agent open command waiting for guest registration + ack. */
  commandRequestId?: string;
  libraryRequest?: { id: string; view: BrowserLibraryView };
  onLibraryOpened?: (id: string) => void;
  onUrlChange?: (url: string) => void;
  onTitleChange?: (title: string) => void;
  onClose?: () => void;
  onCommandHandled?: (requestId: string) => void;
}) {
  const initial = useMemo(
    () => createBrowserGuestTab({ url: url || 'about:blank', createId }),
    // Mount-only seed; later URLs arrive via openNonce.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );
  const [tabs, setTabs] = useState<BrowserGuestTab[]>([initial]);
  const [activeId, setActiveId] = useState(initial.id);
  const [nav, setNav] = useState({ back: false, forward: false });
  const [menu, setMenu] = useState<'history' | 'downloads' | 'more' | null>(null);
  const [history, setHistory] = useState<BrowserHistoryEntry[]>(() => loadBrowserHistory());
  const historyButtonRef = useRef<HTMLButtonElement>(null);
  const downloadsButtonRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const reset = () => setHistory([]);
    window.addEventListener(BROWSER_HISTORY_CLEARED, reset);
    return () => window.removeEventListener(BROWSER_HISTORY_CLEARED, reset);
  }, []);
  useEffect(() => {
    if (!libraryRequest) return;
    setMenu(libraryRequest.view);
    (libraryRequest.view === 'history' ? historyButtonRef : downloadsButtonRef).current?.focus({ preventScroll: true });
    onLibraryOpened?.(libraryRequest.id);
  }, [libraryRequest, onLibraryOpened]);
  const [showFullUrl, setShowFullUrl] = useState(false);
  const [addressFocused, setAddressFocused] = useState(false);
  type ExternalSession = { sessionId: string; targetId: string; title: string; url: string; attachedAt?: number };
  const [externalSessions, setExternalSessions] = useState<ExternalSession[]>([]);
  useEffect(() => {
    let cancelled = false;
    void window.piApi.browserAdvancedSettings?.().then((result) => {
      if (!cancelled) setShowFullUrl(Boolean(result?.showFullUrl));
    }).catch(() => {});
    void window.piApi.browserExternalSessions?.().then((result) => {
      if (!cancelled && Array.isArray(result?.sessions)) {
        setExternalSessions(result.sessions as ExternalSession[]);
      }
    }).catch(() => {});
    const off = window.piApi.onBrowserEvent?.((event) => {
      const payload = event as {
        type?: string;
        preferences?: { showFullUrl?: boolean; evaluateEnabled?: boolean };
        sessions?: ExternalSession[];
      };
      if (payload?.type === 'preferences' && payload.preferences) {
        setShowFullUrl(Boolean(payload.preferences.showFullUrl));
      }
      if (payload?.type === 'external' && Array.isArray(payload.sessions)) {
        setExternalSessions(payload.sessions);
      }
    });
    return () => {
      cancelled = true;
      off?.();
    };
  }, []);

  const [downloads, setDownloads] = useState<BrowserDownload[]>([]);
  const [actionError, setActionError] = useState('');
  const [clearing, setClearing] = useState(false);
  const confirmation = useActionConfirmation();
  const [agentPaused, setAgentPaused] = useState(false);
  const [agentActivity, setAgentActivity] = useState<BrowserAgentActivity>({ active: false });
  const [viewportOverride, setViewportOverride] = useState<BrowserViewportOverride | null>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const [stageSize, setStageSize] = useState({ width: 0, height: 0 });
  const [evaluateEnabled, setEvaluateEnabled] = useState(false);
  const [sitePolicies, setSitePolicies] = useState<Array<{
    id: string;
    originPattern: string;
    actionClass: string;
    decision: string;
  }>>([]);
  const viewsRef = useRef(new Map<string, WebviewElement>());
  const readyRef = useRef(new Set<string>());
  const contentsIdRef = useRef(new Map<string, number>());
  const pendingAckRef = useRef<string>('');
  const openNonceRef = useRef(openNonce);
  const activeIdRef = useRef(activeId);
  const tabsRef = useRef(tabs);
  const onUrlChangeRef = useRef(onUrlChange);
  const onTitleChangeRef = useRef(onTitleChange);
  const onCommandHandledRef = useRef(onCommandHandled);
  onUrlChangeRef.current = onUrlChange;
  onTitleChangeRef.current = onTitleChange;
  onCommandHandledRef.current = onCommandHandled;
  activeIdRef.current = activeId;
  tabsRef.current = tabs;

  if (commandRequestId && pendingAckRef.current !== commandRequestId) {
    pendingAckRef.current = commandRequestId;
  }

  const active = tabs.find((tab) => tab.id === activeId) || tabs[0];

  const syncNav = useCallback((id = activeIdRef.current) => {
    const view = viewsRef.current.get(id);
    if (!view) {
      setNav({ back: false, forward: false });
      return;
    }
    try {
      setNav({ back: view.canGoBack(), forward: view.canGoForward() });
    } catch {
      setNav({ back: false, forward: false });
    }
  }, []);

  const rememberHistory = useCallback((nextUrl: string, title: string) => {
    setHistory((current) => saveBrowserHistory(recordBrowserHistoryVisit(current, { url: nextUrl, title })));
  }, []);

  const updateTab = useCallback((id: string, patch: Partial<BrowserGuestTab>) => {
    setTabs((current) => patchBrowserGuestTab(current, id, patch));
  }, []);

  const publishGuest = useCallback(async (id: string, webContentsId: number | null, active = false) => {
    if (!webContentsId) return;
    const tab = tabsRef.current.find((item) => item.id === id);
    try {
      await window.piApi.browserTabRegister({
        id,
        webContentsId,
        url: tab?.url || 'about:blank',
        title: tab?.title || '',
        loading: Boolean(tab?.loading),
        active: active || id === activeIdRef.current,
      });
      const requestId = pendingAckRef.current;
      if (requestId && (active || id === activeIdRef.current)) {
        await window.piApi.browserCommandAck({
          requestId,
          tabId: id,
          tab: {
            id,
            webContentsId,
            url: tab?.url || 'about:blank',
            title: tab?.title || '',
            loading: Boolean(tab?.loading),
          },
        });
        pendingAckRef.current = '';
        onCommandHandledRef.current?.(requestId);
      }
    } catch {
      // Main may be restarting; guest remains usable locally.
    }
  }, []);

  const markReady = useCallback((id: string, webContentsId: number | null) => {
    readyRef.current.add(id);
    if (webContentsId) contentsIdRef.current.set(id, webContentsId);
    if (id === activeIdRef.current) syncNav(id);
    void publishGuest(id, webContentsId, id === activeIdRef.current);
  }, [publishGuest, syncNav]);

  const registerView = useCallback((id: string, node: WebviewElement | null) => {
    if (!node) {
      viewsRef.current.delete(id);
      readyRef.current.delete(id);
      return;
    }
    viewsRef.current.set(id, node);
  }, []);

  const navigate = useCallback((id: string, target: string) => {
    const view = viewsRef.current.get(id);
    if (!view) return;
    const normalized = normalizeBrowserTarget(target) || target;
    if (!/^(https?:\/\/|file:\/\/|about:blank$)/i.test(normalized)) {
      updateTab(id, { failed: '只支持 http(s) 链接或本地 HTML 文件' });
      return;
    }
    updateTab(id, { failed: '', loading: true, address: normalized === 'about:blank' ? '' : normalized });
    if (!readyRef.current.has(id)) {
      view.setAttribute('src', normalized);
      return;
    }
    try {
      void view.loadURL(normalized).catch(() => {});
    } catch {
      view.setAttribute('src', normalized);
    }
  }, [updateTab]);

  useEffect(() => {
    if (openNonceRef.current === openNonce) return;
    openNonceRef.current = openNonce;
    setMenu(null);
    setActionError('');
    const target = url ? (normalizeBrowserTarget(url) || url) : '';
    setTabs((current) => {
      const existing = target ? current.find((tab) => tab.url === target) : null;
      if (existing) {
        setActiveId(existing.id);
        return current;
      }
      // New guest webviews read their initial URL from the tab model once.
      const next = upsertBrowserGuestTab(current, { url: target, createId });
      setActiveId(next.activeId);
      return next.tabs;
    });
  }, [openNonce, url]);

  useEffect(() => {
    const tab = tabs.find((item) => item.id === activeId);
    if (!tab) return;
    onUrlChangeRef.current?.(tab.url === 'about:blank' ? '' : tab.url);
    onTitleChangeRef.current?.(browserTabLabel(tab));
    syncNav(tab.id);
    void window.piApi.browserTabActivate(tab.id).catch(() => {});
    const webContentsId = contentsIdRef.current.get(tab.id) || null;
    if (webContentsId) {
      void window.piApi.browserTabUpdate({
        id: tab.id,
        url: tab.url,
        title: tab.title,
        loading: tab.loading,
        active: true,
      }).catch(() => {});
    }
  }, [activeId, tabs, syncNav]);

  // Keep main-process tab projection in sync for Agent tools.
  useEffect(() => {
    for (const tab of tabs) {
      const webContentsId = contentsIdRef.current.get(tab.id);
      if (!webContentsId) continue;
      void window.piApi.browserTabUpdate({
        id: tab.id,
        url: tab.url,
        title: tab.title,
        loading: tab.loading,
        active: tab.id === activeId,
      }).catch(() => {});
    }
  }, [tabs, activeId]);

  useEffect(() => {
    const node = stageRef.current;
    if (!node || typeof ResizeObserver === 'undefined') return;
    let raf = 0;
    const measure = () => {
      raf = 0;
      const rect = node.getBoundingClientRect();
      setStageSize((current) => (
        Math.abs(current.width - rect.width) < 1 && Math.abs(current.height - rect.height) < 1
          ? current
          : { width: rect.width, height: rect.height }
      ));
    };
    measure();
    const observer = new ResizeObserver(() => {
      if (!raf) raf = requestAnimationFrame(measure);
    });
    observer.observe(node);
    return () => {
      if (raf) cancelAnimationFrame(raf);
      observer.disconnect();
    };
  }, []);

  useEffect(() => {
    const stop = window.piApi.onBrowserCommand((command: BrowserCommand) => {
      if ((command.type === 'focus' || command.type === 'reveal') && command.tabId) {
        if (tabsRef.current.some((tab) => tab.id === command.tabId)) {
          setActiveId(command.tabId);
        }
        return;
      }
      if (command.type === 'close-tab' && command.tabId) {
        const targetId = command.tabId;
        void window.piApi.browserTabUnregister(targetId).catch(() => {});
        contentsIdRef.current.delete(targetId);
        readyRef.current.delete(targetId);
        setTabs((current) => {
          const next = closeBrowserGuestTab(current, activeIdRef.current, targetId, createId);
          setActiveId(next.activeId);
          return next.tabs;
        });
        return;
      }
      if (command.type === 'viewport') {
        setViewportOverride(command.viewport ?? null);
      }
      // open commands are handled by the workbench (openNonce + commandRequestId).
    });
    return () => stop();
  }, []);

  useEffect(() => () => {
    for (const id of [...readyRef.current]) {
      void window.piApi.browserTabUnregister(id).catch(() => {});
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    void window.piApi.browserDownloads().then((result) => {
      if (!cancelled) setDownloads(result.downloads || []);
    }).catch(() => {});
    void window.piApi.browserAdvancedSettings?.().then((state) => {
      if (!cancelled) setEvaluateEnabled(Boolean(state?.evaluateEnabled));
    }).catch(() => {});
    void window.piApi.browserControlState?.().then((state) => {
      if (!cancelled && state) {
        setAgentPaused(Boolean(state.paused));
        if (state.activity) {
          setAgentActivity({
            active: Boolean(state.activity.active),
            tabId: state.activity.tabId,
            action: state.activity.action,
            label: state.activity.label,
          });
        }
      }
    }).catch(() => {});
    void window.piApi.browserSitePolicies?.().then((result) => {
      if (!cancelled && Array.isArray(result?.policies)) setSitePolicies(result.policies as typeof sitePolicies);
    }).catch(() => {});
    const stop = window.piApi.onBrowserEvent((event) => {
      if (event?.type === 'activity') {
        setAgentActivity({
          active: Boolean(event.active),
          tabId: event.tabId,
          action: event.action,
          label: event.label,
        });
        return;
      }
      if (event?.type === 'control') {
        setAgentPaused(Boolean((event as { paused?: boolean }).paused));
        if (event.activity) {
          setAgentActivity({
            active: Boolean(event.activity.active),
            tabId: event.activity.tabId,
            action: event.activity.action,
            label: event.activity.label,
          });
        }
        return;
      }
      if (event?.type === 'preferences') {
        const prefs = (event as { preferences?: { showFullUrl?: boolean; evaluateEnabled?: boolean } }).preferences;
        if (prefs) {
          if (typeof prefs.showFullUrl === 'boolean') setShowFullUrl(prefs.showFullUrl);
          if (typeof prefs.evaluateEnabled === 'boolean') setEvaluateEnabled(prefs.evaluateEnabled);
        }
        return;
      }
      if (event?.type === 'external') {
        const sessions = (event as { sessions?: ExternalSession[] }).sessions;
        if (Array.isArray(sessions)) setExternalSessions(sessions);
        return;
      }
      if (event?.type !== 'download' || !event.download) return;
      const download = event.download as BrowserDownload;
      setDownloads((current) => {
        const without = current.filter((item) => item.id !== download.id);
        return [download, ...without];
      });
    });
    return () => {
      cancelled = true;
      stop();
    };
  }, []);

  useEffect(() => {
    if (!menu) return () => {};
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMenu(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [menu]);

  function submitAddress() {
    if (!active) return;
    const target = normalizeBrowserTarget(active.address);
    if (!target) {
      updateTab(active.id, { failed: '请输入网址，或本地 HTML 文件（file:///.../*.html）' });
      return;
    }
    navigate(active.id, target);
  }

  function openGuestTab(nextUrl = '') {
    setMenu(null);
    const target = nextUrl ? (normalizeBrowserTarget(nextUrl) || nextUrl) : '';
    setTabs((current) => {
      if (target) {
        const existing = current.find((tab) => tab.url === target);
        if (existing) {
          setActiveId(existing.id);
          return current;
        }
      }
      const next = upsertBrowserGuestTab(current, { url: target, createId });
      setActiveId(next.activeId);
      return next.tabs;
    });
  }

  function closeGuest(id: string) {
    void window.piApi.browserTabUnregister(id).catch(() => {});
    contentsIdRef.current.delete(id);
    readyRef.current.delete(id);
    setTabs((current) => {
      const next = closeBrowserGuestTab(current, activeIdRef.current, id, createId);
      setActiveId(next.activeId);
      return next.tabs;
    });
  }

  async function runDownloadAction(action: 'reveal' | 'open' | 'cancel' | 'clear', id?: string) {
    setActionError('');
    try {
      if (action === 'reveal' && id) await window.piApi.browserDownloadReveal(id);
      if (action === 'open' && id) await window.piApi.browserDownloadOpen(id);
      if (action === 'cancel' && id) await window.piApi.browserDownloadCancel(id);
      if (action === 'clear') {
        const result = await window.piApi.browserDownloadClear(id);
        if (!id && Array.isArray((result as { downloads?: BrowserDownload[] }).downloads)) {
          setDownloads((result as { downloads: BrowserDownload[] }).downloads);
        } else if (id) {
          setDownloads((current) => current.filter((item) => item.id !== id));
        }
      }
    } catch (error) {
      setActionError(errorText(error));
    }
  }

  async function clearProfileData() {
    if (clearing) return;
    const accepted = await confirmation.confirm({
      title: '清除浏览数据？',
      description: BROWSER_CLEAR_DESCRIPTION,
      confirmLabel: '清除数据',
      tone: 'danger',
    });
    if (!accepted) return;
    setClearing(true);
    setActionError('');
    try {
      await clearBrowserProfile();
      setMenu(null);
    } catch (error) {
      setActionError(errorText(error));
    } finally {
      setClearing(false);
    }
  }

  async function toggleAgentPause() {
    setActionError('');
    try {
      const next = await window.piApi.browserControlPause({ paused: !agentPaused });
      setAgentPaused(Boolean(next?.paused));
    } catch (error) {
      setActionError(errorText(error));
    }
  }

  async function allowCurrentSiteAct() {
    if (!active?.url || !/^https?:\/\//i.test(active.url)) {
      setActionError('当前页没有可授权的网址');
      return;
    }
    try {
      const host = new URL(active.url).host;
      const result = await window.piApi.browserSitePolicyUpsert({
        originPattern: host,
        actionClass: 'act',
        decision: 'allow',
        note: '从浏览器面板允许',
      });
      if (Array.isArray((result as { policies?: unknown }).policies)) {
        setSitePolicies((result as { policies: typeof sitePolicies }).policies);
      }
      setMenu(null);
    } catch (error) {
      setActionError(errorText(error));
    }
  }

  async function allowCurrentSiteEvaluate() {
    if (!evaluateEnabled) {
      setActionError('请先在设置 → 浏览器中开启页面脚本求值');
      return;
    }
    if (!active?.url || !/^https?:\/\//i.test(active.url)) {
      setActionError('当前页没有可授权的网址');
      return;
    }
    try {
      const host = new URL(active.url).host;
      const result = await window.piApi.browserSitePolicyUpsert({
        originPattern: host,
        actionClass: 'evaluate',
        decision: 'allow',
        note: '从浏览器面板允许脚本求值',
      });
      if (Array.isArray((result as { policies?: unknown }).policies)) {
        setSitePolicies((result as { policies: typeof sitePolicies }).policies);
      }
      setMenu(null);
    } catch (error) {
      setActionError(errorText(error));
    }
  }

  async function detachExternalSessions(sessionId?: string) {
    setActionError('');
    try {
      await window.piApi.browserExternalDetach(sessionId ? { sessionId } : {});
      const result = await window.piApi.browserExternalSessions?.();
      if (Array.isArray(result?.sessions)) setExternalSessions(result.sessions as ExternalSession[]);
      else setExternalSessions([]);
    } catch (error) {
      setActionError(errorText(error));
    }
  }

  const activeFailed = active?.failed || actionError;

  return <div className="browser-panel">
    {confirmation.dialog}
    <div className="browser-tabstrip" role="tablist" aria-label="浏览器标签">
      <div className="browser-tabstrip-scroll">
        {tabs.map((tab) => {
          const selected = tab.id === activeId;
          return <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={selected}
            className={`browser-guest-tab ${selected ? 'is-active' : ''} ${tab.loading ? 'is-loading' : ''}`}
            title={tab.url}
            onClick={() => setActiveId(tab.id)}
          >
            <Globe aria-hidden="true" />
            <span>{browserTabLabel(tab)}</span>
            <span
              className="browser-guest-tab-close"
              role="button"
              tabIndex={-1}
              aria-label={`关闭 ${browserTabLabel(tab)}`}
              onClick={(event) => { event.stopPropagation(); closeGuest(tab.id); }}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault();
                  event.stopPropagation();
                  closeGuest(tab.id);
                }
              }}
            ><X aria-hidden="true" /></span>
          </button>;
        })}
      </div>
      <button type="button" className="icon-button" aria-label="新建标签页" title="新建标签页" onClick={() => openGuestTab()}>
        <Plus />
      </button>
    </div>

    <div className="browser-toolbar">
      <button type="button" className="icon-button" aria-label="后退" title="后退" disabled={!nav.back} onClick={() => viewsRef.current.get(activeId)?.goBack()}><ArrowLeft /></button>
      <button type="button" className="icon-button" aria-label="前进" title="前进" disabled={!nav.forward} onClick={() => viewsRef.current.get(activeId)?.goForward()}><ArrowRight /></button>
      <button
        type="button"
        className={`icon-button ${active?.loading ? 'is-busy' : ''}`}
        disabled={!readyRef.current.has(activeId)}
        aria-label="刷新"
        title="刷新"
        onClick={() => viewsRef.current.get(activeId)?.reload()}
      ><RotateCw className={active?.loading ? 'spin' : undefined} /></button>
      <form className="browser-address" onSubmit={(event) => { event.preventDefault(); submitAddress(); }}>
        <Globe aria-hidden="true" />
        <input
          value={addressBarValue(active?.address || '', active?.url || '', showFullUrl, addressFocused)}
          aria-label="浏览器地址"
          placeholder="输入网址"
          spellCheck={false}
          title={active?.url || active?.address || ''}
          onChange={(event) => active && updateTab(active.id, { address: event.target.value })}
          onFocus={(event) => {
            setAddressFocused(true);
            event.currentTarget.select();
          }}
          onBlur={() => setAddressFocused(false)}
        />
      </form>
      <div className="browser-toolbar-actions">
        <button
          type="button"
          className={`icon-button ${agentPaused ? 'is-active' : ''}`}
          aria-label={agentPaused ? '继续 Agent 操作' : '暂停 Agent 操作'}
          title={agentPaused ? '继续 Agent 操作' : '暂停 Agent 操作（接管）'}
          onClick={() => void toggleAgentPause()}
        ><Hand /></button>
        <button ref={historyButtonRef} type="button" className={`icon-button ${menu === 'history' ? 'is-active' : ''}`} aria-label="历史记录" title="历史记录" aria-expanded={menu === 'history'} onClick={() => setMenu((current) => current === 'history' ? null : 'history')}><Clock3 /></button>
        <button ref={downloadsButtonRef} type="button" className={`icon-button ${menu === 'downloads' ? 'is-active' : ''}`} aria-label="下载" title="下载" aria-expanded={menu === 'downloads'} onClick={() => setMenu((current) => current === 'downloads' ? null : 'downloads')}><Download /></button>
        <button
          type="button"
          className="icon-button"
          aria-label="在系统浏览器打开"
          title="在系统浏览器打开"
          disabled={!active || !/^https?:\/\//i.test(active.url)}
          onClick={() => { if (active && /^https?:\/\//i.test(active.url)) void window.piApi.openLink(active.url, 'external'); }}
        ><ExternalLink /></button>
        <button type="button" className={`icon-button ${menu === 'more' ? 'is-active' : ''}`} aria-label="更多" title="更多" aria-expanded={menu === 'more'} onClick={() => setMenu((current) => current === 'more' ? null : 'more')}><MoreHorizontal /></button>
        {onClose && <button type="button" className="icon-button" aria-label="关闭浏览器" title="关闭" onClick={onClose}><X /></button>}
      </div>
    </div>

    {agentPaused && <div className="browser-agent-banner" role="status">
      <Hand aria-hidden="true" />
      <span>已接管：Agent 不会继续操作此浏览器</span>
      <button type="button" className="text-button" onClick={() => void toggleAgentPause()}>继续</button>
    </div>}

    {externalSessions.length > 0 && <div className="browser-external-banner" role="status">
      <Unplug aria-hidden="true" />
      <span>
        已外接 {externalSessions.length} 个 Chrome 标签
        {externalSessions[0]?.title || externalSessions[0]?.url
          ? ` · ${externalSessions[0].title || externalSessions[0].url}`
          : ''}
        {externalSessions.length > 1 ? ' 等' : ''}
      </span>
      <button type="button" className="text-button" onClick={() => void detachExternalSessions()}>全部断开</button>
    </div>}

    {menu && <div className="browser-popover" role="dialog" aria-label={menu === 'history' ? '历史记录' : menu === 'downloads' ? '下载' : '浏览器菜单'}>
      {menu === 'history' && <>
        <div className="browser-popover-head">
          <strong>历史记录</strong>
          <button type="button" className="text-button" disabled={history.length === 0} onClick={() => setHistory(clearBrowserHistory())}>清空</button>
        </div>
        {history.length === 0 ? <p className="browser-popover-empty">还没有访问记录</p> : (
          <ul className="browser-popover-list">
            {history.map((entry) => <li key={`${entry.url}:${entry.visitedAt}`}>
              <button type="button" onClick={() => openGuestTab(entry.url)}>
                <span>{entry.title || entry.url}</span>
                <small>{entry.url}</small>
              </button>
            </li>)}
          </ul>
        )}
      </>}
      {menu === 'downloads' && <>
        <div className="browser-popover-head">
          <strong>下载</strong>
          <div className="browser-popover-head-actions">
            <button type="button" className="text-button" onClick={() => void window.piApi.browserDownloadsFolder().catch((error) => setActionError(errorText(error)))}>打开目录</button>
            <button type="button" className="text-button" disabled={downloads.length === 0} onClick={() => void runDownloadAction('clear')}>清空列表</button>
          </div>
        </div>
        {downloads.length === 0 ? <p className="browser-popover-empty">还没有下载</p> : (
          <ul className="browser-popover-list browser-download-list">
            {downloads.map((item) => <li key={item.id}>
              <div className="browser-download-row">
                <div>
                  <span>{item.filename}</span>
                  <small>{downloadLabel(item)}{item.risky ? ' · 可执行文件' : ''}</small>
                </div>
                <div className="browser-download-actions">
                  {item.state === 'progressing' && <button type="button" className="text-button" onClick={() => void runDownloadAction('cancel', item.id)}>取消</button>}
                  {item.state === 'completed' && <>
                    <button type="button" className="text-button" onClick={() => void runDownloadAction('reveal', item.id)}>显示</button>
                    {!item.risky && <button type="button" className="text-button" onClick={() => void runDownloadAction('open', item.id)}>打开</button>}
                  </>}
                  {item.state !== 'progressing' && <button type="button" className="text-button" onClick={() => void runDownloadAction('clear', item.id)}>移除</button>}
                </div>
              </div>
            </li>)}
          </ul>
        )}
      </>}
      {menu === 'more' && <div className="browser-more-menu">
        <button type="button" onClick={() => openGuestTab()}>新建标签页</button>
        <button type="button" onClick={() => void toggleAgentPause()}>
          <Hand aria-hidden="true" />{agentPaused ? '继续 Agent 操作' : '暂停 Agent 操作'}
        </button>
        <button type="button" onClick={() => void allowCurrentSiteAct()}>
          <Shield aria-hidden="true" />允许当前站点的页面操作
        </button>
        <button type="button" onClick={() => void allowCurrentSiteEvaluate()}>
          <Shield aria-hidden="true" />允许当前站点的脚本求值
        </button>
        <button type="button" onClick={() => { setHistory(clearBrowserHistory()); setMenu(null); }}>清除历史记录</button>
        <div className="browser-viewport-menu">
          <strong><Monitor aria-hidden="true" />视口尺寸</strong>
          <div className="browser-viewport-presets">
            {VIEWPORT_PRESETS.map((item) => {
              const selected = (!viewportOverride && !item.viewport)
                || Boolean(viewportOverride && item.viewport && viewportOverride.width === item.viewport.width && viewportOverride.height === item.viewport.height);
              return <button
                key={item.id}
                type="button"
                className={selected ? 'is-selected' : undefined}
                onClick={() => { setViewportOverride(item.viewport); setMenu(null); }}
              >{item.label}</button>;
            })}
          </div>
        </div>
        <button type="button" disabled={clearing} onClick={() => void clearProfileData()}>
          <Trash2 aria-hidden="true" />{clearing ? '正在清除…' : '清除浏览器数据'}
        </button>
        {sitePolicies.length > 0 && <div className="browser-policy-list">
          <strong>站点策略</strong>
          <ul>
            {sitePolicies.slice(0, 8).map((row) => <li key={row.id}>
              <span>{row.originPattern} · {row.actionClass} · {row.decision}</span>
              <button
                type="button"
                className="text-button"
                onClick={() => {
                  void window.piApi.browserSitePolicyRemove({ id: row.id }).then((result) => {
                    if (Array.isArray((result as { policies?: unknown }).policies)) {
                      setSitePolicies((result as { policies: typeof sitePolicies }).policies);
                    }
                  }).catch((error) => setActionError(errorText(error)));
                }}
              >移除</button>
            </li>)}
          </ul>
        </div>}
      </div>}
    </div>}

    {viewportOverride && <div className="browser-viewport-bar" role="status">
      <Monitor aria-hidden="true" />
      <span>视口模拟：{viewportOverride.width} × {viewportOverride.height}</span>
      {stageSize.width > 0 && stageSize.height > 0 && (() => {
        const availW = Math.max(120, stageSize.width - 24);
        const availH = Math.max(120, stageSize.height - 24);
        const scale = Math.min(1, availW / viewportOverride.width, availH / viewportOverride.height);
        return scale < 0.99 ? <small>缩放 {Math.round(scale * 100)}%</small> : null;
      })()}
      <button type="button" className="text-button" onClick={() => setViewportOverride(null)}>恢复自适应</button>
    </div>}

    {activeFailed && <p className="browser-failure" role="status">{activeFailed}</p>}

    <div
      ref={stageRef}
      className={`browser-stage ${agentActivity.active && !agentPaused ? 'is-agent-active' : ''} ${viewportOverride ? 'is-viewport-emulated' : ''}`}
    >
      {(() => {
        const frames = tabs.map((tab) => (
          <GuestFrame
            key={tab.id}
            tab={tab}
            active={tab.id === activeId}
            onReady={markReady}
            onPatch={updateTab}
            onHistory={rememberHistory}
            registerView={registerView}
          />
        ));
        if (!viewportOverride) return frames;
        const availW = Math.max(120, (stageSize.width || viewportOverride.width) - 24);
        const availH = Math.max(120, (stageSize.height || viewportOverride.height) - 24);
        const scale = Math.min(1, availW / viewportOverride.width, availH / viewportOverride.height);
        const scaledW = Math.round(viewportOverride.width * scale);
        const scaledH = Math.round(viewportOverride.height * scale);
        return <div className="browser-viewport-scroll">
          <div className="browser-viewport-frame" style={{ width: `${scaledW}px`, height: `${scaledH}px` }}>
            <div
              className="browser-viewport-canvas"
              style={{
                width: `${viewportOverride.width}px`,
                height: `${viewportOverride.height}px`,
                transform: scale < 0.999 ? `scale(${scale})` : undefined,
              }}
            >
              {frames}
            </div>
          </div>
        </div>;
      })()}

      {(agentActivity.active || agentPaused) && <div className="browser-live-controls" role="region" aria-label="AI 浏览器操控状态">
        {agentPaused ? (
          <button type="button" className="browser-live-resume" onClick={() => void toggleAgentPause()}>
            <Play aria-hidden="true" />
            <span>已接管 · 继续 AI 操作</span>
          </button>
        ) : (
          <button
            type="button"
            className="browser-live-stop"
            title={agentActivity.label ? `正在执行：${agentActivity.label}（点击立即停止并接管）` : '点击立即停止并接管浏览器'}
            onClick={() => void toggleAgentPause()}
          >
            <Square aria-hidden="true" />
            <span>Stop</span>
          </button>
        )}
      </div>}
    </div>
  </div>;
}



function addressBarValue(address: string, url: string, full: boolean, focused: boolean) {
  const raw = address || url || '';
  if (full || focused || !raw) return address || raw;
  try {
    const parsed = new URL(raw);
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
      return parsed.host + (parsed.pathname === '/' ? '' : parsed.pathname);
    }
  } catch {
    // keep raw
  }
  return raw;
}
