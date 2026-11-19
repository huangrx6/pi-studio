import { useEffect, useRef, useState } from 'react';

/** Minimum gap between full Markdown re-parses while a turn is still streaming. */
export const STREAMING_MARKDOWN_INTERVAL_MS = 72;


/** Keep only a short live tail reparsing while long answers stream. */
export const STREAMING_MARKDOWN_LIVE_CHARS = 2_800;
/** Start freezing the settled prefix once the answer is long enough. */
export const STREAMING_MARKDOWN_FREEZE_MIN = 4_000;

/**
 * Split a long streaming answer into a stable prefix and a short live tail.
 * The cut prefers a blank line so finished Markdown blocks stay intact.
 */
export function splitStreamingMarkdown(
  source: string,
  liveChars = STREAMING_MARKDOWN_LIVE_CHARS,
  freezeMin = STREAMING_MARKDOWN_FREEZE_MIN,
): { frozen: string; live: string } {
  if (source.length < freezeMin) return { frozen: '', live: source };
  const liveBudget = Math.max(400, Math.floor(liveChars));
  const liveStartMin = Math.max(0, source.length - liveBudget);
  let cut = source.lastIndexOf('\n\n', liveStartMin);
  let gap = 2;
  if (cut < Math.floor(source.length * 0.3)) {
    cut = source.lastIndexOf('\n', liveStartMin);
    gap = 1;
  }
  if (cut < Math.floor(source.length * 0.2)) return { frozen: '', live: source };
  const frozenEnd = cut + gap;
  return {
    frozen: source.slice(0, frozenEnd),
    live: source.slice(frozenEnd),
  };
}

/** Decide whether a streaming Markdown source should re-parse now. */
export function shouldFlushStreamingMarkdown(
  lastFlushAt: number,
  now: number,
  intervalMs = STREAMING_MARKDOWN_INTERVAL_MS,
): { flush: boolean; waitMs: number } {
  if (lastFlushAt <= 0) return { flush: true, waitMs: 0 };
  const elapsed = now - lastFlushAt;
  if (elapsed >= intervalMs) return { flush: true, waitMs: 0 };
  return { flush: false, waitMs: intervalMs - elapsed };
}

/**
 * Keep the visible Markdown source current enough to read, without re-parsing on
 * every token. Leading-edge updates flush immediately after a quiet interval so
 * the first characters appear right away; trailing-edge catches the final burst.
 * When streaming ends, the latest source is applied on the same turn.
 */
export function useStreamingMarkdownText(value: string, streaming: boolean): string {
  const [deferred, setDeferred] = useState(value);
  const latestRef = useRef(value);
  const lastFlushRef = useRef(0);
  const deferredRef = useRef(deferred);
  deferredRef.current = deferred;
  latestRef.current = value;

  useEffect(() => {
    if (!streaming) {
      if (deferredRef.current !== value) setDeferred(value);
      lastFlushRef.current = 0;
      return;
    }

    const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
    const decision = shouldFlushStreamingMarkdown(lastFlushRef.current, now);
    const apply = (next: string, at: number) => {
      lastFlushRef.current = at;
      if (deferredRef.current !== next) setDeferred(next);
    };

    if (decision.flush) {
      apply(value, now);
      return;
    }

    const wait = decision.waitMs;
    const timer = window.setTimeout(() => {
      const at = typeof performance !== 'undefined' ? performance.now() : Date.now();
      apply(latestRef.current, at);
    }, wait);
    return () => window.clearTimeout(timer);
  }, [value, streaming]);

  return streaming ? deferred : value;
}
