import { useCallback, useRef } from 'react';
import { errorText } from '../shared/error-text';

type Surface = 'center' | 'inspector';
type Update<T> = (layout: T) => T;

// A read can finish after the user has already opened a tab. Replay those edits
// over the saved layout before issuing the first write for this layout.
function createLayout<T extends object>(owner: string, surface: Surface, initial: () => T, restore: (raw: unknown) => T, onError: (message: string) => void) {
  let value = initial();
  let loaded = !owner;
  let reading: Promise<void> | undefined;
  const pending: Update<T>[] = [];
  const listeners = new Set<() => void>();
  const publish = () => listeners.forEach((listener) => listener());
  function save() {
    if (owner)
      void window.piApi.writeLayout?.(owner, surface, value).catch((error) => onError(errorText(error)));
  }
  return {
    snapshot: () => value,
    ready: () => loaded,
    canEvict: () => loaded && listeners.size === 0,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    read() {
      if (loaded) return;
      if (reading) return reading;
      reading = Promise.resolve(window.piApi.readLayout?.(owner, surface))
        .then((raw) => {
          value = pending.reduce((layout, change) => change(layout), restore(raw));
          loaded = true;
          if (pending.length) save();
          pending.length = 0;
          publish();
        })
        .catch((error) => {
          reading = undefined;
          onError(errorText(error));
        });
      return reading;
    },
    update(change: Update<T>, optimistic = true) {
      if (!loaded) {
        pending.push(change);
        this.read();
        if (!optimistic) return;
      }
      const next = change(value);
      if (next === value) return;
      value = next;
      if (loaded) save();
      publish();
    },
  };
}

export function useLayoutStores<T extends object>(surface: Surface, initial: () => T, restore: (raw: unknown) => T, setError: (message: string) => void) {
  const stores = useRef(new Map<string, ReturnType<typeof createLayout<T>>>());
  const getStore = useCallback((key: string) => {
    let current = stores.current.get(key);
    if (!current) {
      current = createLayout(key, surface, initial, restore, setError);
      if (stores.current.size >= 24) {
        const idle = [...stores.current].find(([, group]) => group.canEvict());
        if (idle) stores.current.delete(idle[0]);
      }
      stores.current.set(key, current);
    }
    return current;
  }, [surface, initial, restore, setError]);
  return { stores, getStore };
}
