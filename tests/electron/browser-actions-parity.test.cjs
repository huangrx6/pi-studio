const assert = require('node:assert/strict');
const test = require('node:test');

const { parseKeyCombo, resolveViewportSpec } = require('../../electron/main/services/browser/actions.cjs');
const {
  buildAgentCursorScript,
  buildAgentCursorStatusScript,
  buildClearOverlayScript,
  buildOverlayVisibilityScript,
} = require('../../electron/main/services/browser/overlay.cjs');
const {
  beginBrowserActivity,
  beginBrowserSession,
  endBrowserActivity,
  endBrowserSession,
  getBrowserControlState,
  hasActiveBrowserSession,
  setBrowserControlPaused,
  subscribeBrowserControl,
} = require('../../electron/main/services/browser/queue.cjs');

test('parseKeyCombo normalizes aliases and modifiers', () => {
  assert.deepEqual(parseKeyCombo('Esc'), { raw: 'Esc', keyCode: 'Escape', domKey: 'Escape', modifiers: [] });
  assert.deepEqual(parseKeyCombo('Shift+Tab'), { raw: 'Shift+Tab', keyCode: 'Tab', domKey: 'Tab', modifiers: ['shift'] });
  assert.deepEqual(parseKeyCombo('Ctrl+Alt+ArrowDown'), {
    raw: 'Ctrl+Alt+ArrowDown',
    keyCode: 'Down',
    domKey: 'ArrowDown',
    modifiers: ['control', 'alt'],
  });
  assert.throws(() => parseKeyCombo(''), /需要指定按键/);
});

test('resolveViewportSpec supports presets, custom clamped dimensions, and reset', () => {
  assert.deepEqual(resolveViewportSpec({ preset: 'desktop' }), { width: 1440, height: 900, label: '桌面 1440×900' });
  assert.deepEqual(resolveViewportSpec({ preset: 'mobile' }), { width: 390, height: 844, label: '手机 390×844' });
  assert.equal(resolveViewportSpec({ preset: 'reset' }), null);
  assert.equal(resolveViewportSpec({ reset: true }), null);
  assert.deepEqual(resolveViewportSpec({ width: 100, height: 4000 }), { width: 320, height: 1800, label: '320×1800' });
  assert.throws(() => resolveViewportSpec({}), /请提供 width 和 height/);
});

test('overlay scripts generate valid JS with race-safe generation guard and human-input dismiss', () => {
  const move = buildAgentCursorScript({ ref: 'e12', label: '点击「新建用户」', kind: 'click' });
  assert.doesNotThrow(() => new Function(move), 'cursor script must compile');
  assert.match(move, /pi-agent-overlay-root/);
  assert.match(move, /attachShadow/);
  assert.match(move, /pi-pointer/);
  assert.match(move, /pi-ripple/);
  assert.match(move, /点击「新建用户」/);
  assert.match(move, /__piOverlayGen/);
  assert.match(move, /cancelAnimationFrame/);
  assert.match(move, /isTrusted/);

  const hide = buildOverlayVisibilityScript(false);
  const show = buildOverlayVisibilityScript(true);
  const clear = buildClearOverlayScript();
  const status = buildAgentCursorStatusScript('AI 思考下一步…');
  const persistent = buildAgentCursorScript({ label: '输入「field-sizing」', kind: 'click', persistent: true });
  assert.doesNotThrow(() => new Function(hide));
  assert.doesNotThrow(() => new Function(show));
  assert.doesNotThrow(() => new Function(clear));
  assert.doesNotThrow(() => new Function(status));
  assert.doesNotThrow(() => new Function(persistent));
  assert.match(hide, /'hidden'/);
  assert.match(show, /'visible'/);
  assert.match(clear, /pi-agent-overlay-root/);
  assert.match(clear, /__piOverlayGen/);
  assert.match(status, /AI 思考下一步/);
  assert.match(persistent, /persistent = true/);
});

test('browser activity queue stays active in thinking state across a continuous session until endBrowserSession', () => {
  const events = [];
  const off = subscribeBrowserControl((payload) => events.push(payload));
  try {
    setBrowserControlPaused(false);
    beginBrowserSession('conv_1', { tabId: 'tab_1' });
    assert.equal(hasActiveBrowserSession(), true);
    const token = beginBrowserActivity({ tabId: 'tab_1', action: 'click', label: '点击「保存」' });
    assert.equal(getBrowserControlState().activity.active, true);
    assert.equal(getBrowserControlState().activity.thinking, false);
    assert.equal(getBrowserControlState().activity.label, '点击「保存」');
    assert.ok(events.some((e) => e.type === 'activity' && e.active === true && e.label === '点击「保存」'));

    endBrowserActivity(token);
    // Still active (thinking) because conv_1 session has not ended yet!
    assert.equal(getBrowserControlState().activity.active, true);
    assert.equal(getBrowserControlState().activity.thinking, true);

    endBrowserSession('conv_1');
    assert.equal(hasActiveBrowserSession(), false);
    assert.equal(getBrowserControlState().activity.active, false);

    setBrowserControlPaused(true);
    assert.equal(getBrowserControlState().paused, true);
    setBrowserControlPaused(false);
    assert.equal(getBrowserControlState().paused, false);
  } finally {
    endBrowserSession();
    off();
  }
});
