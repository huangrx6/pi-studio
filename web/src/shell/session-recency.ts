/** Compact elapsed time, preserving the sidebar's seconds/minutes/hours format. */
export function relativeTime(timestamp: number, now = Date.now()): string {
  if (!Number.isFinite(timestamp)) return '—';
  const seconds = Math.max(0, Math.floor((now - timestamp) / 1_000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h${minutes % 60 ? `${minutes % 60}m` : ''}`;
  return `${Math.floor(hours / 24)}d`;
}

/** Schedule the next label boundary, not a global one-second refresh. */
export function nextRelativeTimeTick(timestamp: number, now = Date.now()): number | null {
  if (!Number.isFinite(timestamp)) return null;
  if (timestamp > now) return Math.min(2_147_483_647, timestamp - now + 1_000);
  const elapsed = now - timestamp;
  const unit = elapsed < 60_000 ? 1_000 : elapsed < 86_400_000 ? 60_000 : 86_400_000;
  return Math.max(1, unit - (elapsed % unit));
}

type Clock = {
  now: () => number;
  setTimeout: (callback: () => void, delay: number) => number;
  clearTimeout: (timer: number) => void;
};

/** A small scheduler with an injected clock so visibility transitions are testable. */
export function createRecencyClock(timestamp: number, onTick: (now: number) => void, clock: Clock) {
  let active = false;
  let disposed = false;
  let generation = 0;
  let timer: number | undefined;
  const cancel = () => {
    if (timer !== undefined) clock.clearTimeout(timer);
    timer = undefined;
  };
  const tick = (expectedGeneration: number) => {
    if (!active || disposed || generation !== expectedGeneration) return;
    timer = undefined;
    const now = clock.now();
    onTick(now);
    const delay = nextRelativeTimeTick(timestamp, now);
    if (active && !disposed && delay !== null) timer = clock.setTimeout(() => tick(expectedGeneration), delay);
  };
  return {
    setActive(next: boolean) {
      if (disposed || active === next) return;
      cancel();
      generation++;
      active = next;
      if (active) tick(generation);
    },
    dispose() { disposed = true; active = false; generation++; cancel(); },
  };
}
