/**
 * In-app browser panel.
 *
 * Electron's `<webview>` keeps the page in its own process with an isolated
 * `persist:pi-browser` partition: no preload, no node integration, no popups.
 * The panel only exposes navigation controls and a URL field. Network pages
 * use http(s); an explicitly entered local .html/.htm file is handled by the
 * same guarded webview and cannot turn into a general file viewer.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, ExternalLink, Globe, RotateCw, X } from 'lucide-react';
import { normalizeBrowserTarget } from './browser-target.mjs';

type WebviewElement = HTMLElement & {
  loadURL(url: string): Promise<void>;
  reload(): void;
  goBack(): void;
  goForward(): void;
  canGoBack(): boolean;
  canGoForward(): boolean;
  getURL(): string;
  getTitle(): string;
  addEventListener(type: string, listener: (event: unknown) => void): void;
  removeEventListener(type: string, listener: (event: unknown) => void): void;
};

const Webview = 'webview' as unknown as React.FC<Record<string, unknown>>;

export function BrowserPanel({ url, onUrlChange, onClose }: {
  url: string;
  onUrlChange?: (url: string) => void;
  onClose?: () => void;
}) {
  const viewRef = useRef<WebviewElement | null>(null);
  const [address, setAddress] = useState(url);
  const [current, setCurrent] = useState(url);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState('');
  const [nav, setNav] = useState({ back: false, forward: false });
  const [ready, setReady] = useState(false);
  const readyRef = useRef(false);
  const currentRef = useRef(url);
  const onUrlChangeRef = useRef(onUrlChange);
  onUrlChangeRef.current = onUrlChange;
  // React must not reassign src after every guest navigation/redirect.
  const initialSrc = useRef(url || 'about:blank');

  const syncNav = useCallback(() => {
    const view = viewRef.current;
    if (!view) return;
    try {
      setNav({ back: view.canGoBack(), forward: view.canGoForward() });
    } catch {
      setNav({ back: false, forward: false });
    }
  }, []);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return () => {};
    const handleNavigate = (event: unknown) => {
      const detail = event as { url?: string; isMainFrame?: boolean };
      if (detail.isMainFrame === false) return;
      const next = detail.url;
      if (typeof next !== 'string' || !next) return;
      currentRef.current = next;
      setCurrent(next);
      setAddress(next);
      setFailed('');
      onUrlChangeRef.current?.(next);
      syncNav();
    };
    const handleReady = () => { readyRef.current = true; setReady(true); syncNav(); };
    view.addEventListener('dom-ready', handleReady);
    const handleStart = () => { setLoading(true); setFailed(''); };
    const handleStop = () => { setLoading(false); syncNav(); };
    const handleFail = (event: unknown) => {
      const detail = event as { errorDescription?: string; errorCode?: number; isMainFrame?: boolean };
      if (detail.isMainFrame === false || detail.errorCode === -3) return;
      setFailed(detail.errorDescription || '页面加载失败');
    };
    view.addEventListener('did-navigate', handleNavigate);
    view.addEventListener('did-navigate-in-page', handleNavigate);
    view.addEventListener('did-start-loading', handleStart);
    view.addEventListener('did-stop-loading', handleStop);
    view.addEventListener('did-fail-load', handleFail);
    return () => {
      view.removeEventListener('did-navigate', handleNavigate);
      view.removeEventListener('did-navigate-in-page', handleNavigate);
      view.removeEventListener('did-start-loading', handleStart);
      view.removeEventListener('did-stop-loading', handleStop);
      view.removeEventListener('did-fail-load', handleFail);
      view.removeEventListener('dom-ready', handleReady);
    };
  }, [syncNav]);

  /**
   * Electron refuses `loadURL` until the element is attached and `dom-ready`
   * has fired. Fall back to the `src` attribute (which navigates on attach)
   * so a link click that arrives before the panel settles still lands.
   */
  const navigate = useCallback((target: string) => {
    const view = viewRef.current;
    if (!view) return;
    if (!/^(https?:\/\/|file:\/\/|about:blank$)/i.test(target)) {
      setFailed('只支持 http(s) 链接或本地 HTML 文件');
      return;
    }
    if (!readyRef.current) {
      view.setAttribute('src', target);
      return;
    }
    try {
      // did-fail-load owns the visible error. Consume the Promise rejection too,
      // including ERR_ABORTED when a newer navigation supersedes this one.
      void view.loadURL(target).catch(() => {});
    } catch {
      view.setAttribute('src', target);
    }
  }, []);

  useEffect(() => {
    // A new target from outside the panel (a link click) navigates the view.
    if (!url || url === currentRef.current) return;
    navigate(url);
  }, [url, navigate]);

  function submit() {
    const target = normalizeBrowserTarget(address);
    if (!target) {
      setFailed('请输入网址，或本地 HTML 文件（file:///.../*.html）');
      return;
    }
    setFailed('');
    setAddress(target);
    navigate(target);
  }

  return <div className="browser-panel">
    <div className="browser-toolbar">
      <button
        type="button"
        className="icon-button"
        aria-label="后退"
        title="后退"
        disabled={!nav.back}
        onClick={() => viewRef.current?.goBack()}
      ><ArrowLeft /></button>
      <button
        type="button"
        className="icon-button"
        aria-label="前进"
        title="前进"
        disabled={!nav.forward}
        onClick={() => viewRef.current?.goForward()}
      ><ArrowRight /></button>
      <button
        type="button"
        className={`icon-button ${loading ? 'is-busy' : ''}`}
        disabled={!ready}
        aria-label="刷新"
        title="刷新"
        onClick={() => viewRef.current?.reload()}
      ><RotateCw className={loading ? 'spin' : undefined} /></button>
      <form
        className="browser-address"
        onSubmit={(event) => { event.preventDefault(); submit(); }}
      >
        <Globe aria-hidden="true" />
        <input
          value={address}
          aria-label="浏览器地址"
          placeholder="输入网址"
          spellCheck={false}
          onChange={(event) => setAddress(event.target.value)}
          onFocus={(event) => event.currentTarget.select()}
        />
      </form>
      <button
        type="button"
        className="icon-button"
        aria-label="在系统浏览器打开"
        title="在系统浏览器打开"
        disabled={!/^https?:\/\//i.test(current)}
        onClick={() => { if (/^https?:\/\//i.test(current)) void window.piApi.openLink(current, 'external'); }}
      ><ExternalLink /></button>
      {onClose && <button type="button" className="icon-button" aria-label="关闭浏览器" title="关闭" onClick={onClose}><X /></button>}
    </div>
    {failed && <p className="browser-failure" role="status">{failed}</p>}
    <div className="browser-stage">
      <Webview
        ref={viewRef}
        src={initialSrc.current}
        partition="persist:pi-browser"
        webpreferences="contextIsolation=yes,sandbox=yes,nodeIntegration=no,plugins=no"
        allowpopups="false"
        className="browser-frame"
      />
    </div>
  </div>;
}
