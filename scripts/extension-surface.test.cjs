/**
 * 通用扩展 surface 宿主的单元测试：
 * 组件渲染、终端按键映射、尺寸变化与 dispose 都由宿主统一处理。
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createSurfaceHost } = require('../electron/services/extension-surface.cjs');

test('surface host renders component lines and forwards terminal keys', () => {
  const published = [];
  const received = [];
  const host = createSurfaceHost((snapshot) => published.push(snapshot));
  let disposed = false;
  host.set((tui) => ({
    render: (width) => [`width=${width}`, 'second'],
    handleInput: (data) => received.push(data),
    dispose: () => { disposed = true; },
  }));

  assert.equal(host.view.raw[0], 'width=100');
  assert.equal(host.view.lines[1].map((cell) => cell.text).join(''), 'second');
  assert.ok(published.length > 0);

  host.action({ type: 'resize', columns: 80, rows: 24 });
  assert.equal(host.view.raw[0], 'width=80');

  host.action({ type: 'key', key: 'Enter' });
  host.action({ type: 'key', key: 'ArrowDown' });
  host.action({ type: 'key', key: 'a' });
  assert.deepEqual(received, ['\r', '\x1b[B', 'a']);

  host.dispose();
  assert.equal(disposed, true);
});

test('surface host survives a throwing component and clears on release', () => {
  const host = createSurfaceHost(() => {});
  host.set(() => ({
    render: () => { throw new Error('boom'); },
  }));
  assert.deepEqual(host.view.lines, []);
  host.set(undefined);
  assert.equal(host.active, false);
});
