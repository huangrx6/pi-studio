import { useCallback, useEffect, useSyncExternalStore } from 'react';
import { useLayoutStores } from './layout-store';
import { emptyInspection, inspectionActivityListener, noticeInspection, restoreInspection, type Inspection } from './session-inspection';

export function useSessionInspection(id: string | undefined, onError: (message: string) => void) {
  const { getStore } = useLayoutStores('inspector', emptyInspection, restoreInspection, onError);
  const store = getStore(id ? 'conversation:' + id : '');
  const view = useSyncExternalStore(store.subscribe, store.snapshot);
  useEffect(() => { void store.read(); }, [store]);
  useEffect(() => window.piApi.onConversationEvent(inspectionActivityListener((owner, turn) => {
    getStore('conversation:' + owner).update(current => noticeInspection(current, turn), false);
  })), [getStore]);
  const patch = useCallback((next: Partial<Inspection>, owner = id) => {
    if (owner) getStore('conversation:' + owner).update(current => ({ ...current, ...next }));
  }, [getStore, id]);
  const hydrate = useCallback((turn: string) => {
    if (id) store.update(current => noticeInspection(current, turn, true), false);
  }, [id, store]);
  return { view, patch, hydrate };
}
