import type { ShotPatch, StoryboardBrief, StoryboardWork } from '../../types/storyboard-types';
import { errorText } from '../../shared/error-text.ts';

// Keep pending edits alive across closing a tab, changing workspace or switching the split layout.
type Writer<T> = {
  workspace: string; workId: string; flush: () => Promise<void>; pending: () => Partial<T>;
  status: () => string; failed: () => boolean; edit: (next: Partial<T>) => void;
  subscribe: (callback: () => void) => () => void;
};
const briefs = new Map<string, Writer<StoryboardBrief>>();
const shots = new Map<string, Writer<ShotPatch>>();
function createWriter<T>(workspace: string, workId: string, writers: Map<string, Writer<T>>, key: string, save: (patch: Partial<T>) => Promise<unknown>): Writer<T> {
  let patch: Partial<T> = {};
  let sending: Partial<T> = {};
  let inFlight: Promise<void> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let error = '';
  const listeners = new Set<() => void>();
  const notify = () => listeners.forEach(listener => listener());

  function flush(): Promise<void> {
    clearTimeout(timer);
    if (inFlight) return inFlight;
    if (!Object.keys(patch).length) return Promise.resolve();
    error = '';
    inFlight = (async () => {
      while (Object.keys(patch).length) {
        sending = patch;
        patch = {};
        try {
          await save(sending);
        } catch (cause) {
          patch = { ...sending, ...patch };
          error = errorText(cause);
          break;
        } finally { sending = {}; }
      }
    })().finally(() => {
      inFlight = undefined;
      if (!Object.keys(patch).length && writers.get(key) === writer) writers.delete(key);
      notify();
    });
    notify();
    return inFlight;
  }

  const writer = {
    workspace, workId, flush,
    pending: () => ({ ...sending, ...patch }),
    status: () => error || (inFlight || Object.keys(patch).length ? '正在保存…' : '已保存'),
    failed: () => Boolean(error),
    edit(next: Partial<T>) {
      writers.set(key, writer);
      Object.assign(patch, next);
      error = '';
      clearTimeout(timer);
      timer = setTimeout(flush, 350);
      notify();
    },
    subscribe(callback: () => void) {
      listeners.add(callback);
      return () => {
        listeners.delete(callback);
        void flush();
      };
    },
  };
  return writer;
}

export function briefWriter(workspace: string, id: string) {
  const key = JSON.stringify([workspace, id]);
  return briefs.get(key) ?? createWriter(workspace, id, briefs, key, patch => window.piApi.storyboardEditBrief(workspace, id, patch));
}

export function shotWriter(workspace: string, id: string, shotId: string, onWork: (work: StoryboardWork) => void) {
  const key = JSON.stringify([workspace, id, shotId]);
  return shots.get(key) ?? createWriter(workspace, id, shots, key, async patch => {
    const work = await window.piApi.storyboardEditShot(workspace, id, shotId, patch);
    onWork(work);
  });
}

export async function settleStoryboardDrafts(workspace: string, workId?: string) {
  const pending = [...briefs.values(), ...shots.values()].filter(writer => writer.workspace === workspace && (!workId || writer.workId === workId));
  await Promise.all(pending.map(writer => writer.flush()));
  const failed = pending.find(writer => writer.failed());
  if (workId && failed) throw new Error(failed.status());
}
