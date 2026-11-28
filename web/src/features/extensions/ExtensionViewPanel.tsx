import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type MutableRefObject } from 'react';
import { RefreshCw } from 'lucide-react';
import { studioViewTokens, type PiStudioViewHostContext, type PiStudioViewTheme } from '../../../../sdk/extensions/view-theme.mjs';
import { errorText } from '../../shared/error-text';
import { LoadingState } from '../../shared/LoadingState';
import type { ExtensionViewUiDescriptor } from '../../types/extension-types';
import type { ExtensionNotice } from './ExtensionSlot';
import { useExtensionDataView } from './use-extension-data-view';
import './styles/extension-view.css';

const PROTOCOL = 'pi-studio:ext-view:v1';

function readHostTheme(): PiStudioViewTheme {
  const root = document.documentElement;
  const computed = getComputedStyle(root);
  const tokens: Record<string, string> = {};
  for (const name of studioViewTokens) {
    const value = computed.getPropertyValue(name).trim();
    if (value) tokens[name] = value;
  }
  return { theme: root.dataset.theme === 'dark' ? 'dark' : 'light', tokens };
}

export type ExtensionViewWorkspace = { name: string; path: string };
export type ExtensionViewSize = { url: string; height: number };

export type OpenTemporaryChatOptions = {
  prompt?: string;
  autoSubmit?: boolean;
  title?: string;
};

type ViewConnectionProps = {
  view: ExtensionViewUiDescriptor;
  title: string;
  cwd?: string;
  sessionId?: string;
  workspaces: ExtensionViewWorkspace[];
  onSendPrompt?: (text: string, submit: boolean) => void;
  onOpenTemporaryChat?: (options?: OpenTemporaryChatOptions) => void;
  onNotify?: (notice: ExtensionNotice) => void;
  onClose?: () => void;
  compactSize?: MutableRefObject<ExtensionViewSize | undefined>;
};

function ExtensionViewConnection({
  view,
  title,
  cwd,
  sessionId,
  workspaces,
  onSendPrompt,
  onOpenTemporaryChat,
  onNotify,
  onClose,
  compactSize,
}: ViewConnectionProps) {
  const [viewParams, setViewParams] = useState<Record<string, unknown>>({});
  const [appearance, setAppearance] = useState(readHostTheme);
  const [frameReady, setFrameReady] = useState(false);
  const [frameLoaded, setFrameLoaded] = useState(false);
  const [contentHeight, setContentHeight] = useState(() =>
    compactSize?.current?.url === view.url ? compactSize.current.height : undefined);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const pendingInvokesRef = useRef(new Map<string, Set<Promise<unknown>>>());
  const lastContextKeyRef = useRef('');
  const lastSnapshotRef = useRef<{
    loading: boolean;
    error: string;
    revision: number;
    invocable: boolean;
    data: unknown;
  } | null>(null);

  const scopedCwd = view.scope === 'global' ? '' : (cwd || '');
  const scopedSessionId = view.scope === 'global' ? '' : (sessionId || '');
  const workspacesKey = useMemo(
    () => JSON.stringify(workspaces.map(item => [item.name, item.path])),
    [workspaces],
  );
  const stableWorkspaces = useMemo<ExtensionViewWorkspace[]>(
    () => (JSON.parse(workspacesKey) as Array<[string, string]>).map(([name, path]) => ({ name, path })),
    [workspacesKey],
  );

  const { owned, error, loading, retry } = useExtensionDataView(
    {
      sourceId: view.sourceId,
      ...(view.scope === 'global' ? {} : { cwd, sessionId }),
      viewParams,
    },
    id => {
      const pending = pendingInvokesRef.current.get(id);
      return pending?.size ? Promise.allSettled([...pending]) : undefined;
    },
  );
  const frameVisible = (frameReady || frameLoaded) && (!compactSize || !loading);

  const expectedOrigin = useMemo(() => {
    try { return new URL(view.url).origin; } catch { return ''; }
  }, [view.url]);

  const postToView = useCallback((message: Record<string, unknown>) => {
    const target = iframeRef.current?.contentWindow;
    if (!target) return;
    target.postMessage({ protocol: PROTOCOL, ...message }, '*');
  }, []);

  const invocable = !error && owned?.snapshot.viewInvocable === true;
  const contextPayload = useMemo<Omit<PiStudioViewHostContext, 'protocol'>>(() => ({
    type: 'host:context',
    ...appearance,
    scope: view.scope,
    cwd: scopedCwd,
    sessionId: scopedSessionId,
    workspaces: stableWorkspaces,
    invocable,
  }), [appearance, invocable, scopedCwd, scopedSessionId, stableWorkspaces, view.scope]);

  const contextKey = useMemo(() => JSON.stringify(contextPayload), [contextPayload]);

  const pushContext = useCallback((force = false) => {
    if (!force && lastContextKeyRef.current === contextKey) return;
    lastContextKeyRef.current = contextKey;
    postToView(contextPayload);
  }, [contextKey, contextPayload, postToView]);

  const pushSnapshot = useCallback((force = false) => {
    const data = owned?.snapshot.viewData ?? null;
    const revision = owned?.snapshot.revision ?? 0;
    const prev = lastSnapshotRef.current;
    if (
      !force
      && prev
      && prev.loading === loading
      && prev.error === (error || '')
      && prev.revision === revision
      && prev.invocable === invocable
      && prev.data === data
    ) {
      return;
    }
    lastSnapshotRef.current = { loading, error: error || '', revision, invocable, data };
    postToView({
      type: 'host:snapshot',
      loading,
      error: error || '',
      revision,
      invocable,
      data,
    });
  }, [error, invocable, loading, owned?.snapshot.revision, owned?.snapshot.viewData, postToView]);

  useLayoutEffect(() => {
    const refresh = () => setAppearance(readHostTheme());
    const observer = new MutationObserver(refresh);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme', 'data-palette', 'data-radius', 'style', 'class'],
    });
    refresh();
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!frameReady) return;
    pushContext();
  }, [frameReady, pushContext]);

  useEffect(() => {
    if (!frameReady) return;
    pushSnapshot();
  }, [frameReady, pushSnapshot]);

  const ownedRef = useRef(owned);
  ownedRef.current = owned;
  const callbacksRef = useRef({ onSendPrompt, onOpenTemporaryChat, onNotify, onClose, retry, pushContext, pushSnapshot });
  callbacksRef.current = { onSendPrompt, onOpenTemporaryChat, onNotify, onClose, retry, pushContext, pushSnapshot };

  useLayoutEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const frameWindow = iframeRef.current?.contentWindow;
      if (!frameWindow || event.source !== frameWindow) return;
      if (expectedOrigin && event.origin && event.origin !== 'null' && event.origin !== expectedOrigin) return;
      const payload = event.data;
      if (!payload || typeof payload !== 'object' || payload.protocol !== PROTOCOL) return;

      if (payload.type === 'view:ready') {
        setFrameReady(true);
        callbacksRef.current.pushContext(true);
        callbacksRef.current.pushSnapshot(true);
        return;
      }

      if (payload.type === 'view:retry') {
        callbacksRef.current.retry();
        return;
      }

      if (payload.type === 'view:close') {
        callbacksRef.current.onClose?.();
        return;
      }
      if (payload.type === 'view:resize' && compactSize && Number.isSafeInteger(payload.height) && payload.height > 0) {
        const height = Math.min(560, payload.height);
        compactSize.current = { url: view.url, height };
        setContentHeight(height);
        return;
      }

      if (payload.type === 'view:query') {
        const next = payload.params && typeof payload.params === 'object' && !Array.isArray(payload.params)
          ? payload.params as Record<string, unknown>
          : {};
        setViewParams(next);
        return;
      }

      if (payload.type === 'view:notify') {
        const message = typeof payload.message === 'string' ? payload.message.trim().slice(0, 500) : '';
        const tone = payload.tone === 'success' || payload.tone === 'warning' || payload.tone === 'error'
          ? payload.tone : 'info';
        if (message) callbacksRef.current.onNotify?.({ message, tone });
        return;
      }

      if (payload.type === 'view:sendPrompt') {
        const prompt = typeof payload.prompt === 'string' ? payload.prompt.trim().slice(0, 32_000) : '';
        if (prompt) callbacksRef.current.onSendPrompt?.(prompt, payload.submit === true);
        return;
      }

      if (payload.type === 'view:openTemporaryChat') {
        const prompt = typeof payload.prompt === 'string' ? payload.prompt.trim().slice(0, 32_000) : undefined;
        const titleText = typeof payload.title === 'string' ? payload.title.trim().slice(0, 60) : undefined;
        callbacksRef.current.onOpenTemporaryChat?.({
          prompt,
          autoSubmit: payload.autoSubmit === true,
          title: titleText,
        });
        return;
      }

      if (payload.type === 'view:invoke') {
        const requestId = typeof payload.requestId === 'string' ? payload.requestId : '';
        const method = typeof payload.method === 'string' ? payload.method : '';
        const currentOwned = ownedRef.current;
        if (!requestId) return;
        if (!currentOwned?.subscriptionId || !currentOwned.snapshot.viewInvocable) {
          postToView({ type: 'host:response', requestId, ok: false, error: '插件数据源当前不可写' });
          return;
        }
        const subId = currentOwned.subscriptionId;
        const invokePromise = window.piApi.invokeExtensionView({
          subscriptionId: subId,
          method,
          params: payload.params,
        });
        let set = pendingInvokesRef.current.get(subId);
        if (!set) {
          set = new Set();
          pendingInvokesRef.current.set(subId, set);
        }
        set.add(invokePromise);
        void invokePromise.then(
          result => postToView({ type: 'host:response', requestId, ok: true, result }),
          reason => postToView({ type: 'host:response', requestId, ok: false, error: errorText(reason) }),
        ).finally(() => {
          set?.delete(invokePromise);
          if (set && set.size === 0) pendingInvokesRef.current.delete(subId);
        });
      }
    };

    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [expectedOrigin, compactSize, postToView, view.url]);

  return <section className="extension-view-panel" aria-label={title}
    style={compactSize && contentHeight ? { height: contentHeight } : undefined}>
    {!frameVisible && !error && <LoadingState variant="panel" className="extension-view-loading">正在加载…</LoadingState>}
    {error && !frameReady && <div className="extension-view-feedback" role="status">
      <span>插件视图暂时无法读取：{error}</span>
      <button type="button" className="icon-button" aria-label="重新连接插件视图" onClick={retry}>
        <RefreshCw aria-hidden="true" />
      </button>
    </div>}
    <iframe
      ref={iframeRef}
      className={`extension-view-frame${frameVisible ? ' is-ready' : ''}`}
      src={view.url}
      title={title}
      sandbox="allow-scripts allow-downloads"
      onLoad={() => setFrameLoaded(true)}
    />
  </section>;
}

export function ExtensionViewPanel(props: ViewConnectionProps & { generation: number }) {
  const { generation, ...rest } = props;
  const resetKey = props.view.scope === 'global'
    ? `${props.view.url}:${generation}`
    : `${props.view.url}:${props.cwd ?? ''}:${props.sessionId ?? ''}:${generation}`;
  return <ExtensionViewConnection key={resetKey} {...rest} />;
}
