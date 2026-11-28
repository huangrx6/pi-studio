import { useRef } from 'react';

/**
 * Play an async-reveal transition only when content resolves after an in-page
 * loading placeholder; preloaded pages already animate via the outer page frame.
 */
export function useDeferredEnter(ready: boolean): boolean {
  const startedPending = useRef(!ready);
  return ready && startedPending.current;
}
