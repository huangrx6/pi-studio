import type { ActivityEntry } from './turn-content.ts';

/** Keep the live tail short so long tool runs do not grow an ever-taller DOM. */
export const LIVE_ACTIVITY_TAIL = 3;
/** When the reader expands history, still cap how many finished steps mount at once. */
export const EXPANDED_ACTIVITY_PAGE = 24;
/** Soft character budget for tool output before an expand control appears. */
export const ACTIVITY_OUTPUT_SOFT_LIMIT = 6_000;
/** Each “show more” click reveals this many additional characters. */
export const ACTIVITY_OUTPUT_EXPAND_STEP = 24_000;

export type ActivityWindowOptions = {
  live: boolean;
  active: boolean;
  expandedHistory: boolean;
  density: 'compact' | 'standard' | 'detailed';
  inspected: ReadonlySet<string>;
  results: Map<string, { isError?: boolean }>;
};

/**
 * Decide which activity rows stay in the DOM.
 *
 * Live turns keep live steps, failures, inspected rows, and a short finished tail.
 * Collapsed long histories page from the end so a hundred-step turn stays light.
 */
export function selectVisibleActivityEntries(
  entries: ActivityEntry[],
  options: ActivityWindowOptions,
): { visible: ActivityEntry[]; hiddenCount: number } {
  const { live, active, expandedHistory, density, inspected, results } = options;
  if (entries.length === 0) return { visible: [], hiddenCount: 0 };

  const limitLive = live && active && density !== 'detailed' && !expandedHistory;
  if (limitLive) {
    const keep = new Set<number>();
    entries.forEach((entry, index) => {
      if (entry.live || inspected.has(entry.key)) keep.add(index);
      if (entry.kind === 'tool' && results.get(entry.call.id)?.isError) keep.add(index);
    });
    const tailStart = Math.max(0, entries.length - LIVE_ACTIVITY_TAIL);
    for (let index = tailStart; index < entries.length; index += 1) keep.add(index);
    const visible = entries.filter((_, index) => keep.has(index));
    return { visible, hiddenCount: entries.length - visible.length };
  }

  if (!expandedHistory && entries.length > EXPANDED_ACTIVITY_PAGE) {
    const start = Math.max(0, entries.length - EXPANDED_ACTIVITY_PAGE);
    return {
      visible: entries.slice(start),
      hiddenCount: start,
    };
  }

  return { visible: entries, hiddenCount: 0 };
}

/** Clamp tool/thinking text for first paint; full text stays available on expand. */
export function clampActivityText(text: string, limit = ACTIVITY_OUTPUT_SOFT_LIMIT): {
  text: string;
  truncated: boolean;
  omitted: number;
} {
  if (text.length <= limit) return { text, truncated: false, omitted: 0 };
  let cut = text.lastIndexOf('\n', limit);
  if (cut < Math.floor(limit * 0.6)) cut = limit;
  return {
    text: text.slice(0, cut).trimEnd(),
    truncated: true,
    omitted: text.length - cut,
  };
}
