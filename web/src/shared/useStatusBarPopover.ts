import { useLayoutEffect, useRef, useState } from 'react';

/** Keep the current contents in place until the footer popover has faded out. */
export function useStatusBarPopover<T>(current: T | undefined) {
  const surface = useRef<HTMLDivElement>(null);
  const [last, setLast] = useState<T>();
  useLayoutEffect(() => {
    const element = surface.current;
    if (!element) return;
    element.inert = current === undefined;
    if (current !== undefined) {
      setLast(current);
      return;
    }
    const exit = element.getAnimations().find(animation =>
      animation instanceof CSSTransition && animation.transitionProperty === 'opacity');
    if (!exit) {
      setLast(undefined);
      return;
    }
    let closing = true;
    void exit.finished.catch(() => {}).then(() => { if (closing) setLast(undefined); });
    return () => { closing = false; };
  }, [current]);
  return { surface, rendered: current ?? last, phase: current === undefined ? 'closing' : 'open' };
}
