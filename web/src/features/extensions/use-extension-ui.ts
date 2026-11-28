import { useEffect, useState } from 'react';
import type { ExtensionUiSnapshot } from '../../types/extension-types';

const EMPTY_SNAPSHOT: ExtensionUiSnapshot = {
  items: [],
  errors: [],
  syncedAt: 0,
  apiVersion: 1,
};

function safeSnapshot(value: unknown): ExtensionUiSnapshot {
  if (!value || typeof value !== 'object') return EMPTY_SNAPSHOT;
  const candidate = value as Partial<ExtensionUiSnapshot>;
  if (!Array.isArray(candidate.items) || !Array.isArray(candidate.errors)) {
    return EMPTY_SNAPSHOT;
  }
  return {
    items: candidate.items,
    errors: candidate.errors,
    syncedAt: Number.isFinite(candidate.syncedAt) ? Number(candidate.syncedAt) : 0,
    apiVersion: Number.isFinite(candidate.apiVersion) ? Number(candidate.apiVersion) : 1,
  };
}

export function useExtensionUiSnapshot(cwd?: string, enabled = true) {
  const [loaded, setLoaded] = useState<{ cwd?: string; snapshot: ExtensionUiSnapshot }>();

  useEffect(() => {
    if (!enabled) {
      setLoaded(undefined);
      return;
    }
    let disposed = false;
    let revision = 0;
    const load = () => {
      const request = ++revision;
      void window.piApi.extensionsUi(cwd)
        .then((next) => {
          if (!disposed && request === revision) setLoaded({ cwd, snapshot: safeSnapshot(next) });
        })
        .catch(() => {
          if (!disposed && request === revision) setLoaded({ cwd, snapshot: EMPTY_SNAPSHOT });
        });
    };
    load();
    const off = window.piApi.onExtensionsChanged(load);
    return () => {
      disposed = true;
      off();
    };
  }, [cwd, enabled]);

  const current = enabled && loaded?.cwd === cwd ? loaded : undefined;
  return { snapshot: current?.snapshot ?? EMPTY_SNAPSHOT, ready: !enabled || Boolean(current) };
}
