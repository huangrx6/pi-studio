const assert = require('node:assert/strict');
const { test } = require('node:test');
const { dragToolBounds, fitToolBounds, placementForBounds } = require('../../electron/main/services/tool-window-bounds.cjs');

const area = { x: 190, y: 44, width: 1400, height: 900, zoom: 1 };
const initial = { offsetX: 0, offsetY: 0 };
const start = fitToolBounds(area, initial, false);

test('dragging any side or corner moves only its chosen edges', () => {
  for (const handle of ['n', 'ne', 'e', 'se', 's', 'sw', 'w', 'nw']) {
    const rect = dragToolBounds(area, start, handle, 42, -38);
    assert.equal(rect.x - start.x, handle.includes('w') ? 42 : 0, handle);
    assert.equal(rect.y - start.y, handle.includes('n') ? -38 : 0, handle);
    assert.equal(rect.x + rect.width - start.x - start.width, handle.includes('e') ? 42 : 0, handle);
    assert.equal(rect.y + rect.height - start.y - start.height, handle.includes('s') ? -38 : 0, handle);
    assert.deepEqual(fitToolBounds(area, placementForBounds(area, rect, initial, handle), false), rect);
  }
});

test('manual sizes survive maximize, a smaller host and a change of zoom', () => {
  const custom = dragToolBounds(area, start, 'nw', 152, 120);
  const saved = placementForBounds(area, custom, initial, 'nw');
  assert.deepEqual(fitToolBounds(area, saved, true), { x: 190, y: 44, width: 1400, height: 900 });
  const small = { ...area, width: 270, height: 160 };
  const fitted = fitToolBounds(small, saved, false);
  assert.deepEqual(fitted, { x: 190, y: 44, width: 270, height: 160 });
  assert.deepEqual(dragToolBounds(small, fitted, 'nw', 500, 500), fitted);
  assert.deepEqual(fitToolBounds(area, saved, false), custom);
  const scaled = fitToolBounds({ ...area, zoom: 1.25 }, saved, false);
  assert.equal(scaled.width, Math.round(custom.width * 1.25));
  assert.equal(scaled.height, Math.round(custom.height * 1.25));
});

test('drag limits keep the opposite corner fixed and the complete panel inside the canvas', () => {
  const minimum = dragToolBounds(area, start, 'nw', 5000, 5000);
  assert.deepEqual([minimum.width, minimum.height], [344, 224]);
  assert.equal(minimum.x + minimum.width, start.x + start.width);
  assert.equal(minimum.y + minimum.height, start.y + start.height);
  const outward = dragToolBounds(area, start, 'se', 5000, 5000);
  assert.equal(outward.x + outward.width, area.x + area.width);
  assert.equal(outward.y + outward.height, area.y + area.height);
  const moved = dragToolBounds(area, start, 'move', -5000, -5000);
  assert.deepEqual(moved, { ...start, x: area.x, y: area.y });
  const placement = placementForBounds(area, moved, initial, 'move');
  assert.equal(placement.width, undefined, 'moving an auto-sized panel keeps responsive sizing');
  assert.deepEqual(fitToolBounds(area, placement, false), moved);
});
