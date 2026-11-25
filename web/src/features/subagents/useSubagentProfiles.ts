import { useEffect, useSyncExternalStore } from 'react';
import type { SubagentProfile } from '../../types/subagent-types';
import { errorText } from '../../shared/error-text';

type Library = { rows: SubagentProfile[]; ready: boolean; error: string };
let library: Library = { rows: [], ready: false, error: '' };
let generation = 0;
let pending: Promise<void> | undefined;
const subscribers = new Set<() => void>();

function publish(next: Library) {
  library = next;
  subscribers.forEach(listener => listener());
}

export function replaceSubagentProfiles(rows: SubagentProfile[]) {
  generation++;
  pending = undefined;
  publish({ rows, ready: true, error: '' });
}

export function refreshSubagentProfiles() {
  if (pending) return pending;
  const ticket = ++generation;
  pending = Promise.resolve().then(() => window.piApi.subagentProfiles()).then(rows => {
    if (!Array.isArray(rows)) throw new Error('无法读取子智能体列表');
    if (ticket === generation) publish({ rows, ready: true, error: '' });
  }).catch(cause => {
    if (ticket === generation) publish({ ...library, error: errorText(cause) });
  }).finally(() => { if (ticket === generation) pending = undefined; });
  return pending;
}

function subscribe(listener: () => void) {
  subscribers.add(listener);
  return () => { subscribers.delete(listener); };
}
const getLibrary = () => library;

export function useSubagentProfiles(active = true) {
  const value = useSyncExternalStore(subscribe, getLibrary);
  useEffect(() => {
    if (active) void refreshSubagentProfiles();
  }, [active]);
  return value;
}
