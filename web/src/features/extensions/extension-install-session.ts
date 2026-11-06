import type { ExtensionInstallPreview, ExtensionInstallScope } from '../../types/extension-types';
import { errorText } from '../../shared/error-text';

type Api = Pick<Window['piApi'], 'pickExtensionSource' | 'prepareExtensionInstall' | 'installExtension' | 'disposeExtensionInstall' | 'refreshExtensionInstall' | 'disposeExtensionInstallRecovery'>;
type Installed = Awaited<ReturnType<Api['installExtension']>>;
type Phase = 'pick' | 'prepare' | 'install' | 'apply' | null;
export type InstallSessionState = { owner: string; preview: ExtensionInstallPreview | null; source: string; phase: Phase; error: string | null; committed: boolean };
const ownerKey = (cwd: string, preview?: ExtensionInstallPreview | null) => JSON.stringify([cwd, preview?.token || '']);

/** Owns preview tokens and a single operation; UI disposal never cancels a committed install. */
export function createExtensionInstallSession({ api, cwd, initialPreview, isContextCurrent, onChange, onInstalled, onClose }: {
  api: Api; cwd: string; initialPreview?: ExtensionInstallPreview | null;
  isContextCurrent: (key: string) => boolean;
  onChange: (state: InstallSessionState) => void;
  onInstalled: (result: Installed) => void | Promise<void>;
  onClose: () => void;
}) {
  let context = ownerKey(cwd, initialPreview);
  let currentCwd = cwd;
  let initialToken = initialPreview?.token;
  let active = false, closed = false, locked = false;
  let revision = 0;
  let cleanupTimer: ReturnType<typeof setTimeout> | null = null;
  let state: InstallSessionState = { owner: context, preview: initialPreview || null, source: '', phase: null, error: null, committed: false };
  let committed: Installed | null = null;
  const released = new Set<string>();
  const releasedReceipts = new Set<string>();
  const current = (key: string, generation: number) => active && !closed && key === context && generation === revision && isContextCurrent(key);
  function update(patch: Partial<InstallSessionState>) {
    state = { ...state, ...patch };
    if (active && !closed && isContextCurrent(context)) onChange(state);
  }
  function disposeToken(token?: string) {
    if (!token || released.has(token)) return;
    released.add(token);
    // Disposal is best effort; a cleanup failure must not become an unhandled
    // rejection or overwrite a later operation's visible error.
    void Promise.resolve().then(() => api.disposeExtensionInstall(token)).catch(() => {});
  }
  function disposeReceipt(token?: string) {
    if (!token || releasedReceipts.has(token)) return;
    releasedReceipts.add(token);
    void Promise.resolve().then(() => api.disposeExtensionInstallRecovery(token)).catch(() => {});
  }
  function begin(phase: Exclude<Phase, null>) {
    if (!active || closed || locked || !isContextCurrent(context)) return false;
    locked = true;
    update({ phase, error: null });
    return true;
  }
  function finish(key: string, generation: number) {
    if (key !== context || generation !== revision) return;
    locked = false;
    update({ phase: null });
  }
  async function applyCommitted(key: string, generation: number) {
    if (!committed || !current(key, generation)) return;
    if (committed.projection.status === 'error') {
      update({ error: committed.projection.message });
      return;
    }
    try { await onInstalled(committed); }
    catch {
      if (current(key, generation)) update({ error: '扩展已安装，但设置刷新失败。可重试刷新，无需再次安装。' });
      return;
    }
    if (current(key, generation)) { disposeReceipt(committed.recoveryToken); closed = true; active = false; onClose(); }
  }
  return {
    getState: () => state,
    activate() {
      if (cleanupTimer !== null) clearTimeout(cleanupTimer);
      cleanupTimer = null;
      if (!closed) active = true;
    },
    setContext(nextCwd: string, nextPreview?: ExtensionInstallPreview | null) {
      const key = ownerKey(nextCwd, nextPreview);
      if (key === context) return;
      const oldToken = state.preview?.token;
      const reusedAcrossWorkspace = currentCwd !== nextCwd && Boolean(nextPreview) && initialToken === nextPreview?.token;
      disposeToken(oldToken);
      disposeReceipt(committed?.recoveryToken);
      revision++;
      context = key; currentCwd = nextCwd; initialToken = nextPreview?.token; committed = null;
      locked = false;
      update({ owner: key, preview: reusedAcrossWorkspace ? null : nextPreview || null, source: '', phase: null, committed: false, error: null });
    },
    deactivate() {
      active = false;
      // StrictMode setup immediately cancels this deferred token cleanup.
      cleanupTimer = setTimeout(() => {
        cleanupTimer = null;
        if (!active) { disposeToken(state.preview?.token); disposeReceipt(committed?.recoveryToken); }
      }, 0);
    },
    close() {
      if (locked || closed) return;
      closed = true; active = false; revision++;
      disposeToken(state.preview?.token);
      disposeReceipt(committed?.recoveryToken);
      onClose();
    },
    back() {
      if (locked || state.committed) return;
      disposeToken(state.preview?.token);
      revision++;
      update({ preview: null, error: null });
    },
    clearSource() { if (!locked) update({ source: '' }); },
    async pick(kind: 'directory' | 'package') {
      if (!begin('pick')) return;
      const key = context, generation = revision;
      try {
        const selected = await api.pickExtensionSource(kind);
        if (current(key, generation) && selected) update({ source: selected });
      } catch (cause) { if (current(key, generation)) update({ error: errorText(cause) }); }
      finally { finish(key, generation); }
    },
    async prepare(input: { source: string; scope: ExtensionInstallScope; registryUrl: string }) {
      if (!begin('prepare')) return;
      const key = context, generation = revision;
      try {
        disposeToken(state.preview?.token);
        update({ preview: null });
        const next = await api.prepareExtensionInstall({ ...input, cwd: currentCwd });
        if (!current(key, generation)) { disposeToken(next.token); return; }
        update({ preview: next });
      } catch (cause) { if (current(key, generation)) update({ error: errorText(cause) }); }
      finally { finish(key, generation); }
    },
    async install(accepted: boolean) {
      const preview = state.preview;
      if (!preview || state.committed || preview.missingDependencies.length) return;
      const consent = preview.executable || preview.executableExpansion || preview.addedPermissions.length || preview.addedProviderAccess.length || preview.addedRequirements.length || preview.requiresPublisherTrust;
      if (consent && !accepted) return;
      if (!begin('install')) return;
      const key = context, generation = revision;
      try {
        const result = await api.installExtension({
          token: preview.token, scope: preview.scope, cwd: currentCwd,
          acceptedPermissions: preview.addedPermissions,
          acceptedProviderAccess: preview.addedProviderAccess,
          acceptedRequirements: preview.addedRequirements.length ? accepted : true,
          acceptedExecution: consent ? accepted : true,
          acceptedPublisherKey: preview.requiresPublisherTrust ? accepted : true,
        });
        released.add(preview.token);
        if (!current(key, generation)) { disposeReceipt(result.recoveryToken); return; }
        committed = result;
        update({ committed: true, phase: 'apply' });
        await applyCommitted(key, generation);
      } catch (cause) {
        if (current(key, generation)) update({ error: errorText(cause) });
        else {
          // Main ignores disposal while a token is claimed. A failed install
          // releases that claim, so retry cleanup for the abandoned owner now.
          released.delete(preview.token);
          disposeToken(preview.token);
        }
      } finally { finish(key, generation); }
    },
    async retryApply() {
      if (!committed || !begin('apply')) return;
      const key = context, generation = revision;
      try {
        if (committed.projection.status === 'error') {
          const next = await api.refreshExtensionInstall(committed.recoveryToken);
          if (!current(key, generation)) { disposeReceipt(next.recoveryToken); return; }
          committed = next;
        }
        await applyCommitted(key, generation);
      } catch {
        if (current(key, generation)) update({ error: '扩展已安装，暂时无法刷新安装结果。可重试刷新，或从扩展设置查看已安装状态；无需再次安装。' });
      } finally { finish(key, generation); }
    },
  };
}

export { ownerKey as extensionInstallOwnerKey };
