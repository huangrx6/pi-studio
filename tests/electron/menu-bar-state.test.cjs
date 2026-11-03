const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  createMenuBarState,
  shouldPresentBackgroundNotification,
} = require('../../electron/menu-bar-state.cjs');

test('completion notifications stay quiet while the main window is in front', () => {
  const window = (input = {}) => ({
    isDestroyed: () => input.destroyed ?? false,
    isVisible: () => input.visible ?? true,
    isFocused: () => input.focused ?? true,
  });

  assert.equal(shouldPresentBackgroundNotification(window()), false);
  assert.equal(shouldPresentBackgroundNotification(window({ focused: false })), true);
  assert.equal(shouldPresentBackgroundNotification(window({ visible: false })), true);
  assert.equal(shouldPresentBackgroundNotification(window({ destroyed: true })), true);
  assert.equal(shouldPresentBackgroundNotification(undefined), true);
});

test('running sessions keep stable start times and accept generated titles', () => {
  let clock = 100;
  const state = createMenuBarState({ now: () => clock });
  state.start({ id: 'a', title: '  First   task ', cwd: '/repo', requestId: 'r1' });
  clock = 200;
  state.start({ id: 'b', title: 'Second task', cwd: '/repo' });
  clock = 300;
  assert.equal(state.updateTitle('a', 'A clearer title'), true);
  state.start({ id: 'a', title: 'ignored duplicate', cwd: '/repo', requestId: 'r2' });

  const snapshot = state.snapshot({ theme: 'dark' });
  assert.equal(snapshot.theme, 'dark');
  assert.deepEqual(snapshot.running.map(item => item.id), ['a', 'b']);
  assert.equal(snapshot.running[0].title, 'ignored duplicate');
  assert.equal(snapshot.running[0].startedAt, 100);
  assert.equal(snapshot.running[0].requestId, 'r2');
});

test('completion moves a session into recent results and preserves unread state', () => {
  let clock = 100;
  const state = createMenuBarState({ now: () => clock, recentLimit: 2 });
  state.start({ id: 'a', title: 'First', cwd: '/repo' });
  state.start({ id: 'b', title: 'Second', cwd: '/repo' });
  state.start({ id: 'c', title: 'Third', cwd: '/repo' });

  clock = 500;
  assert.equal(state.finish({ id: 'a', status: 'success' }).completedAt, 500);
  clock = 600;
  state.finish({ id: 'b', status: 'error', title: 'Second failed' });
  clock = 700;
  state.finish({ id: 'c', status: 'success' });

  let snapshot = state.snapshot();
  assert.deepEqual(snapshot.running, []);
  assert.deepEqual(snapshot.recent.map(item => item.id), ['c', 'b']);
  assert.equal(snapshot.recent[1].title, 'Second failed');
  assert.equal(snapshot.recent[1].status, 'error');
  assert.equal(snapshot.unreadCount, 2);

  assert.equal(state.markSeen(), true);
  snapshot = state.snapshot();
  assert.equal(snapshot.unreadCount, 0);
  assert.equal(state.markSeen(), false);
  assert.equal(state.clearRecent(), true);
  assert.deepEqual(state.snapshot().recent, []);
  assert.equal(state.clearRecent(), false);
});

test('running a session again drops its earlier completion instead of listing it twice', () => {
  let clock = 1_000;
  const state = createMenuBarState({ now: () => clock });
  state.start({ id: 'a', title: '优化方向', cwd: '/workspace/pi-studio' });
  state.start({ id: 'b', title: '另一个任务', cwd: '/workspace/pi-studio' });
  clock = 2_000;
  state.finish({ id: 'a', status: 'success' });
  clock = 3_000;
  state.finish({ id: 'b', status: 'success' });
  assert.deepEqual(state.snapshot().recent.map(item => item.id), ['b', 'a']);

  // The same conversation starts another turn: it may only appear as running.
  clock = 4_000;
  state.start({ id: 'a', title: '优化方向', cwd: '/workspace/pi-studio' });
  let snapshot = state.snapshot();
  assert.deepEqual(snapshot.running.map(item => item.id), ['a']);
  assert.deepEqual(snapshot.recent.map(item => item.id), ['b']);
  assert.equal(snapshot.unreadCount, 1);

  // Finishing again replaces the old record instead of stacking a second copy.
  clock = 5_000;
  assert.equal(state.finish({ id: 'a', status: 'success' }).completedAt, 5_000);
  snapshot = state.snapshot();
  assert.deepEqual(snapshot.recent.map(item => item.id), ['a', 'b']);
  assert.equal(snapshot.unreadCount, 2);
});

test('cancelled sessions leave the running tray without creating unread results', () => {
  const state = createMenuBarState({ now: () => 42 });
  state.start({ id: 'a', title: 'Task' });
  const result = state.finish({ id: 'a', status: 'cancelled' });
  assert.equal(result.status, 'cancelled');
  assert.equal(result.unread, false);
  assert.equal(state.snapshot().unreadCount, 0);
});

test('popover fits its rows and caps long lists without stretching the idle state', () => {
  const { menuBarPopoverHeight } = require('../../electron/menu-bar-state.cjs');
  assert.equal(menuBarPopoverHeight(), 196);
  assert.equal(menuBarPopoverHeight({ running: [{}] }), 252);
  assert.equal(menuBarPopoverHeight({ recent: [{}] }), 252);
  // Two sections add the extra gap so the second heading is not clipped.
  assert.equal(menuBarPopoverHeight({ running: [{}, {}], recent: [{}] }), 400);
  assert.equal(menuBarPopoverHeight({ running: Array(100).fill({}) }), 440);
});
