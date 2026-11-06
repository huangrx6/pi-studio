import { useEffect, useState } from 'react';

type UsageResource<T> = { key: string; value: T | null; error: string | null; pending: boolean };

/** Keep a same-window refresh readable, but never label another window's data as this request. */
export function useUsageResource<T>(active: boolean, key: string, request: number, load: () => Promise<T>) {
  const [resource, setResource] = useState<UsageResource<T>>({ key: '', value: null, error: null, pending: true });
  useEffect(() => {
    if (!active) return;
    let current = true;
    setResource(previous => ({ key, value: previous.key === key ? previous.value : null, error: null, pending: true }));
    void load().then(value => {
      if (current) setResource({ key, value, error: null, pending: false });
    }).catch(cause => {
      if (current) setResource(previous => ({ ...previous, error: cause instanceof Error ? cause.message : String(cause), pending: false }));
    });
    return () => { current = false; };
  }, [active, key, request, load]);
  return resource.key === key ? resource : { key, value: null, error: null, pending: true };
}
