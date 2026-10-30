import type { ComposerAttachment } from '../types/chat-types';
import type { ConversationKind } from '../types/durable-types';

export type ComposerDraft = {
  text: string;
  attachments: ComposerAttachment[];
  kind: ConversationKind;
};

export type ComposerDraftStore = Map<string, ComposerDraft>;

export function composerDraftKeyForSession(sessionId: string): string {
  return `session:${sessionId}`;
}

export function composerDraftKeyForNew(cwd: string): string {
  return `new:${cwd}`;
}

export function emptyComposerDraft(kind: ConversationKind): ComposerDraft {
  return { text: '', attachments: [], kind };
}

export function readComposerDraft(
  store: ComposerDraftStore,
  key: string,
  fallbackKind: ConversationKind,
): ComposerDraft {
  const saved = store.get(key);
  return saved
    ? { ...saved, attachments: [...saved.attachments] }
    : emptyComposerDraft(fallbackKind);
}

export function saveComposerDraft(
  store: ComposerDraftStore,
  key: string,
  draft: ComposerDraft,
): void {
  if (!draft.text && draft.attachments.length === 0 && draft.kind === 'conversation') {
    store.delete(key);
    return;
  }
  store.set(key, { ...draft, attachments: [...draft.attachments] });
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
  store.delete(key);
}
