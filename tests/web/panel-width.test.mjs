import test from 'node:test';
import assert from 'node:assert/strict';
import {
  maximumPanelWidth,
  normalizePanelWidth,
  splitPanelWidth,
} from '../../web/src/shell/right-panel/panel-width.mjs';

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
  assert.equal(maximumPanelWidth(980, 252), 932);
  assert.equal(maximumPanelWidth(1100, 252), 1052);
});

test('split panel expands enough for the tree and persistent toolbar', () => {
  assert.equal(splitPanelWidth(320, 680), 560);
  assert.equal(splitPanelWidth(700, 680), 680);
  assert.equal(splitPanelWidth(900, 1200), 760);
  assert.equal(splitPanelWidth(320, 388), 388);
});
