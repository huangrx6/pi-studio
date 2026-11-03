import test from 'node:test';
import assert from 'node:assert/strict';
import { reconcileComparisonSnapshot } from '../../web/src/lib/comparison-state.ts';

test('a delayed comparison poll cannot revive a discarded branch while its sibling keeps updating', () => {
  const discarded = { sessionId: 'left', status: 'discarded', running: false };
  const incoming = [
    { sessionId: 'left', status: 'running', running: true },
    { sessionId: 'right', status: 'completed', running: false },
  ];
  const result = reconcileComparisonSnapshot([discarded, { sessionId: 'right', status: 'running' }], incoming);
  assert.equal(result[0], discarded);
  assert.equal(result[1], incoming[1]);
  assert.deepEqual(reconcileComparisonSnapshot(null, incoming), incoming);
});
