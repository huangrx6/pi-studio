import assert from 'node:assert/strict';
import test from 'node:test';
import { visibleSessionIndices, sessionWindowSegments, focusNeighborIndices } from '../../web/src/shell/sidebar-virtualization.mjs';

test('small lists preserve all rows and large lists mount only viewport with overscan', () => {
  assert.equal(visibleSessionIndices(80, 0, 600, 36, 30).length, 80);
  const rows = visibleSessionIndices(1200, 0, 600, 36, 30);
  assert.equal(rows[0], 0);
  assert.ok(rows.length < 30);
  const distant = visibleSessionIndices(1200, 30_000, 600, 36, 30);
  assert.ok(distant[0] > 990);
  assert.ok(distant.length < 35);
});

test('offscreen focused neighbors, dialog owner and dragged source stay sparse and ordered', () => {
  const retained = [...focusNeighborIndices(1000, 1200), 400, 800];
  const rows = visibleSessionIndices(1200, 0, 600, 36, 30, retained);
  for (const index of retained) assert.ok(rows.includes(index));
  assert.ok(rows.length < 40);
  assert.deepEqual(rows, [...new Set(rows)].sort((a, b) => a - b));
});

test('spacers and rows retain the complete logical height without duplicating rows', () => {
  const segments = sessionWindowSegments([0, 1, 8, 999], 1200);
  assert.equal(segments.reduce((sum, item) => sum + (item.kind === 'gap' ? item.count : 1), 0), 1200);
  assert.deepEqual(segments.filter((item) => item.kind === 'row').map((item) => item.index), [0, 1, 8, 999]);
  assert.deepEqual(sessionWindowSegments([], 1200), [{ kind: 'gap', from: 0, count: 1200 }]);
});

test('groups outside viewport stay empty except explicit owners; edge indices stay valid', () => {
  assert.deepEqual(visibleSessionIndices(1200, 0, 600, 40_000, 30), []);
  assert.deepEqual(visibleSessionIndices(1200, 80_000, 600, 0, 30), []);
  assert.deepEqual(visibleSessionIndices(1200, 0, 600, 40_000, 30, [-1, 1199, 1200]), [1199]);
  assert.deepEqual(focusNeighborIndices(0, 1200), [0, 1]);
  assert.deepEqual(focusNeighborIndices(1199, 1200), [1198, 1199]);
});
