/**
 * Shortcut registry: matching, normalisation, conflicts and rendering.
 *
 * The renderer dispatches every configurable action through these helpers, so a
 * regression here silently breaks the shell's keyboard surface.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

const {
  DEFAULT_SHORTCUTS,
  SHORTCUT_ACTIONS,
  comboFromEvent,
  formatShortcut,
  matchesShortcut,
  normalizeCombo,
  normalizeShortcuts,
  shortcutConflict,
} = await import('../../web/src/shared/shortcuts.mjs');

/** Build a KeyboardEvent-shaped object; the helpers only read these fields. */
const keyEvent = (key, modifiers = {}) => ({
  key,
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  ...modifiers,
});

test('every action ships a canonical default and no duplicates', () => {
  assert.equal(Object.keys(DEFAULT_SHORTCUTS).length, SHORTCUT_ACTIONS.length);
  for (const action of SHORTCUT_ACTIONS) {
    assert.equal(normalizeCombo(action.default), action.default, action.id);
  }
  assert.equal(new Set(Object.values(DEFAULT_SHORTCUTS)).size, SHORTCUT_ACTIONS.length, 'defaults are unique');
});

test('normalises modifier order and rejects unusable values', () => {
  assert.equal(normalizeCombo('shift+mod+b'), 'Mod+Shift+B');
  assert.equal(normalizeCombo('Mod+b'), 'Mod+B');
  assert.equal(normalizeCombo('Mod'), '');
  assert.equal(normalizeCombo('Mod+Hyper+B'), '');
  assert.equal(normalizeCombo(''), '');
  assert.equal(normalizeCombo(undefined), '');
});

test('records combos from events and refuses bare keys', () => {
  // Ctrl is Mod on non-mac platforms; ⌘ is Mod on macOS.
  assert.equal(comboFromEvent(keyEvent('b', { ctrlKey: true }), 'other'), 'Mod+B');
  assert.equal(comboFromEvent(keyEvent('b', { metaKey: true }), 'mac'), 'Mod+B');
  assert.equal(comboFromEvent(keyEvent('b', { ctrlKey: true }), 'mac'), '', 'Ctrl is not the mac modifier');
  assert.equal(comboFromEvent(keyEvent('B', { ctrlKey: true, shiftKey: true }), 'other'), 'Mod+Shift+B');
  assert.equal(comboFromEvent(keyEvent('b'), 'other'), '', 'a bare letter would hijack typing');
  assert.equal(comboFromEvent(keyEvent('Shift', { ctrlKey: true }), 'other'), '');
});

test('matches stored combos against live events', () => {
  assert.equal(matchesShortcut(keyEvent('j', { ctrlKey: true }), 'Mod+J', 'other'), true);
  assert.equal(matchesShortcut(keyEvent('j', { metaKey: true }), 'Mod+J', 'mac'), true);
  assert.equal(matchesShortcut(keyEvent('j', { ctrlKey: true, shiftKey: true }), 'Mod+J', 'other'), false);
  assert.equal(matchesShortcut(keyEvent('j', { ctrlKey: true, repeat: true }), 'Mod+J', 'other'), false);
  assert.equal(matchesShortcut(keyEvent('j', { ctrlKey: true, isComposing: true }), 'Mod+J', 'other'), false);
  assert.equal(matchesShortcut(keyEvent('j', { ctrlKey: true }), '', 'other'), false);
});

test('prints platform-specific labels', () => {
  assert.equal(formatShortcut('Mod+Shift+B', true), '⌘⇧B');
  assert.equal(formatShortcut('Mod+Shift+B', false), 'Ctrl+Shift+B');
  assert.equal(formatShortcut('', true), '未设置');
});

test('merging stored bindings keeps defaults and drops garbage', () => {
  const merged = normalizeShortcuts({ toggleSidebar: 'alt+mod+k', unknown: 'Mod+Q', stopGeneration: 'nonsense' });
  assert.equal(merged.toggleSidebar, 'Mod+Alt+K');
  assert.equal(merged.stopGeneration, DEFAULT_SHORTCUTS.stopGeneration);
  assert.equal('unknown' in merged, false);
  assert.deepEqual(normalizeShortcuts(null), { ...DEFAULT_SHORTCUTS });
});

test('detects conflicts against the other actions', () => {
  assert.equal(shortcutConflict(DEFAULT_SHORTCUTS, 'toggleSidebar', 'Mod+J'), 'togglePanel');
  assert.equal(shortcutConflict(DEFAULT_SHORTCUTS, 'toggleSidebar', 'Mod+Shift+B'), 'openBrowser');
  assert.equal(shortcutConflict(DEFAULT_SHORTCUTS, 'togglePanel', 'Mod+J'), undefined);
  assert.equal(shortcutConflict(DEFAULT_SHORTCUTS, 'togglePanel', 'Mod+Alt+9'), undefined);
});
