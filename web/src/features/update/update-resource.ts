import type { UpdateSnapshot } from '../../types/update-types';
import { errorText } from '../../shared/error-text';

type UpdateAction = 'check' | 'download' | 'install';
type UpdateApi = Pick<Window['piApi'], 'updateState' | 'onUpdateState' | 'onOpenUpdate' | 'checkForUpdates' | 'downloadUpdate' | 'installUpdate'>;

/** Main-process events are authoritative; older reads must never rewind them. */
export function createUpdateResource({ api, onChange, onOpen }: {
  api: UpdateApi;
  onChange: (snapshot: UpdateSnapshot) => void;
  onOpen: () => void;
}) {
  let disposed = false;
  let started = false;
  let revision = 0;
  let snapshot: UpdateSnapshot = { currentVersion: '', state: 'idle' };
  const announcedDownloads = new Set<string>();
  let pending: Promise<void> | null = null;
  let pendingAction: UpdateAction | null = null;
  let unsubscribe = () => {};

  function accept(next: UpdateSnapshot | undefined) {
    if (disposed || !next) return;
    snapshot = next;
    revision += 1;
    onChange(next);
    if (next.state === 'downloaded') {
      const target = JSON.stringify([next.latestVersion ?? next.currentVersion, next.latestBuildId ?? '']);
      if (!announcedDownloads.has(target)) {
        announcedDownloads.add(target);
        onOpen();
      }
    }
  }

  function run(action: UpdateAction): Promise<void> {
    if (disposed) return Promise.resolve();
    // This lock belongs to the app resource, so closing the dialog cannot reset it.
    if (pending) return pendingAction === action ? pending : Promise.reject(new Error('另一项更新操作仍在进行，请稍后重试。'));
    const requestedAt = ++revision;
    pendingAction = action;
    pending = Promise.resolve().then(async () => {
      if (disposed) return;
      try {
        if (action === 'install') {
          await api.installUpdate();
        } else {
          const next = action === 'check'
            ? await api.checkForUpdates({ interactive: true })
            : await api.downloadUpdate();
          if (revision === requestedAt) accept(next);
        }
      } catch (error) {
        if (disposed) return;
        // A failed install must retain the downloaded artifact and its retry action.
        if (action === 'install') throw error;
        if (revision === requestedAt || snapshot.state === (action === 'check' ? 'checking' : 'downloading')) {
          accept({ ...snapshot, state: 'error', error: errorText(error) });
        }
      }
    }).finally(() => { pending = null; pendingAction = null; });
    return pending;
  }

  return {
    start() {
      if (disposed || started) return;
      started = true;
      const requestedAt = revision;
      const offState = api.onUpdateState?.(accept) ?? (() => {});
      const offOpen = api.onOpenUpdate?.(() => { if (!disposed) onOpen(); }) ?? (() => {});
      unsubscribe = () => { offState(); offOpen(); };
      void Promise.resolve().then(() => disposed ? undefined : api.updateState?.()).then(next => {
        if (revision === requestedAt) accept(next);
      }).catch(() => { /* Optional in browser previews; explicit checks expose failures. */ });
    },
    check: () => run('check'),
    download: () => run('download'),
    install: () => run('install'),
    open() {
      if (disposed) return;
      onOpen();
      if (snapshot.state === 'idle') void run('check');
    },
    dispose() { disposed = true; unsubscribe(); },
  };
}
