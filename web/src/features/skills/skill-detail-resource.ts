import type { FilePreviewResult } from '../../types/file-preview-types';
import { errorText } from '../../shared/error-text';

type Entry = { name: string; path: string; type: 'file' | 'directory'; size: number };
export type SkillDetailResourceState = {
  treePath: string; entries: Entry[]; treeBusy: boolean; treeError: string | null;
  filePath: string; file: FilePreviewResult | null; fileBusy: boolean; fileError: string | null;
  externalError: string | null;
};
export function emptySkillDetailState(): SkillDetailResourceState {
  return { treePath: '', entries: [], treeBusy: true, treeError: null, filePath: '', file: null, fileBusy: false, fileError: null, externalError: null };
}

/** One dialog owns its reads. Disposal invalidates all late responses. */
export function createSkillDetailResource({ baseDir, api, onChange }: {
  baseDir: string;
  api: Pick<Window['piApi'], 'files' | 'filePreview' | 'openWith'>;
  onChange: (state: SkillDetailResourceState) => void;
}) {
  let active = true;
  let treeRequest = 0, fileRequest = 0, externalRequest = 0;
  let state = emptySkillDetailState();
  function update(patch: Partial<SkillDetailResourceState>) {
    if (!active) return;
    state = { ...state, ...patch };
    onChange(state);
  }
  async function openFile(path: string) {
    if (!active) return;
    const request = ++fileRequest;
    externalRequest++;
    update({ filePath: path, file: null, fileBusy: true, fileError: null, externalError: null });
    try {
      const file = await api.filePreview(baseDir, path);
      if (active && request === fileRequest) update({ file });
    } catch (cause) {
      if (active && request === fileRequest) update({ fileError: errorText(cause) });
    } finally {
      if (active && request === fileRequest) update({ fileBusy: false });
    }
  }
  async function loadDirectory(path: string) {
    if (!active) return;
    const request = ++treeRequest;
    update({ treePath: path, entries: [], treeBusy: true, treeError: null });
    try {
      const result = await api.files(baseDir, path);
      if (!active || request !== treeRequest) return;
      update({ treePath: result.path, entries: result.entries });
      if (!path && fileRequest === 0 && result.entries.some(entry => entry.type === 'file' && entry.path === 'SKILL.md')) {
        void openFile('SKILL.md');
      }
    } catch (cause) {
      if (active && request === treeRequest) update({ treeError: errorText(cause) });
    } finally {
      if (active && request === treeRequest) update({ treeBusy: false });
    }
  }
  async function openExternal(file: FilePreviewResult) {
    if (!active || file !== state.file) return;
    const request = ++externalRequest;
    const owner = fileRequest;
    update({ externalError: null });
    try { await api.openWith({ cwd: baseDir, path: file.path, source: 'workspace' }); }
    catch (cause) {
      if (active && owner === fileRequest && request === externalRequest) update({ externalError: errorText(cause) });
    }
  }
  return {
    loadDirectory, openFile, openExternal,
    retryDirectory: () => loadDirectory(state.treePath),
    retryFile: () => state.filePath ? openFile(state.filePath) : Promise.resolve(),
    dispose() { active = false; treeRequest++; fileRequest++; externalRequest++; },
  };
}
