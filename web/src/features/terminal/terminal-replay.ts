import type { TerminalReplay } from '../../types/runtime-panel-types';

type ReplayTarget = {
  reset(): void;
  resize(cols: number, rows: number): void;
  write(data: string, callback: () => void): void;
};

/** Parse each output segment at its original geometry before resizing. */
export async function restoreTerminalReplay(
  terminal: ReplayTarget,
  replay: TerminalReplay,
  isCurrent: () => boolean,
): Promise<boolean> {
  if (!isCurrent()) return false;
  terminal.reset();
  terminal.resize(replay.cols, replay.rows);
  for (const step of replay.steps) {
    if (!isCurrent()) return false;
    if (step.type === 'resize') terminal.resize(step.cols, step.rows);
    else await new Promise<void>((resolve) => terminal.write(step.data, resolve));
  }
  return isCurrent();
}
