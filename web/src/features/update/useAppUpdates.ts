import { useEffect, useRef, useState } from 'react';
import type { UpdateSnapshot } from '../../types/update-types';
import { createUpdateResource } from './update-resource';

export function useAppUpdates() {
  const [snapshot, setSnapshot] = useState<UpdateSnapshot>({ currentVersion: '', state: 'idle' });
  const [dialogOpen, setDialogOpen] = useState(false);
  const resourceRef = useRef<ReturnType<typeof createUpdateResource> | null>(null);
  useEffect(() => {
    const resource = createUpdateResource({ api: window.piApi, onChange: setSnapshot, onOpen: () => setDialogOpen(true) });
    resourceRef.current = resource;
    resource.start();
    return () => {
      resource.dispose();
      if (resourceRef.current === resource) resourceRef.current = null;
    };
  }, []);
  return {
    snapshot, dialogOpen,
    close: () => setDialogOpen(false),
    open: () => resourceRef.current?.open(),
    check: () => resourceRef.current?.check() ?? Promise.resolve(),
    download: () => resourceRef.current?.download() ?? Promise.resolve(),
    install: () => resourceRef.current?.install() ?? Promise.resolve(),
  };
}
