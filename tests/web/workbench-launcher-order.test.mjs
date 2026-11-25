import assert from 'node:assert/strict';
import test from 'node:test';
import { launcherToolOrder, moveLauncherEntry, orderLauncherEntries } from '../../web/src/shell/right-panel/launcher-order.ts';
import { normalizePreferences } from '../../web/src/shared/preferences.ts';

const ids = (entries, order) => orderLauncherEntries(entries.map(id => ({ id })), order).map(entry => entry.id);

test('the launcher starts with workspace tools and appends newly available extensions to the saved order', () => {
  assert.deepEqual(launcherToolOrder.slice(0, 3), ['files', 'git', 'terminal']);
  const entries = [...launcherToolOrder, 'user:reports', 'project:notes'];
  const saved = moveLauncherEntry([], entries, 'user:reports', 'files');
  assert.deepEqual(ids(entries, saved), ['user:reports', ...launcherToolOrder, 'project:notes']);
  assert.deepEqual(ids([...launcherToolOrder, 'user:new-app', 'user:reports', 'project:notes'], saved),
    ['user:reports', ...launcherToolOrder, 'project:notes', 'user:new-app']);
});

test('restoring an older launcher order skips the retired flow entry and preserves neighboring tools', () => {
  const saved = ['terminal', 'flow', 'user:reports', 'files'];
  const visible = [...launcherToolOrder, 'user:reports'];
  const restored = ids(visible, saved);
  assert.deepEqual(restored.slice(0, 3), ['terminal', 'user:reports', 'files']);
  assert.ok(!restored.includes('flow'));
});

test('moving visible entries keeps the slots of hidden tools and other workspaces', () => {
  const visible = ['files', 'terminal', 'user:reports'];
  const order = ['files', 'project:elsewhere', 'git', 'terminal', 'user:reports'];
  const moved = moveLauncherEntry(order, visible, 'user:reports', 'files');
  assert.deepEqual(moved.slice(0, 5), ['user:reports', 'project:elsewhere', 'git', 'files', 'terminal']);
  assert.deepEqual(ids(visible, moved), ['user:reports', 'files', 'terminal']);
  assert.deepEqual(moveLauncherEntry(order, visible, 'missing', 'files'), order);
});

test('launcher preferences restore valid tool and extension IDs once each', () => {
  assert.deepEqual(normalizePreferences({ workbenchLauncherOrder: ['files', 'user:reports', 'files', null, 'invalid/id'] }).workbenchLauncherOrder,
    ['files', 'user:reports']);
  assert.deepEqual(normalizePreferences({}).workbenchLauncherOrder, []);
});
