import test from 'node:test';
import assert from 'node:assert/strict';
import {
  maximumPanelWidth,
  panelUsesOverlay,
  normalizePanelWidth,
} from '../../web/src/shell/right-panel/panel-width.ts';

test('panel preference accepts saved sizes and recovers invalid storage', () => {
  assert.equal(normalizePanelWidth(700), 700);
  assert.equal(normalizePanelWidth(430.4), 430);
  for (const value of [null, undefined, '700', -10, 0, NaN, Infinity, {}, []]) {
    assert.equal(normalizePanelWidth(value), 390);
  }
});

test('docked panel leaves a usable conversation and overlay respects window edges', () => {
  assert.equal(maximumPanelWidth(1440, 280), 680);
  assert.equal(maximumPanelWidth(1440, 0), 960);
  assert.equal(maximumPanelWidth(1120, 252), 388);
  assert.equal(maximumPanelWidth(980, 252), 320);
  assert.equal(maximumPanelWidth(1100, 252), 368);
  assert.equal(maximumPanelWidth(890, 252), 842);
  assert.equal(panelUsesOverlay(980, 252), false);
  assert.equal(panelUsesOverlay(980, 340), true);
  assert.equal(panelUsesOverlay(890, 0), false);
});
