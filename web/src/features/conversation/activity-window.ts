export const ACTIVITY_OUTPUT_SOFT_LIMIT = 6_000;
/** Each “show more” click reveals this many additional characters. */
export const ACTIVITY_OUTPUT_EXPAND_STEP = 24_000;

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
