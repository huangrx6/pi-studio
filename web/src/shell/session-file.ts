import type { FilePreviewResult } from '../types/file-preview-types';
import type { ContentTab } from './session-layout';
import { createDocumentCache } from './document-cache.ts';

export type FileTab = Extract<ContentTab, { kind: 'file' }>;
export type DocumentPreview = FilePreviewResult & { source: FileTab['source']; actionPath: string };
export const previews = createDocumentCache<DocumentPreview>();
type Draft = { base: FilePreviewResult; text: string };
const drafts = new Map<string, Draft>();
const listeners = new Set<() => void>();
let draftRevision = 0;
function changedDraft() { draftRevision++; listeners.forEach(notify => notify()); }
export const documentDrafts = {
  get: (key: string) => drafts.get(key),
  set(key: string, draft: Draft) {
    const old = drafts.get(key);
    if (old?.text === draft.text && old.base === draft.base) return;
    drafts.set(key, draft); changedDraft();
  },
  delete(key: string) { if (drafts.delete(key)) changedDraft(); },
  subscribe(notify: () => void) { listeners.add(notify); return () => { listeners.delete(notify); }; },
  revision: () => draftRevision,
  inWorkspace(owner: string, cwd: string) {
    const result: { path: string; text: string }[] = [];
    for (const [key, draft] of drafts) {
      const [scope, id] = JSON.parse(key);
      if (scope !== owner) continue;
      const [, root, source, path] = JSON.parse(id);
      if (root === cwd && source === 'workspace' && /\.[cm]?[jt]sx?$/i.test(path)) result.push({ path, text: draft.text });
    }
    return result;
  },
};

export async function readDocumentFile(tab: FileTab, api = window.piApi): Promise<DocumentPreview> {
  async function external() {
    const file = await api.filePreviewAbsolute({ cwd: tab.cwd, sessionId: tab.sessionId, path: tab.path });
    return { ...file, source: 'external' as const, actionPath: file.path };
  }
  if (tab.source === 'external') return external();
  if (tab.source === 'workspace') {
    const file = await api.filePreview(tab.cwd, tab.path);
    return { ...file, source: tab.source, actionPath: tab.path };
  }
  if (tab.source === 'diff') {
    try {
      const data = await api.turnDiffAbsoluteFile({ sessionId: tab.sessionId!, path: tab.path });
      return {
        ...data,
        name: tab.title,
        mimeType: '',
        kind: data.binary ? 'binary' : 'text',
        source: tab.source,
        actionPath: tab.path,
      };
    } catch {
      return external();
    }
  }
  const data = await api.attachmentFile({ path: tab.path });
  return {
    ...data,
    name: tab.title,
    mimeType: '',
    kind: data.binary ? 'binary' : 'text',
    source: tab.source,
    actionPath: tab.path,
  };
}
