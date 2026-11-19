import assert from 'node:assert/strict';
import test from 'node:test';
import {
  STREAMING_MARKDOWN_FREEZE_MIN,
  STREAMING_MARKDOWN_INTERVAL_MS,
  STREAMING_MARKDOWN_LIVE_CHARS,
  shouldFlushStreamingMarkdown,
  splitStreamingMarkdown,
} from '../../web/src/shared/streaming-markdown-text.ts';

test('first streaming paint flushes immediately', () => {
  assert.deepEqual(shouldFlushStreamingMarkdown(0, 10), { flush: true, waitMs: 0 });
});

test('tokens inside the interval are deferred', () => {
  const decision = shouldFlushStreamingMarkdown(100, 100 + STREAMING_MARKDOWN_INTERVAL_MS - 8);
  assert.equal(decision.flush, false);
  assert.equal(decision.waitMs, 8);
});

test('tokens after the interval flush again', () => {
  assert.deepEqual(
    shouldFlushStreamingMarkdown(100, 100 + STREAMING_MARKDOWN_INTERVAL_MS),
    { flush: true, waitMs: 0 },
  );
});

test('short answers stay entirely live', () => {
  assert.deepEqual(splitStreamingMarkdown('hello'), { frozen: '', live: 'hello' });
});

test('long answers freeze a settled prefix at a blank line', () => {
  const paragraphs = Array.from({ length: 80 }, (_, index) => (
    `Paragraph ${index + 1} with enough text to grow past the freeze threshold for streaming answers.`
  )).join('\n\n');
  assert.ok(paragraphs.length >= STREAMING_MARKDOWN_FREEZE_MIN);
  const parts = splitStreamingMarkdown(paragraphs);
  assert.ok(parts.frozen.length > 0);
  assert.ok(parts.live.length > 0);
  assert.ok(parts.live.length <= STREAMING_MARKDOWN_LIVE_CHARS + 200);
  assert.equal(parts.frozen + parts.live, paragraphs);
  assert.match(parts.frozen, /\n\n$/);
});

test('frozen prefix stays stable while the live tail grows a little', () => {
  const base = Array.from({ length: 80 }, (_, index) => (
    `Block ${index + 1} content goes here with enough characters for a stable frozen prefix.`
  )).join('\n\n');
  const first = splitStreamingMarkdown(base);
  const second = splitStreamingMarkdown(`${base} more`);
  assert.equal(second.frozen, first.frozen);
  assert.equal(second.live, `${first.live} more`);
});
