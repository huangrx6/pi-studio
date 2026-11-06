import type { ComposerAttachment } from '../../types/chat-types';

export type ComposerDraft = {
  text: string;
  attachments: ComposerAttachment[];
};

export type ComposerDraftStore = Map<string, ComposerDraft>;
const listeners = new WeakMap<ComposerDraftStore, Set<() => void>>();

function notify(store: ComposerDraftStore): void {
  for (const listener of listeners.get(store) || []) listener();
}

export function composerDraftKeyForSession(sessionId: string): string {
  return `session:${sessionId}`;
}

export function composerDraftKeyForNew(cwd: string): string {
  return `new:${cwd}`;
}

export function emptyComposerDraft(): ComposerDraft {
  return { text: '', attachments: [] };
}

export function readComposerDraft(
  store: ComposerDraftStore,
  key: string,
): ComposerDraft {
  const saved = store.get(key);
  return saved
    ? { ...saved, attachments: [...saved.attachments] }
    : emptyComposerDraft();
}

export function saveComposerDraft(
  store: ComposerDraftStore,
  key: string,
  draft: ComposerDraft,
): void {
  if (!draft.text && draft.attachments.length === 0) {
    const changed = store.delete(key);
    if (changed) notify(store);
    return;
  }
  store.set(key, { ...draft, attachments: [...draft.attachments] });
  notify(store);
}

export function moveComposerDraft(
  store: ComposerDraftStore,
  from: string,
  to: string,
  draft: ComposerDraft,
): void {
  if (from !== to) store.delete(from);
  saveComposerDraft(store, to, draft);
}

export function clearComposerDraft(store: ComposerDraftStore, key: string): void {
  if (store.delete(key)) notify(store);
}

export function subscribeComposerDraftStore(
  store: ComposerDraftStore,
  listener: () => void,
): () => void {
  let current = listeners.get(store);
  if (!current) {
    current = new Set();
    listeners.set(store, current);
  }
  current.add(listener);
  return () => {
    current?.delete(listener);
    if (current?.size === 0) listeners.delete(store);
  };
}
