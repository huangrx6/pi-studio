import { useCallback, useEffect, useRef, useState } from 'react';
import { ExternalLink, Maximize2, Minimize2, Monitor, Pause, Play, RefreshCw, X } from 'lucide-react';
import './styles/desktop-control-preview.css';

type PreviewCursor = {
  normX: number;
  normY: number;
  kind: 'click' | 'type' | 'scroll' | 'drag';
};

type PreviewPanel = { windowId: number; imageDataUrl: string; imageWidth?: number | null; imageHeight?: number | null };

type DesktopPreviewState = {
  runId?: string;
  panels?: PreviewPanel[];
  sessionId: string;
  appName: string;
  bundleId: string;
  windowId: number;
  title: string;
  action: string;
  status: 'active' | 'idle' | 'error';
  staged?: boolean;
  errorMessage?: string;
  overlayCount?: number;
  bounds?: { x: number; y: number; width: number; height: number } | null;
  cursor?: PreviewCursor | null;
  cursorSeq: number;
  imageDataUrl?: string;
  imageWidth?: number | null;
  imageHeight?: number | null;
  updatedAt: number;
};

type DesktopControlPreviewProps = {
  sessionId?: string;
  turnActive: boolean;
  visible: boolean;
};

const LIVE_POLL_INTERVAL_MS = 1200;

export function DesktopControlPreview({ sessionId, turnActive, visible }: DesktopControlPreviewProps) {
  if (!visible || !turnActive || !sessionId) return null;
  return <LiveWindowPreview key={sessionId} sessionId={sessionId} />;
}

function LiveWindowPreview({ sessionId }: { sessionId: string }) {
  const [preview, setPreview] = useState<DesktopPreviewState>();
  const [isDismissed, setDismissed] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [minimized, setMinimized] = useState(false);
  const [livePaused, setLivePaused] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const inFlightRef = useRef(false);
  const frameRevision = useRef(0);
  const lastRun = useRef({ generation: 0, closed: false });
  const cursorSeqRef = useRef(0);

  // Subscribe to main-process desktop-control preview push events.
  useEffect(() => {
    const subscribe = window.piApi?.onDesktopControlPreview;
    if (typeof subscribe !== 'function') return undefined;
    return subscribe((event) => {
      if (!event || event.sessionId !== sessionId) return;
      if (event.runId) {
        const generation = Number(event.runId);
        if (generation < lastRun.current.generation ||
            (generation === lastRun.current.generation && lastRun.current.closed)) return;
        lastRun.current = { generation, closed: event.status === 'closed' };
      }
      frameRevision.current++;
      if (event.status === 'closed') {
        setPreview(previous => previous?.runId === event.runId ? undefined : previous);
        return;
      }
      if (!event.windowId) return;
      const { status } = event;
      const cursorSeq = event.cursor ? ++cursorSeqRef.current : cursorSeqRef.current;
      setPreview(previous => {
        const prev = previous?.windowId === event.windowId && (!event.runId || previous.runId === event.runId)
          ? previous : undefined;
        // An explicit focus reply may arrive after its floating preview closed.
        if (!event.runId && !prev) return previous;
        return {
          sessionId,
          runId: event.runId || prev?.runId,
          appName: event.appName || prev?.appName || '桌面窗口',
          bundleId: event.bundleId || prev?.bundleId || '',
          windowId: event.windowId,
          title: event.title || prev?.title || '',
          action: event.action || prev?.action || '实时预览',
          status,
          staged: event.staged ?? prev?.staged,
          errorMessage: event.errorMessage,
          overlayCount: event.overlayCount ?? prev?.overlayCount,
          bounds: event.bounds || prev?.bounds || null,
          cursor: event.cursor !== undefined ? event.cursor : prev?.cursor,
          cursorSeq,
          imageDataUrl: event.imageDataUrl || prev?.imageDataUrl,
          imageWidth: event.imageWidth || prev?.imageWidth,
          imageHeight: event.imageHeight || prev?.imageHeight,
          panels: event.imageDataUrl ? event.panels : prev?.panels,
          updatedAt: event.updatedAt || Date.now(),
        };
      });
      setDismissed(false);
    });
  }, [sessionId]);

  const captureOnce = useCallback(async (target: DesktopPreviewState) => {
    if (inFlightRef.current) return;
    if (typeof window.piApi?.desktopControlPreviewCapture !== 'function') return;
    const revision = frameRevision.current;
    inFlightRef.current = true;
    setRefreshing(true);
    try {
      const res = await window.piApi.desktopControlPreviewCapture({
        appName: target.appName,
        bundleId: target.bundleId,
        windowId: target.windowId,
        sessionId: target.sessionId,
        maxEdge: expanded ? 920 : 640,
      });
      if (res && res.ok && res.imageDataUrl) {
        if (frameRevision.current !== revision) return;
        setPreview(prev => {
          if (!prev || prev.windowId !== target.windowId || prev.runId !== target.runId) return prev;
          return {
            ...prev,
            title: res.title || prev.title,
            bounds: res.bounds || prev.bounds,
            overlayCount: res.overlayCount ?? 0,
            imageDataUrl: res.imageDataUrl,
            imageWidth: res.imageWidth || prev.imageWidth,
            imageHeight: res.imageHeight || prev.imageHeight,
            panels: res.panels,
            status: prev.status === 'error' ? 'idle' : prev.status,
            errorMessage: undefined,
            updatedAt: res.updatedAt || Date.now(),
          };
        });
      }
    } catch {
      /* ignore transient background capture failures */
    } finally {
      inFlightRef.current = false;
      setRefreshing(false);
    }
  }, [expanded]);

  useEffect(() => {
    if (!preview || isDismissed || minimized || livePaused) return undefined;
    const timer = window.setInterval(() => void captureOnce(preview), LIVE_POLL_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [preview, isDismissed, minimized, livePaused, captureOnce]);

  if (!preview || isDismissed) return null;
  const isLive = !livePaused;

  const handleFocusApp = () => {
    if (typeof window.piApi?.desktopControlFocusWindow !== 'function') return;
    void window.piApi.desktopControlFocusWindow({
      appName: preview.appName,
      bundleId: preview.bundleId,
      windowId: preview.windowId,
      sessionId: preview.sessionId,
    });
  };

  if (minimized) {
    return (
      <div className="desktop-pip-pill" role="region" aria-label={`桌面操控预览：${preview.appName}`}>
        <button
          type="button"
          className="desktop-pip-pill-main"
          onClick={() => setMinimized(false)}
          title="展开实时窗口预览"
        >
          <span className={`desktop-pip-dot${preview.status === 'error' ? ' is-error' : isLive ? ' is-live' : ''}`} aria-hidden="true" />
          <Monitor aria-hidden="true" />
          <span className="desktop-pip-pill-name">{preview.appName}</span>
          <span className="desktop-pip-pill-action">{preview.action}</span>
        </button>
        <button
          type="button"
          className="desktop-pip-icon-btn"
          aria-label="关闭预览"
          title="关闭预览"
          onClick={() => setDismissed(true)}
        >
          <X aria-hidden="true" />
        </button>
      </div>
    );
  }

  return (
    <aside
      className={`desktop-pip-card${expanded ? ' is-expanded' : ''}`}
      aria-label={`桌面操控实时预览：${preview.appName}`}
    >
      <header className="desktop-pip-head">
        <div className="desktop-pip-identity">
          <span className={`desktop-pip-dot${preview.status === 'error' ? ' is-error' : isLive ? ' is-live' : ''}`} aria-hidden="true" />
          <strong title={preview.title || preview.appName}>{preview.appName}</strong>
          {preview.staged && (
            <span className="desktop-pip-stage-tag" title="正在独立虚拟显示器中后台操作，不影响主屏">
              后台舞台
            </span>
          )}
          <span className="desktop-pip-badge">
            {preview.action}
            {preview.overlayCount && preview.overlayCount > 0 ? ` · +${preview.overlayCount} 浮层` : ''}
          </span>
        </div>
        <div className="desktop-pip-tools">
          <button
            type="button"
            className="desktop-pip-icon-btn"
            aria-label="刷新画面"
            title="立即刷新窗口画面"
            disabled={refreshing}
            onClick={() => void captureOnce(preview)}
          >
            <RefreshCw className={refreshing ? 'spin' : undefined} aria-hidden="true" />
          </button>
          <button
            type="button"
            className="desktop-pip-icon-btn"
            aria-label={livePaused ? '继续实时预览' : '暂停实时预览'}
            title={livePaused ? '继续实时预览' : '暂停实时预览'}
            onClick={() => setLivePaused((value) => !value)}
          >
            {livePaused ? <Play aria-hidden="true" /> : <Pause aria-hidden="true" />}
          </button>
          <button
            type="button"
            className="desktop-pip-icon-btn"
            aria-label={preview.staged ? '移回主屏并切到前台' : '切到目标窗口'}
            title={preview.staged ? '将窗口移回主屏并切到前台' : '将目标应用切到前台'}
            onClick={handleFocusApp}
          >
            <ExternalLink aria-hidden="true" />
          </button>
          <button
            type="button"
            className="desktop-pip-icon-btn"
            aria-label={expanded ? '缩小预览' : '放大预览'}
            title={expanded ? '缩小预览' : '放大预览'}
            onClick={() => setExpanded((value) => !value)}
          >
            {expanded ? <Minimize2 aria-hidden="true" /> : <Maximize2 aria-hidden="true" />}
          </button>
          <button
            type="button"
            className="desktop-pip-icon-btn"
            aria-label="收起为胶囊"
            title="收起"
            onClick={() => setMinimized(true)}
          >
            <X aria-hidden="true" />
          </button>
        </div>
      </header>

      <div
        className="desktop-pip-stage"
        onClick={handleFocusApp}
        title={preview.staged ? '点击将窗口移回主屏并切到前台' : '点击将目标应用切到前台'}
      >
        {preview.imageDataUrl ? (
          <img
            className="desktop-pip-image"
            src={preview.imageDataUrl}
            alt={`${preview.appName} 实时画面`}
            draggable={false}
          />
        ) : (
          <div className="desktop-pip-placeholder">
            <Monitor aria-hidden="true" />
            <span>等待窗口画面…</span>
          </div>
        )}
        {preview.cursor && (
          <span
            key={preview.cursorSeq}
            className="desktop-pip-cursor"
            style={{
              left: `${(preview.cursor.normX / 1000) * 100}%`,
              top: `${(preview.cursor.normY / 1000) * 100}%`,
            }}
            aria-hidden="true"
          >
            <span className="desktop-pip-cursor-ring" />
            <span className="desktop-pip-cursor-dot" />
          </span>
        )}
      </div>

      {preview.panels && preview.panels.length > 0 && (
        <div className="desktop-pip-panels">
          {preview.panels.map(panel => (
            <img key={panel.windowId} src={panel.imageDataUrl} alt={`${preview.appName} 弹出面板`}
              width={panel.imageWidth ?? undefined} height={panel.imageHeight ?? undefined} draggable={false} />
          ))}
        </div>
      )}

      {preview.errorMessage && (
        <div className="desktop-pip-note" role="status" title={preview.errorMessage}>
          {preview.errorMessage}
        </div>
      )}
    </aside>
  );
}
