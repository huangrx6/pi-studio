type PollEnvironment = {
  isVisible: () => boolean;
  onVisibilityChange: (callback: () => void) => () => void;
  schedule: (callback: () => void, delay: number) => number;
  cancel: (id: number) => void;
};

/** One request at a time; hidden and disposed panels do not schedule work. */
export function pollServiceCount(read: () => Promise<number>, publish: (count: number) => void, env: PollEnvironment) {
  let disposed = false;
  let pending = false;
  let timer: number | undefined;
  const cancelTimer = () => { if (timer !== undefined) env.cancel(timer); timer = undefined; };
  const refresh = async () => {
    cancelTimer();
    if (disposed || pending || !env.isVisible()) return;
    pending = true;
    try {
      const count = await read();
      if (!disposed && env.isVisible()) publish(count);
    } catch {
      if (!disposed && env.isVisible()) publish(0);
    } finally {
      pending = false;
      if (!disposed && env.isVisible()) timer = env.schedule(() => void refresh(), 5000);
    }
  };
  const unlisten = env.onVisibilityChange(() => {
    cancelTimer();
    if (env.isVisible()) void refresh();
  });
  void refresh();
  return () => { disposed = true; cancelTimer(); unlisten(); };
}
