import { Component, lazy, Suspense, useRef, type ReactNode } from 'react';
import { PencilRuler, RefreshCw } from 'lucide-react';
import { LoadingState } from '../../shared/LoadingState';
import type { ExtensionDataViewOpenRequest } from '../../types/extension-types';
import { extensionDataViewRequestKey } from './extension-data-view-state';
import { presentExtensionDataViewError } from './extension-data-view-error';
import { useExtensionDataView } from './use-extension-data-view';
import './styles/extension-canvas.css';

const ExcalidrawCanvas = lazy(() => {
  Object.assign(window, { EXCALIDRAW_ASSET_PATH: new URL('./excalidraw-assets/', document.baseURI).href });
  return import('./ExcalidrawCanvas');
});

class CanvasErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  render() {
    if (this.state.failed) return <div className="extension-page-empty" role="alert">
      <PencilRuler aria-hidden />
      <strong>画布暂时无法打开</strong>
      <span>可以关闭此标签页，继续使用对话。</span>
    </div>;
    return this.props.children;
  }
}

function CanvasConnection({ title, ...request }: ExtensionDataViewOpenRequest & { title: string }) {
  const writes = useRef(new Map<string, Promise<void>>());
  const { owned, loading, error, retry } = useExtensionDataView(request, id => writes.current.get(id));
  const board = owned?.snapshot.canvas;
  return <section className="extension-canvas-panel" aria-label={title + ' 画布'}>
    {error && <div className="extension-canvas-feedback" role="status">
      <span>{presentExtensionDataViewError(error).title}</span>
      <button className="icon-button" type="button" title="重新连接画布" aria-label="重新连接画布" onClick={retry}>
        <RefreshCw aria-hidden />
      </button>
    </div>}
    {owned && board ? <Suspense fallback={<LoadingState variant="panel">正在打开画布…</LoadingState>}>
      <ExcalidrawCanvas key={owned.subscriptionId} board={board} subscriptionId={owned.subscriptionId}
        writable={!error && owned.snapshot.canvasWritable === true} writes={writes.current} />
    </Suspense> : loading && <LoadingState variant="panel">正在连接画布…</LoadingState>}
  </section>;
}

export function ExtensionCanvasPanel({ generation, title, ...request }: ExtensionDataViewOpenRequest & {
  title: string;
  generation: number;
}) {
  if (!request.sessionId) return <div className="extension-page-empty">
    <PencilRuler aria-hidden />
    <strong>打开聊天后开始绘图</strong>
    <span>每段聊天都有自己的画布。</span>
  </div>;
  return <CanvasErrorBoundary key={`${generation}:${extensionDataViewRequestKey(request.sourceId, request.cwd, request.sessionId)}`}>
    <CanvasConnection title={title} {...request} />
  </CanvasErrorBoundary>;
}
