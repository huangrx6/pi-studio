import test from 'node:test';
import assert from 'node:assert/strict';
import { isComposingKey, menuFocusIndex } from '../../web/src/shared/keyboard-navigation.ts';

test('IME ownership includes native composition and legacy keycode 229', () => {
  assert.equal(isComposingKey({ isComposing: true }), true);
  assert.equal(isComposingKey({ isComposing: false, keyCode: 229 }), true);
  assert.equal(isComposingKey({ isComposing: false, keyCode: 27 }), false);
});
test('menu navigation handles empty, disabled-filtered, and missing focus positions', () => {
  assert.equal(menuFocusIndex('End', -1, 0), null);
  assert.equal(menuFocusIndex('Home', 2, 3), 0);
  assert.equal(menuFocusIndex('End', 0, 3), 2);
  assert.equal(menuFocusIndex('ArrowUp', -1, 3), 2);
  assert.equal(menuFocusIndex('ArrowDown', -1, 3), 0);
  assert.equal(menuFocusIndex('ArrowDown', 2, 3), 2);
  assert.equal(menuFocusIndex('ArrowDown', 2, 3, true), 0);
  assert.equal(menuFocusIndex('ArrowUp', 0, 3, true), 2);
  assert.equal(menuFocusIndex('Tab', 0, 3), null);
});
