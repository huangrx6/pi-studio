import { useEffect, useRef, useState } from 'react';
import { useSurfaceActive } from '../../shared/surface-visibility';
import type { ExtensionDataViewOpenRequest, ExtensionDataViewSnapshot } from '../../types/extension-types';
import { acceptsExtensionDataViewSnapshot, type OwnedExtensionDataViewSnapshot } from './extension-data-view-state';

export function useExtensionDataView(
  { sourceId, cwd, sessionId, modelRef, taskBoardQuery }: ExtensionDataViewOpenRequest,
  beforeClose?: (subscriptionId: string) => Promise<unknown> | undefined,
) {
  const surfaceActive = useSurfaceActive();
  const [owned, setOwned] = useState<OwnedExtensionDataViewSnapshot | null>(null);
  const current = useRef<OwnedExtensionDataViewSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const beforeCloseRef = useRef(beforeClose);
  beforeCloseRef.current = beforeClose;

  useEffect(() => {
    if (!surfaceActive) return;
    let disposed = false;
    let subscriptionId = '';
    const early = new Map<string, ExtensionDataViewSnapshot>();
    setLoading(!current.current);
    setError('');

    const accept = (snapshot: ExtensionDataViewSnapshot, id: string) => {
      if (snapshot.sourceId !== sourceId || !acceptsExtensionDataViewSnapshot(current.current, id, snapshot)) return;
      if (!snapshot.error || !current.current) {
        current.current = { subscriptionId: id, snapshot };
        setOwned(current.current);
      }
      setError(snapshot.error || '');
      setLoading(false);
    };
    const off = window.piApi.onExtensionDataView(event => {
      if (event.snapshot.sourceId !== sourceId) return;
      if (event.subscriptionId === subscriptionId) accept(event.snapshot, subscriptionId);
      else if (!subscriptionId && early.size < 24) early.set(event.subscriptionId, event.snapshot);
    });
    const close = async (id: string) => {
      await beforeCloseRef.current?.(id)?.catch(() => {});
      await window.piApi.closeExtensionDataView(id).catch(() => {});
    };
    void window.piApi.openExtensionDataView({ sourceId, cwd, sessionId, modelRef, taskBoardQuery }).then(opened => {
      subscriptionId = opened.subscriptionId;
      if (disposed) {
        void close(subscriptionId);
        return;
      }
      accept(opened.snapshot, subscriptionId);
      const queued = early.get(subscriptionId);
      if (queued) accept(queued, subscriptionId);
      early.clear();
    }).catch(reason => {
      if (disposed) return;
      setError(reason instanceof Error ? reason.message : String(reason));
      setLoading(false);
    });
    return () => {
      disposed = true;
      off();
      if (subscriptionId) void close(subscriptionId);
    };
  }, [attempt, cwd, modelRef, sessionId, sourceId, surfaceActive, taskBoardQuery]);

  return { owned, loading, error, retry: () => setAttempt(current => current + 1) };
}
