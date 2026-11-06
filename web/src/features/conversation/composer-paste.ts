import type { ComposerAttachment } from '../../types/chat-types';
import type { ComposerDraft } from './composer-drafts';

export type PendingComposerPaste = { baseText: string; offset: number; text: string };

/** Only the pasted batch becomes an attachment; the selected text is replaced. */
export function planComposerPaste(value: string, start: number, end: number, text: string): PendingComposerPaste {
  const offset = Math.max(0, Math.min(value.length, start));
  const selectionEnd = Math.max(offset, Math.min(value.length, end));
  return { baseText: value.slice(0, offset) + value.slice(selectionEnd), offset, text };
}

/** Preserve edits made while storage was pending instead of replaying an old full draft. */
export function recoverComposerPaste(currentText: string, pending: PendingComposerPaste): { text: string; appended: boolean } {
  if (currentText === pending.baseText) return {
    text: currentText.slice(0, pending.offset) + pending.text + currentText.slice(pending.offset),
    appended: false,
  };
  return {
    text: currentText ? `${currentText}${currentText.endsWith('\n') ? '\n' : '\n\n'}${pending.text}` : pending.text,
    appended: Boolean(currentText),
  };
}

/** Always append to the latest owner slot; an operation's initial array may be obsolete. */
export function mergeComposerAttachments(current: ComposerDraft, additions: ComposerAttachment[]): ComposerDraft {
  const existing = new Set(current.attachments.map(attachment => attachment.id));
  return { ...current, attachments: [...current.attachments, ...additions.filter(attachment => !existing.has(attachment.id))] };
}
