/**
 * In-app browser panel.
 *
 * Electron's `<webview>` keeps the page in its own process with an isolated
 * `persist:pi-browser` partition: no preload, no node integration, no popups.
 * The panel only exposes navigation controls and a URL field; every link that
 * leaves http(s) is refused by the main-process guard.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, ExternalLink, Globe, RotateCw, X } from 'lucide-react';
import { normalizeBrowserTarget } from './browser-target.mjs';

type WebviewElement = HTMLElement & {
  loadURL(url: string): void;
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
      const next = (event as { url?: string }).url;
      if (typeof next !== 'string' || !next) return;
      setCurrent(next);
      setAddress(next);
      setFailed('');
      onUrlChange?.(next);
      syncNav();
    };
    const handleReady = () => { setReady(true); };
    view.addEventListener('dom-ready', handleReady);
    const handleStart = () => { setLoading(true); };
    const handleStop = () => { setLoading(false); syncNav(); };
    const handleFail = (event: unknown) => {
      const detail = event as { errorDescription?: string; isMainFrame?: boolean };
      if (detail.isMainFrame === false) return;
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
  }, [onUrlChange, syncNav]);

  /**
   * Electron refuses `loadURL` until the element is attached and `dom-ready`
   * has fired. Fall back to the `src` attribute (which navigates on attach)
   * so a link click that arrives before the panel settles still lands.
   */
  function navigate(target: string) {
    const view = viewRef.current;
    if (!view) return;
    if (!/^(https?:\/\/|about:blank$)/i.test(target)) {
      setFailed('只支持 http(s) 链接');
      return;
    }
    if (!ready) {
      view.setAttribute('src', target);
      return;
    }
    try {
      view.loadURL(target);
    } catch {
      view.setAttribute('src', target);
    }
  }

  useEffect(() => {
    // A new target from outside the panel (a link click) navigates the view.
    if (!url || url === current) return;
    navigate(url);
    // navigate reads the latest refs and readiness; url/current drive the call.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url, current, ready]);

  function submit() {
    const target = normalizeBrowserTarget(address);
    if (!target) {
      setFailed('请输入完整网址，例如 https://example.com');
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
        onClick={() => { if (current) void window.piApi.openLink(current, 'external'); }}
      ><ExternalLink /></button>
      {onClose && <button type="button" className="icon-button" aria-label="关闭浏览器" title="关闭" onClick={onClose}><X /></button>}
    </div>
    {failed && <p className="browser-failure" role="status">{failed}</p>}
    <div className="browser-stage">
      <Webview
        ref={viewRef}
        src={url || 'about:blank'}
        partition="persist:pi-browser"
        webpreferences="contextIsolation=yes,sandbox=yes,nodeIntegration=no,plugins=no"
        allowpopups="false"
        className="browser-frame"
      />
    </div>
  </div>;
}
