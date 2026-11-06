import { memo, useEffect, useRef, useState } from 'react';
import { completedTurnDuration } from '../features/conversation/session-summary';
import { createRecencyClock, relativeTime } from './session-recency';

/** Only this text node updates; the app and sidebar list have no ticking clock. */
export const SessionRecency = memo(function SessionRecency({ timestamp, durationMs, running = false, pinned = false, visible = true }: {
  timestamp: number;
  durationMs?: number;
  running?: boolean;
  pinned?: boolean;
  /** False for virtual overscan/retained owners outside the visible range. */
  visible?: boolean;
}) {
  const duration = completedTurnDuration(durationMs);
  const [now, setNow] = useState(() => Date.now());
  const node = useRef<HTMLSpanElement>(null);
  const needsClock = visible && !running && !pinned && !duration;
  useEffect(() => {
    if (!needsClock || !node.current) return;
    const clock = createRecencyClock(timestamp, setNow, {
      now: Date.now,
      setTimeout: (callback, delay) => window.setTimeout(callback, delay),
      clearTimeout: (timer) => window.clearTimeout(timer),
    });
    // IntersectionObserver accounts for clipping by the scrollable sidebar,
    // including CSS-hidden metadata while the row's actions are visible.
    let intersecting = false;
    const update = () => clock.setActive(intersecting && !document.hidden);
    const observer = new IntersectionObserver(([entry]) => {
      intersecting = Boolean(entry?.isIntersecting && entry.intersectionRatio > 0);
      update();
    });
    observer.observe(node.current);
    document.addEventListener('visibilitychange', update);
    return () => {
      observer.disconnect();
      document.removeEventListener('visibilitychange', update);
      clock.dispose();
    };
  }, [needsClock, timestamp]);
  if (running || pinned) return null;
  return <span ref={node} className="session-time" title={duration ? '最近一次回答耗时' : '最近更新'}>
    {duration || relativeTime(timestamp, now)}
  </span>;
});
