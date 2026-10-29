import { useEffect, useState } from 'react';
import type { ExtensionUiSnapshot } from '../types/extension-types';

const EMPTY_SNAPSHOT: ExtensionUiSnapshot = {
  items: [],
  errors: [],
  syncedAt: 0,
  apiVersion: 1,
};

/**
 * Loads the declarative extension surface for one workspace.
 *
 * Multiple slots intentionally remain independent: settings and the right
 * workbench can stay mounted while the conversation surface changes. Callers
 * that need to inspect items before rendering them can pass an external
 * snapshot to ExtensionSlot.
 */
export function useExtensionUiSnapshot(cwd?: string, enabled = true) {
  const [snapshot, setSnapshot] = useState<ExtensionUiSnapshot>(EMPTY_SNAPSHOT);

  useEffect(() => {
    if (!enabled) {
      setSnapshot(EMPTY_SNAPSHOT);
      return;
    }
    let disposed = false;
    const load = () => {
      void window.piApi.extensionsUi(cwd)
        .then((next) => {
          if (!disposed) setSnapshot(next);
        })
        .catch(() => {
          if (!disposed) setSnapshot(EMPTY_SNAPSHOT);
        });
    };
    load();
    const off = window.piApi.onExtensionsChanged(load);
    return () => {
      disposed = true;
      off();
    };
  }, [cwd, enabled]);

  return snapshot;
}
