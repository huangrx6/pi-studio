import { useSyncExternalStore } from 'react';
import type { MediaGenerationInput } from '../../types/storyboard-types';

type Generation = ReturnType<Window['piApi']['storyboardGenerateMedia']>;
const requests = new Map<string, Generation>();
const listeners = new Set<() => void>();
function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
function notify() { listeners.forEach(listener => listener()); }

// Tabs and shot editors can remount while the provider is still generating.
export function useShotMediaJob(workspace: string, workId: string, shotId: string, kind: MediaGenerationInput['kind']) {
  const key = JSON.stringify([workspace, workId, shotId, kind]);
  const pending = useSyncExternalStore(subscribe, () => requests.get(key));
  function generate(input: MediaGenerationInput): Generation {
    const running = requests.get(key);
    if (running) return running;
    const request = window.piApi.storyboardGenerateMedia(workspace, workId, input).finally(() => {
      requests.delete(key);
      notify();
    });
    requests.set(key, request);
    notify();
    return request;
  }
  return { pending, generate };
}
