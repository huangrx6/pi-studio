import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ACTIVITY_OUTPUT_EXPAND_STEP,
  ACTIVITY_OUTPUT_SOFT_LIMIT,
  clampActivityText,
  EXPANDED_ACTIVITY_PAGE,
  LIVE_ACTIVITY_TAIL,
  selectVisibleActivityEntries,
} from '../../web/src/features/conversation/activity-window.ts';

const tool = (id, live = false) => ({
  kind: 'tool',
  key: id,
  live,
  call: { type: 'toolCall', id, name: 'bash', arguments: { command: id } },
});

test('live turns keep failures, inspected rows, and a short finished tail', () => {
  const entries = [
    tool('a'), tool('b'), tool('c'), tool('d'), tool('e'), tool('live', true),
  ];
  const results = new Map([['b', { isError: true }]]);
  const { visible, hiddenCount } = selectVisibleActivityEntries(entries, {
    live: true,
    active: true,
    expandedHistory: false,
    density: 'standard',
    inspected: new Set(['a']),
    results,
  });
  // inspected a, failed b, tail e+live (LIVE_ACTIVITY_TAIL=2 of whole list end)
  assert.deepEqual(visible.map((entry) => entry.key), ['a', 'b', 'd', 'e', 'live']);
  assert.equal(hiddenCount, 1);
});

test('live tail length matches LIVE_ACTIVITY_TAIL when nothing else is pinned', () => {
  const entries = Array.from({ length: 10 }, (_, index) => tool(String(index), index === 9));
  const { visible, hiddenCount } = selectVisibleActivityEntries(entries, {
    live: true,
    active: true,
    expandedHistory: false,
    density: 'standard',
    inspected: new Set(),
    results: new Map(),
  });
  assert.deepEqual(visible.map((entry) => entry.key), ['7', '8', '9']);
  assert.equal(visible.length, LIVE_ACTIVITY_TAIL);
  assert.equal(hiddenCount, 7);
});

test('collapsed long lists page from the end', () => {
  const entries = Array.from({ length: EXPANDED_ACTIVITY_PAGE + 5 }, (_, index) => tool(String(index)));
  const { visible, hiddenCount } = selectVisibleActivityEntries(entries, {
    live: false,
    active: false,
    expandedHistory: false,
    density: 'standard',
    inspected: new Set(),
    results: new Map(),
  });
  assert.equal(visible.length, EXPANDED_ACTIVITY_PAGE);
  assert.equal(hiddenCount, 5);
  assert.equal(visible[0].key, '5');
});

test('expandedHistory shows the full list', () => {
  const entries = Array.from({ length: EXPANDED_ACTIVITY_PAGE + 3 }, (_, index) => tool(String(index)));
  const { visible, hiddenCount } = selectVisibleActivityEntries(entries, {
    live: false,
    active: false,
    expandedHistory: true,
    density: 'standard',
    inspected: new Set(),
    results: new Map(),
  });
  assert.equal(visible.length, entries.length);
  assert.equal(hiddenCount, 0);
});

test('clampActivityText prefers a line break near the limit', () => {
  const body = ['alpha', 'x'.repeat(100), 'beta', 'y'.repeat(20_000)].join('\n');
  const clamped = clampActivityText(body, 200);
  assert.equal(clamped.truncated, true);
  assert.ok(clamped.omitted > 0);
  assert.equal(clampActivityText('short').truncated, false);
});

test('expand step is larger than the first soft window', () => {
  assert.ok(ACTIVITY_OUTPUT_EXPAND_STEP > ACTIVITY_OUTPUT_SOFT_LIMIT);
});
