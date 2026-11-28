import { useMemo, useSyncExternalStore } from 'react';
import { errorText } from '../shared/error-text';
import { previews, readDocumentFile, type DocumentPreview, type FileTab } from './session-file';

// Both groups subscribe to the same read, disk notification and saved revision.
function createResource(key: string, tab: FileTab) {
  let snapshot: { file?: DocumentPreview; error?: string } = { file: previews.get(key) };
  const listeners = new Set<() => void>();
  let revision = 0;
  let stop: (() => void) | undefined, stopRefresh: (() => void) | undefined;
  let pendingChanges: Set<string> | undefined;
  function publish(next: typeof snapshot) { snapshot = next; listeners.forEach(notify => notify()); }
  async function refresh() {
    const current = ++revision;
    const token = previews.begin(key);
    const changes = new Set<string>();
    pendingChanges = changes;
    try {
      const file = await readDocumentFile(tab);
      if (current !== revision) return;
      if (file.changeKey && changes.has(file.changeKey)) { void refresh(); return; }
      previews.put(key, token, file);
      publish({ file });
    } catch (error) {
      if (current === revision) publish({ ...snapshot, error: errorText(error) });
    } finally {
      previews.finish(key, token);
      if (current === revision) pendingChanges = undefined;
    }
  }
  const resource = {
    snapshot: () => snapshot, refresh,
    subscribe(notify: () => void) {
      listeners.add(notify);
      if (listeners.size === 1) {
        resources.set(key, resource);
        stop = window.piApi.onFilesChanged?.(keys => {
          keys.forEach(value => pendingChanges?.add(value));
          if (snapshot.file?.changeKey && keys.includes(snapshot.file.changeKey)) void refresh();
        });
        stopRefresh = window.piApi.onWorkbenchRefresh?.(event => {
          if (event.scope === 'all' || event.scope === 'files') void refresh();
        });
        void refresh();
      }
      return () => {
        listeners.delete(notify);
        if (!listeners.size) {
          ++revision;
          stop?.();
          stopRefresh?.();
          if (resources.get(key) === resource) resources.delete(key);
        }
      };
    },
    async save(text: string, expectedText: string) {
      await window.piApi.writeFile({ cwd: tab.cwd, path: tab.path, text, expectedText });
      if (snapshot.file && listeners.size) {
        publish({ file: { ...snapshot.file, text } });
        void refresh();
      } else {
        previews.drop(key);
        void resources.get(key)?.refresh();
      }
    },
  };
  return resource;
}
const resources = new Map<string, ReturnType<typeof createResource>>();
export function useDocumentFile(owner: string, tab: FileTab) {
  const key = JSON.stringify([owner, tab.id]);
  const resource = useMemo(() => {
    let current = resources.get(key);
    if (!current) { current = createResource(key, tab); resources.set(key, current); }
    return current;
  }, [key]);
  const state = useSyncExternalStore(resource.subscribe, resource.snapshot);
  return { ...state, refresh: resource.refresh, save: resource.save };
}
