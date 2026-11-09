/**
 * Window geometry restoration.
 *
 * These rules decide where the main window opens: the saved rectangle wins while
 * it still overlaps a connected display, otherwise a centered default window is
 * used. The tests use plain work-area objects instead of a real desktop session.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  DEFAULT_WINDOW_SIZE,
  MIN_WINDOW_SIZE,
  centerWindowBounds,
  normalizeWindowBounds,
  resolveWindowBounds,
} = require('../../electron/core/window-bounds.cjs');

const primary = { x: 0, y: 25, width: 1920, height: 1055 };
const secondary = { x: 1440, y: 0, width: 1920, height: 1080 };

test('saved bounds are rounded, size-checked and never trusted as maximized by accident', () => {
  assert.deepEqual(
    normalizeWindowBounds({ x: 10.4, y: 20.6, width: 1200.2, height: 800.8, maximized: 'yes' }),
    { x: 10, y: 21, width: 1200, height: 801, maximized: false },
  );
  assert.equal(normalizeWindowBounds({ x: 10, y: 20, width: 1200, height: 800, maximized: true }).maximized, true);
  for (const value of [
    null,
    undefined,
    'bounds',
    [],
    { x: 0, y: 0, width: 1200 },
    { x: 0, y: NaN, width: 1200, height: 800 },
    { x: 0, y: 0, width: MIN_WINDOW_SIZE.width - 1, height: 800 },
    { x: 0, y: 0, width: 1200, height: MIN_WINDOW_SIZE.height - 1 },
    { x: 0, y: 0, width: 0, height: 800 },
  ]) {
    assert.equal(normalizeWindowBounds(value), null, `rejects ${JSON.stringify(value)}`);
  }
});

test('first launch opens a centered default window inside the primary work area', () => {
  const result = resolveWindowBounds(null, [primary]);
  assert.equal(result.restored, false);
  assert.equal(result.maximized, false);
  assert.deepEqual(result.bounds, centerWindowBounds(primary));
  assert.equal(result.bounds.width, DEFAULT_WINDOW_SIZE.width);
  assert.equal(result.bounds.height, DEFAULT_WINDOW_SIZE.height);
  assert.equal(result.bounds.x, Math.round((primary.width - DEFAULT_WINDOW_SIZE.width) / 2));
  assert.equal(result.bounds.y, Math.round(primary.y + (primary.height - DEFAULT_WINDOW_SIZE.height) / 2));
});

test('a saved rectangle is restored verbatim while its display is connected', () => {
  const saved = { x: 120, y: 140, width: 1180, height: 760, maximized: true };
  const result = resolveWindowBounds(saved, [primary, secondary]);
  assert.equal(result.restored, true);
  assert.equal(result.maximized, true);
  assert.deepEqual(result.bounds, { x: 120, y: 140, width: 1180, height: 760 });
});

test('a rectangle on a disconnected display falls back to a centered window', () => {
  const saved = { x: 2400, y: 300, width: 1100, height: 700, maximized: true };
  const result = resolveWindowBounds(saved, [primary]);
  assert.equal(result.restored, false);
  assert.equal(result.maximized, false, 'a stale rectangle must not reopen maximized');
  assert.deepEqual(result.bounds, centerWindowBounds(primary));
});

test('a rectangle on a secondary display keeps that display', () => {
  const saved = { x: 1800, y: 120, width: 1200, height: 780 };
  const result = resolveWindowBounds(saved, [primary, secondary]);
  assert.equal(result.restored, true);
  assert.deepEqual(result.bounds, { x: 1800, y: 120, width: 1200, height: 780 });
});

test('oversized and off-work-area rectangles are clamped into their display', () => {
  const huge = resolveWindowBounds({ x: 0, y: 0, width: 3200, height: 2400 }, [primary]);
  assert.deepEqual(huge.bounds, { x: 0, y: primary.y, width: primary.width, height: primary.height });

  // A title bar dragged above the menu bar must come back fully reachable.
  const above = resolveWindowBounds({ x: 40, y: -220, width: 1100, height: 700 }, [primary]);
  assert.equal(above.bounds.y, primary.y);

  // Half off the right edge: the window is pulled back inside the work area.
  const right = resolveWindowBounds({ x: 1300, y: 100, width: 1100, height: 700 }, [primary]);
  assert.equal(right.bounds.x, primary.x + primary.width - 1100);
});

test('a small display shrinks the default window but keeps the minimum size', () => {
  const small = { x: 0, y: 25, width: 1024, height: 700 };
  const centered = resolveWindowBounds(null, [small]);
  assert.deepEqual(centered.bounds, { x: 0, y: small.y, width: 1024, height: 700 });

  const tiny = { x: 0, y: 25, width: 800, height: 600 };
  const minimum = resolveWindowBounds(null, [tiny]);
  assert.equal(minimum.bounds.width, MIN_WINDOW_SIZE.width);
  assert.equal(minimum.bounds.height, MIN_WINDOW_SIZE.height);
});

test('missing display information still yields a usable window', () => {
  const result = resolveWindowBounds({ x: 100, y: 100, width: 1200, height: 800 }, []);
  assert.deepEqual(result.bounds, { x: 0, y: 0, ...DEFAULT_WINDOW_SIZE });
  assert.equal(result.restored, false);
});
