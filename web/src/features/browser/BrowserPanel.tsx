import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  Clock3,
  Download,
  ExternalLink,
  Globe,
  Hand,
  Laptop,
  Monitor,
  MoreHorizontal,
  Play,
  Plus,
  RotateCcw,
  RotateCw,
  Shield,
  Smartphone,
  Square,
  SquareTerminal,
  Tablet,
  Trash2,
  Unplug,
  X,
} from 'lucide-react';
import { useActionConfirmation } from '../../shared/ConfirmDialog';
import { errorText } from '../../shared/error-text';
import './styles/browser-panel.css';
import { normalizeBrowserTarget } from './browser-target.ts';
import {
  clearBrowserHistory,
  clearBrowserProfile,
  BROWSER_CLEAR_DESCRIPTION,
  BROWSER_HISTORY_CLEARED,
  BROWSER_HISTORY_UPDATED,
  loadBrowserHistory,
  recordBrowserHistoryVisit,
  saveBrowserHistory,
  type BrowserHistoryEntry,
  type BrowserLibraryView,
} from './browser-history.ts';
import {
  browserTabLabel,
  createBrowserGuestTab,
  type BrowserGuestTab,
} from './browser-tab.ts';

type WebviewElement = HTMLElement & {
  loadURL(url: string): Promise<void>;
  reload(): void;
  goBack(): void;
  goForward(): void;
  canGoBack(): boolean;
  canGoForward(): boolean;
  getURL(): string;
  getTitle(): string;
  openDevTools(): void;
  closeDevTools(): void;
  isDevToolsOpened(): boolean;
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

type ViewportZoomMode = 'fit' | '50' | '75' | '100';

const VIEWPORT_PRESETS: Array<{
  id: string;
  name: string;
  meta: string;
  icon: 'fluid' | 'desktop' | 'laptop' | 'tablet' | 'mobile';
  viewport: BrowserViewportOverride | null;
}> = [
  { id: 'reset', name: '自适应窗口', meta: '跟随工具窗口宽度', icon: 'fluid', viewport: null },
  { id: 'desktop', name: '桌面', meta: '1440 × 900', icon: 'desktop', viewport: { width: 1440, height: 900, label: '桌面 1440×900' } },
  { id: 'laptop', name: '笔记本', meta: '1280 × 800', icon: 'laptop', viewport: { width: 1280, height: 800, label: '笔记本 1280×800' } },
  { id: 'tablet', name: '平板', meta: '768 × 1024', icon: 'tablet', viewport: { width: 768, height: 1024, label: '平板 768×1024' } },
  { id: 'mobile', name: '手机', meta: '390 × 844', icon: 'mobile', viewport: { width: 390, height: 844, label: '手机 390×844' } },
];

const VIEWPORT_ZOOM_OPTIONS: Array<{ id: ViewportZoomMode; label: string }> = [
  { id: 'fit', label: '适应' },
  { id: '50', label: '50%' },
  { id: '75', label: '75%' },
  { id: '100', label: '1:1' },
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
    const handleDevToolsOpened = () => onPatch(tab.id, { devToolsOpen: true });
    const handleDevToolsClosed = () => onPatch(tab.id, { devToolsOpen: false });
    view.addEventListener('dom-ready', handleReady);
    view.addEventListener('did-navigate', handleNavigate);
    view.addEventListener('did-navigate-in-page', handleNavigate);
    view.addEventListener('did-start-loading', handleStart);
    view.addEventListener('did-stop-loading', handleStop);
    view.addEventListener('did-fail-load', handleFail);
    view.addEventListener('page-title-updated', handleTitle);
    view.addEventListener('devtools-opened', handleDevToolsOpened);
    view.addEventListener('devtools-closed', handleDevToolsClosed);
    return () => {
      view.removeEventListener('dom-ready', handleReady);
      view.removeEventListener('did-navigate', handleNavigate);
      view.removeEventListener('did-navigate-in-page', handleNavigate);
      view.removeEventListener('did-start-loading', handleStart);
      view.removeEventListener('did-stop-loading', handleStop);
      view.removeEventListener('did-fail-load', handleFail);
      view.removeEventListener('page-title-updated', handleTitle);
      view.removeEventListener('devtools-opened', handleDevToolsOpened);
      view.removeEventListener('devtools-closed', handleDevToolsClosed);
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
  id,
  visible,
  onNewTab,
  libraryRequest,
  onLibraryOpened,
  onUrlChange,
  onTitleChange,
  onClose,
}: {
  url: string;
  id: string;
  visible: boolean;
  onNewTab: (url?: string) => void;
  libraryRequest?: { id: string; view: BrowserLibraryView };
  onLibraryOpened?: (id: string) => void;
  onUrlChange?: (url: string) => void;
  onTitleChange?: (title: string) => void;
  onClose?: () => void;
}) {
  const [active, setPage] = useState(() => createBrowserGuestTab({ id, url }));
  const [nav, setNav] = useState({ back: false, forward: false });
  const [menu, setMenu] = useState<'viewport' | 'history' | 'downloads' | 'more' | null>(null);
  const [viewportZoomMode, setViewportZoomMode] = useState<ViewportZoomMode>('fit');
  const [viewportDragging, setViewportDragging] = useState(false);
  const [customViewportW, setCustomViewportW] = useState('1280');
  const [customViewportH, setCustomViewportH] = useState('800');
  const actionsRef = useRef<HTMLDivElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const frameDragRef = useRef<{
    axis: 'x' | 'y';
    startX: number;
    startY: number;
    startW: number;
    startH: number;
    scale: number;
  } | null>(null);
  const [history, setHistory] = useState<BrowserHistoryEntry[]>(() => loadBrowserHistory());
  const historyButtonRef = useRef<HTMLButtonElement>(null);
  const downloadsButtonRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const reset = () => setHistory([]);
    const sync = () => setHistory(loadBrowserHistory());
    window.addEventListener(BROWSER_HISTORY_CLEARED, reset);
    window.addEventListener(BROWSER_HISTORY_UPDATED, sync);
    return () => {
      window.removeEventListener(BROWSER_HISTORY_CLEARED, reset);
      window.removeEventListener(BROWSER_HISTORY_UPDATED, sync);
    };
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
  const guest = useRef<WebviewElement | null>(null);
  const [contentsId, setContentsId] = useState<number | null>(null);
  const syncNav = useCallback(() => {
    const view = guest.current;
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

  const updateTab = useCallback((_id: string, patch: Partial<BrowserGuestTab>) => {
    setPage(previous => ({ ...previous, ...patch }));
  }, []);

  const markReady = useCallback((_id: string, webContentsId: number | null) => {
    setContentsId(webContentsId);
    syncNav();
  }, [syncNav]);

  const registerView = useCallback((_id: string, node: WebviewElement | null) => {
    guest.current = node;
  }, []);

  const navigate = useCallback((id: string, target: string) => {
    const view = guest.current;
    if (!view) return;
    const normalized = normalizeBrowserTarget(target) || target;
    if (!/^(https?:\/\/|file:\/\/|about:blank$)/i.test(normalized)) {
      updateTab(id, { failed: '只支持 http(s) 链接或本地 HTML 文件' });
      return;
    }
    updateTab(id, { failed: '', loading: true, address: normalized === 'about:blank' ? '' : normalized });
    if (!contentsId) {
      view.setAttribute('src', normalized);
      return;
    }
    try {
      void view.loadURL(normalized).catch(() => {});
    } catch {
      view.setAttribute('src', normalized);
    }
  }, [contentsId, updateTab]);

  const pageRef = useRef(active);
  pageRef.current = active;
  useEffect(() => {
    if (!contentsId) return;
    const page = pageRef.current;
    void window.piApi.browserTabRegister({
      id, webContentsId: contentsId, url: page.url, title: page.title, loading: page.loading,
    }).catch(() => {});
    return () => { void window.piApi.browserTabUnregister(id).catch(() => {}); };
  }, [contentsId, id]);
  useEffect(() => {
    if (!contentsId) return;
    void window.piApi.browserTabUpdate({ id, url: active.url, title: active.title, loading: active.loading, active: visible }).catch(() => {});
    syncNav();
  }, [contentsId, id, active.url, active.title, active.loading, visible, syncNav]);
  useEffect(() => { onUrlChange?.(active.url); }, [active.url, onUrlChange]);
  useEffect(() => { onTitleChange?.(browserTabLabel(active)); }, [active.title, active.url, onTitleChange]);
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

  useEffect(() => window.piApi.onBrowserCommand((command: BrowserCommand) => {
    if (command.type === 'viewport' && command.tabId === id) setViewportOverride(command.viewport ?? null);
  }), [id]);

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
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (!target) return;
      if (popoverRef.current?.contains(target) || actionsRef.current?.contains(target)) return;
      setMenu(null);
    };
    const onBlur = () => setMenu(null);
    window.addEventListener('keydown', onKey);
    window.addEventListener('pointerdown', onPointerDown, true);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('pointerdown', onPointerDown, true);
      window.removeEventListener('blur', onBlur);
    };
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

  function openGuestTab(nextUrl?: string) {
    setMenu(null);
    onNewTab(nextUrl);
  }

  function toggleDevTools() {
    const view = guest.current;
    if (!view || !contentsId) return;
    setMenu(null);
    setActionError('');
    try {
      if (view.isDevToolsOpened()) view.closeDevTools();
      else view.openDevTools();
    } catch (error) {
      setActionError(errorText(error));
    }
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
  const ViewportIcon = !viewportOverride
    ? Monitor
    : viewportOverride.width <= 480
      ? Smartphone
      : viewportOverride.width <= 900
        ? Tablet
        : viewportOverride.width <= 1320
          ? Laptop
          : Monitor;

  const fitScale = (() => {
    if (!viewportOverride) return 1;
    // Reserve modest padding + floating dock headroom inside the emulated stage backdrop.
    const availW = Math.max(120, (stageSize.width || viewportOverride.width) - 36);
    const availH = Math.max(120, (stageSize.height || viewportOverride.height) - 72);
    return Math.min(1, availW / viewportOverride.width, availH / viewportOverride.height);
  })();

  const emulatedScale = (() => {
    if (!viewportOverride) return 1;
    if (viewportZoomMode === 'fit') return fitScale;
    if (viewportZoomMode === '50') return 0.5;
    if (viewportZoomMode === '75') return 0.75;
    return 1;
  })();

  function selectViewportPreset(next: BrowserViewportOverride | null) {
    setViewportOverride(next);
    if (next) {
      setCustomViewportW(String(next.width));
      setCustomViewportH(String(next.height));
    } else {
      setViewportZoomMode('fit');
    }
    setMenu(null);
  }

  function rotateViewport() {
    if (!viewportOverride) return;
    const nextW = Math.min(2560, Math.max(320, viewportOverride.height));
    const nextH = Math.min(1800, Math.max(320, viewportOverride.width));
    setCustomViewportW(String(nextW));
    setCustomViewportH(String(nextH));
    setViewportOverride({ width: nextW, height: nextH, label: `${nextW}×${nextH}` });
  }

  function applyCustomViewport() {
    const w = Math.min(2560, Math.max(320, Math.round(Number(customViewportW) || 1280)));
    const h = Math.min(1800, Math.max(320, Math.round(Number(customViewportH) || 800)));
    setCustomViewportW(String(w));
    setCustomViewportH(String(h));
    setViewportOverride({ width: w, height: h, label: `${w}×${h}` });
    setMenu(null);
  }

  function startFrameResize(axis: 'x' | 'y', event: React.PointerEvent<HTMLDivElement>) {
    if (!viewportOverride || event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    frameDragRef.current = {
      axis,
      startX: event.clientX,
      startY: event.clientY,
      startW: viewportOverride.width,
      startH: viewportOverride.height,
      scale: Math.max(0.2, emulatedScale),
    };
    setViewportDragging(true);
  }

  function moveFrameResize(event: React.PointerEvent<HTMLDivElement>) {
    const drag = frameDragRef.current;
    if (!drag) return;
    if (drag.axis === 'x') {
      // Frame is horizontally centered when narrower than stage, so scale drag naturally.
      const dx = (event.clientX - drag.startX) / drag.scale;
      const nextW = Math.min(2560, Math.max(320, Math.round(drag.startW + dx)));
      setCustomViewportW(String(nextW));
      setViewportOverride((current) => current ? { width: nextW, height: current.height, label: `${nextW}×${current.height}` } : current);
    } else {
      const dy = (event.clientY - drag.startY) / drag.scale;
      const nextH = Math.min(1800, Math.max(320, Math.round(drag.startH + dy)));
      setCustomViewportH(String(nextH));
      setViewportOverride((current) => current ? { width: current.width, height: nextH, label: `${current.width}×${nextH}` } : current);
    }
  }

  function endFrameResize() {
    if (!frameDragRef.current) return;
    frameDragRef.current = null;
    setViewportDragging(false);
  }

  return <div className="browser-panel">
    {confirmation.dialog}

    <div className="browser-toolbar">
      <button type="button" className="icon-button" aria-label="后退" title="后退" disabled={!nav.back} onClick={() => guest.current?.goBack()}><ArrowLeft /></button>
      <button type="button" className="icon-button" aria-label="前进" title="前进" disabled={!nav.forward} onClick={() => guest.current?.goForward()}><ArrowRight /></button>
      <button
        type="button"
        className={`icon-button ${active?.loading ? 'is-busy' : ''}`}
        disabled={!contentsId}
        aria-label="刷新"
        title="刷新"
        onClick={() => guest.current?.reload()}
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
      <div className="browser-toolbar-actions" ref={actionsRef}>
        <button
          type="button"
          className={`${viewportOverride ? 'browser-viewport-pill' : 'icon-button'} ${menu === 'viewport' || viewportOverride ? 'is-active' : ''}`}
          aria-label={viewportOverride ? `视口模拟：${viewportOverride.width}×${viewportOverride.height}` : '视口尺寸（自适应窗口）'}
          title={viewportOverride ? `视口模拟：${viewportOverride.label || `${viewportOverride.width}×${viewportOverride.height}`}` : '视口尺寸（自适应窗口）'}
          aria-expanded={menu === 'viewport'}
          onClick={() => {
            if (viewportOverride) {
              setCustomViewportW(String(viewportOverride.width));
              setCustomViewportH(String(viewportOverride.height));
            }
            setMenu((current) => current === 'viewport' ? null : 'viewport');
          }}
        >
          <ViewportIcon aria-hidden="true" />
          {viewportOverride && <span>{viewportOverride.width}×{viewportOverride.height}</span>}
        </button>
        <button
          type="button"
          className={`icon-button ${active.devToolsOpen ? 'is-active' : ''}`}
          aria-label="网页开发者工具"
          aria-pressed={active.devToolsOpen}
          title={active.devToolsOpen ? '关闭网页开发者工具' : '打开网页开发者工具（控制台、网络）'}
          disabled={!contentsId}
          onClick={toggleDevTools}
        ><SquareTerminal aria-hidden="true" /></button>
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

    {menu && <div className="browser-popover-backdrop" aria-hidden="true" onPointerDown={() => setMenu(null)} />}

    {menu && <div
      ref={popoverRef}
      className="browser-popover"
      role="dialog"
      aria-label={
        menu === 'viewport' ? '视口尺寸'
            : menu === 'history' ? '历史记录'
              : menu === 'downloads' ? '下载'
                : '浏览器菜单'
      }
    >
      {menu === 'viewport' && <>
        <div className="browser-popover-head">
          <strong>视口与设备模拟</strong>
          {viewportOverride && <button type="button" className="text-button" onClick={() => selectViewportPreset(null)}>恢复自适应</button>}
        </div>
        <div className="browser-viewport-popover">
          <div className="browser-viewport-grid">
            {VIEWPORT_PRESETS.map((item) => {
              const selected = (!viewportOverride && !item.viewport)
                || Boolean(viewportOverride && item.viewport && viewportOverride.width === item.viewport.width && viewportOverride.height === item.viewport.height);
              const PresetIcon = item.icon === 'mobile'
                ? Smartphone
                : item.icon === 'tablet'
                  ? Tablet
                  : item.icon === 'laptop'
                    ? Laptop
                    : Monitor;
              const meta = item.id === 'reset' && stageSize.width > 0
                ? `当前 ${Math.round(stageSize.width)}px`
                : item.meta;
              return <button
                key={item.id}
                type="button"
                className={`browser-viewport-card ${item.id === 'reset' ? 'is-wide' : ''} ${selected ? 'is-selected' : ''}`}
                onClick={() => selectViewportPreset(item.viewport)}
              >
                <PresetIcon aria-hidden="true" />
                <span className="browser-viewport-card-text">
                  <span>{item.name}</span>
                  <small>{meta}</small>
                </span>
              </button>;
            })}
          </div>
          {viewportOverride && <div className="browser-viewport-controls-row">
            <div className="browser-viewport-scale-group" role="group" aria-label="缩放比例">
              {VIEWPORT_ZOOM_OPTIONS.map((option) => (
                <button
                  key={option.id}
                  type="button"
                  className={viewportZoomMode === option.id ? 'is-selected' : undefined}
                  onClick={() => setViewportZoomMode(option.id)}
                >{option.label}</button>
              ))}
            </div>
            <button
              type="button"
              className="browser-viewport-action-btn"
              title="切换横屏 / 竖屏"
              onClick={rotateViewport}
            ><RotateCcw aria-hidden="true" />旋转</button>
          </div>}
          <form className="browser-viewport-custom" onSubmit={(event) => { event.preventDefault(); applyCustomViewport(); }}>
            <input
              type="number"
              min={320}
              max={2560}
              aria-label="自定义宽度"
              value={customViewportW}
              onChange={(event) => setCustomViewportW(event.target.value)}
            />
            <span aria-hidden="true">×</span>
            <input
              type="number"
              min={320}
              max={1800}
              aria-label="自定义高度"
              value={customViewportH}
              onChange={(event) => setCustomViewportH(event.target.value)}
            />
            <button type="submit" className="text-button">应用</button>
          </form>
        </div>
      </>}
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
        <button type="button" onClick={() => openGuestTab()}><Plus aria-hidden="true" />新建标签页</button>
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
        <button type="button" disabled={clearing} onClick={() => void clearProfileData()}>
          <Trash2 aria-hidden="true" />{clearing ? '正在清除…' : '清除浏览器数据'}
        </button>
        {onClose && <button type="button" onClick={() => { setMenu(null); onClose(); }}>
          <X aria-hidden="true" />关闭浏览器
        </button>}
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

    {activeFailed && <p className="browser-failure" role="status">{activeFailed}</p>}

    <div
      ref={stageRef}
      className={`browser-stage ${agentActivity.active && !agentPaused ? 'is-agent-active' : ''} ${viewportOverride ? 'is-viewport-emulated' : ''} ${viewportDragging ? 'is-viewport-dragging' : ''}`}
    >
      {/* Keep wrapper depth invariant so toggling viewport presets never remounts live <webview> guests. */}
      <div className={`browser-viewport-scroll ${viewportOverride ? 'is-emulated' : 'is-fluid'}`}>
        {viewportOverride && <div className="browser-canvas-dock" role="toolbar" aria-label="视口模拟控制">
          <button
            type="button"
            className="browser-canvas-dock-meta"
            title="切换设备或自定义视口"
            onClick={() => {
              setCustomViewportW(String(viewportOverride.width));
              setCustomViewportH(String(viewportOverride.height));
              setMenu((current) => current === 'viewport' ? null : 'viewport');
            }}
          >
            <ViewportIcon aria-hidden="true" />
            <span>{viewportOverride.width} × {viewportOverride.height}</span>
            <small>{Math.round(emulatedScale * 100)}%</small>
          </button>
          <span className="browser-canvas-dock-sep" aria-hidden="true" />
          <div className="browser-canvas-dock-zoom" role="group" aria-label="显示比例">
            <button
              type="button"
              className={viewportZoomMode === 'fit' ? 'is-selected' : undefined}
              title="按当前窗口等比缩放"
              onClick={() => setViewportZoomMode('fit')}
            >适应</button>
            <button
              type="button"
              className={viewportZoomMode === '75' ? 'is-selected' : undefined}
              title="75% 缩放"
              onClick={() => setViewportZoomMode('75')}
            >75%</button>
            <button
              type="button"
              className={viewportZoomMode === '100' ? 'is-selected' : undefined}
              title="1:1 原始像素"
              onClick={() => setViewportZoomMode('100')}
            >1:1</button>
          </div>
          <button
            type="button"
            className="browser-canvas-dock-icon"
            aria-label="切换横屏或竖屏"
            title="横屏 / 竖屏切换"
            onClick={rotateViewport}
          ><RotateCcw aria-hidden="true" /></button>
          <button
            type="button"
            className="browser-canvas-dock-icon"
            aria-label="恢复自适应窗口"
            title="恢复自适应窗口"
            onClick={() => selectViewportPreset(null)}
          ><X aria-hidden="true" /></button>
        </div>}

        <div
          className={`browser-viewport-frame ${viewportOverride ? 'is-emulated' : 'is-fluid'}`}
          style={viewportOverride ? {
            width: `${Math.round(viewportOverride.width * emulatedScale)}px`,
            height: `${Math.round(viewportOverride.height * emulatedScale)}px`,
          } : undefined}
        >
          <div
            className={`browser-viewport-canvas ${viewportOverride ? 'is-emulated' : 'is-fluid'}`}
            style={viewportOverride ? {
              width: `${viewportOverride.width}px`,
              height: `${viewportOverride.height}px`,
              transform: emulatedScale < 0.999 ? `scale(${emulatedScale})` : undefined,
            } : undefined}
          >
            <GuestFrame tab={active} active onReady={markReady} onPatch={updateTab}
              onHistory={rememberHistory} registerView={registerView} />
          </div>
          {viewportOverride && <>
            <div
              className="browser-viewport-handle is-right"
              role="separator"
              aria-orientation="vertical"
              aria-label="拖拽调整模拟视口宽度"
              title="拖拽调整宽度"
              onPointerDown={(event) => startFrameResize('x', event)}
              onPointerMove={moveFrameResize}
              onPointerUp={endFrameResize}
              onPointerCancel={endFrameResize}
            />
            <div
              className="browser-viewport-handle is-bottom"
              role="separator"
              aria-orientation="horizontal"
              aria-label="拖拽调整模拟视口高度"
              title="拖拽调整高度"
              onPointerDown={(event) => startFrameResize('y', event)}
              onPointerMove={moveFrameResize}
              onPointerUp={endFrameResize}
              onPointerCancel={endFrameResize}
            />
          </>}
        </div>
      </div>

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
