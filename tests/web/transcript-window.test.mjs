import test from 'node:test';
import assert from 'node:assert/strict';
import { transcriptWindowStart } from '../../web/src/features/conversation/transcript-window.mjs';

test('short to long conversation ignores the prior fully expanded window before commit', () => {
  assert.equal(transcriptWindowStart('long', 2400, { session: 'short', from: 0 }, { session: 'long', from: 2376 }), 2376);
});

test('switching between long conversations does not reuse expanded history', () => {
  assert.equal(transcriptWindowStart('second', 240, { session: 'first', from: 96 }, { session: 'second', from: 216 }), 216);
});

test('same conversation retains expanded reader position as messages arrive', () => {
  const expanded = { session: 'long', from: 2328 };
  const initial = { session: 'long', from: 2376 };
  assert.equal(transcriptWindowStart('long', 2400, expanded, initial), 2328);
  assert.equal(transcriptWindowStart('long', 2410, expanded, initial), 2328);
});

test('initial window remains pinned during streaming and clamps after compaction', () => {
  const initial = { session: 'long', from: 2376 };
  assert.equal(transcriptWindowStart('long', 2410, null, initial), 2376);
  assert.equal(transcriptWindowStart('long', 10, null, initial), 10);
  assert.equal(transcriptWindowStart('empty', 0, { session: 'other', from: 100 }, initial), 0);
});
