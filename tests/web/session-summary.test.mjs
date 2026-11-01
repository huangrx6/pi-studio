import assert from 'node:assert/strict';
import test from 'node:test';
import { completedTurnDuration } from '../../web/src/lib/session-summary.ts';

test('completed answer duration is compact and stays frozen', () => {
  assert.equal(completedTurnDuration(0), '0s');
  assert.equal(completedTurnDuration(13_900), '13s');
  assert.equal(completedTurnDuration(61_000), '1m');
  assert.equal(completedTurnDuration(3_661_000), '1h1m');
  assert.equal(completedTurnDuration(undefined), '');
});
