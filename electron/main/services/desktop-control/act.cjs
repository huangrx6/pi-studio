/**
 * Desktop write actions (click / type / scroll / drag / hotkey). Reuses window ownership + allow policy from observe/policy.
 */
const { listDesktopWindowsForApp, assertWindowBelongsToApp, defaultRunner } = require('./observe.cjs');

const DEFAULT_MAX_TYPE_CHARS = 2000;
const DEFAULT_SCROLL_AMOUNT = 3;
const MAX_SCROLL_AMOUNT = 40;
const DEFAULT_DRAG_STEPS = 12;
const MAX_DRAG_STEPS = 40;
const MAX_DRAG_DISTANCE = 3000;

/** Named non-character keys → macOS key codes for System Events. */
const NAMED_KEY_CODES = Object.freeze({
  return: 36,
  enter: 36,
  tab: 48,
  space: 49,
  escape: 53,
  esc: 53,
  delete: 51,
  backspace: 51,
  forwarddelete: 117,
  left: 123,
  right: 124,
  down: 125,
  up: 126,
  home: 115,
  end: 119,
  pageup: 116,
  pagedown: 121,
  f1: 122,
  f2: 120,
  f3: 99,
  f4: 118,
  f5: 96,
  f6: 97,
  f7: 98,
  f8: 100,
  f9: 101,
  f10: 109,
  f11: 103,
  f12: 111,
});

const MODIFIER_ALIASES = Object.freeze({
  cmd: 'command',
  command: 'command',
  meta: 'command',
  win: 'command',
  shift: 'shift',
  option: 'option',
  alt: 'option',
  opt: 'option',
  control: 'control',
  ctrl: 'control',
});

function centerOfBounds(bounds) {
  if (!bounds || typeof bounds !== 'object') return null;
  const width = Number(bounds.width) || 0;
  const height = Number(bounds.height) || 0;
  const x = Number(bounds.x) || 0;
  const y = Number(bounds.y) || 0;
  if (width <= 1 || height <= 1) return null;
  return {
    x: Math.round(x + width / 2),
    y: Math.round(y + height / 2),
  };
}

function pointInBounds(point, bounds, pad = 2) {
  if (!point || !bounds) return false;
  const x = Number(bounds.x) || 0;
  const y = Number(bounds.y) || 0;
  const width = Number(bounds.width) || 0;
  const height = Number(bounds.height) || 0;
  return point.x >= x - pad
    && point.y >= y - pad
    && point.x <= x + width + pad
    && point.y <= y + height + pad;
}

async function getWindowFrame(appTarget, windowId, deps = {}) {
  const owned = await assertWindowBelongsToApp(appTarget, windowId, deps);
  if (owned.minimized || owned.visible === false) {
    const error = new Error(
      `窗口 ${windowId} 当前不可见或已最小化，无法操作。请先恢复窗口。`,
    );
    error.code = 'desktop_window_not_visible';
    throw error;
  }

  if (typeof deps.getWindowFrame === 'function') {
    const frame = await deps.getWindowFrame(appTarget, windowId);
    return { ...owned, bounds: frame };
  }

  const runner = deps.runner || defaultRunner;
  const processName = String(appTarget?.name || '').trim();
  const script = `
function run(argv) {
  var target = String(argv[0] || '');
  var wantWindowId = Number(argv[1] || 0);
  var se = Application('System Events');
  var processes = se.processes.whose({ name: target })();
  if (!processes || !processes.length) throw new Error('process_not_found');
  var proc = processes[0];
  var windows = [];
  try { windows = proc.windows(); } catch (e) { windows = []; }
  for (var i = 0; i < windows.length; i++) {
    var win = windows[i];
    var id = null;
    try { id = Number(win.attributes.byName('AXWindowNumber').value()); } catch (e) { id = null; }
    if (id !== wantWindowId) continue;
    var pos = [0, 0];
    var size = [0, 0];
    try { pos = win.position(); } catch (e) {}
    try { size = win.size(); } catch (e) {}
    return JSON.stringify({
      x: Number(pos[0]) || 0,
      y: Number(pos[1]) || 0,
      width: Number(size[0]) || 0,
      height: Number(size[1]) || 0,
      title: (function () { try { return String(win.name()); } catch (e) { return ''; } })()
    });
  }
  throw new Error('window_not_found');
}
`.trim();

  try {
    const { stdout } = await runner(
      '/usr/bin/osascript',
      ['-l', 'JavaScript', '-e', script, processName, String(windowId)],
      { timeout: 10000 },
    );
    const text = String(stdout || '').trim();
    const frame = JSON.parse(text);
    return {
      ...owned,
      title: String(frame.title || owned.title || ''),
      bounds: {
        x: Number(frame.x) || 0,
        y: Number(frame.y) || 0,
        width: Number(frame.width) || 0,
        height: Number(frame.height) || 0,
      },
    };
  } catch (cause) {
    const message = String(cause && cause.message ? cause.message : cause);
    if (/window_not_found/i.test(message)) {
      const error = new Error('找不到指定窗口。请先用 desktop_windows 确认 windowId。');
      error.code = 'desktop_window_not_found';
      throw error;
    }
    const error = new Error(`无法读取窗口位置：${message}`);
    error.code = 'desktop_window_frame_failed';
    error.cause = cause;
    throw error;
  }
}

async function resolveClickTarget(appTarget, options = {}, deps = {}) {
  const windowId = options.windowId != null ? Number(options.windowId) : NaN;
  if (!windowId || Number.isNaN(windowId)) {
    const error = new Error('点击需要明确的 windowId。请先用 desktop_windows 获取窗口。');
    error.code = 'desktop_window_required';
    throw error;
  }

  const frame = await getWindowFrame(appTarget, windowId, deps);
  const ref = String(options.ref || '').trim();
  const path = String(options.path || '').trim();
  const hasCoords = options.x != null && options.y != null;

  if (ref || path) {
    if (typeof deps.resolveNode === 'function') {
      const node = await deps.resolveNode(appTarget, { windowId, ref, path });
      if (!node) {
        const error = new Error('找不到指定控件。请重新 desktop_snapshot 后再用 ref/path 点击。');
        error.code = 'desktop_target_not_found';
        throw error;
      }
      if (node.secure) {
        const error = new Error('不会点击密码或安全输入控件。');
        error.code = 'desktop_secure_target';
        throw error;
      }
      const point = centerOfBounds(node.bounds);
      if (!point) {
        const error = new Error('目标控件没有可用位置，无法点击。');
        error.code = 'desktop_target_no_bounds';
        throw error;
      }
      if (!pointInBounds(point, frame.bounds, 8)) {
        const error = new Error('目标控件不在指定窗口范围内，已拒绝点击。');
        error.code = 'desktop_target_outside_window';
        throw error;
      }
      return {
        windowId,
        point,
        ref: node.ref || ref,
        path: node.path || path,
        role: node.role || '',
        name: node.name || '',
        title: frame.title || '',
        mode: 'ref',
      };
    }

    const runner = deps.runner || defaultRunner;
    const processName = String(appTarget?.name || '').trim();
    const script = `
function run(argv) {
  var target = String(argv[0] || '');
  var wantWindowId = Number(argv[1] || 0);
  var wantRef = String(argv[2] || '');
  var wantPath = String(argv[3] || '');
  var se = Application('System Events');
  var processes = se.processes.whose({ name: target })();
  if (!processes || !processes.length) throw new Error('process_not_found');
  var proc = processes[0];
  var windows = [];
  try { windows = proc.windows(); } catch (e) { windows = []; }
  var win = null;
  for (var i = 0; i < windows.length; i++) {
    var candidate = windows[i];
    var id = null;
    try { id = Number(candidate.attributes.byName('AXWindowNumber').value()); } catch (e) { id = null; }
    if (id === wantWindowId) { win = candidate; break; }
  }
  if (!win) throw new Error('window_not_found');

  var found = null;
  var counter = 0;
  function roleOf(el) { try { return String(el.role()); } catch (e) { return ''; } }
  function titleOf(el) {
    try { return String(el.title()); } catch (e) {
      try { return String(el.name()); } catch (e2) { return ''; }
    }
  }
  function descriptionOf(el) { try { return String(el.description()); } catch (e) { return ''; } }
  function subroleOf(el) { try { return String(el.subrole()); } catch (e) { return ''; } }
  function isSecure(el, role, subrole, description) {
    var text = (String(role || '') + ' ' + String(subrole || '') + ' ' + String(description || '')).toLowerCase();
    if (text.indexOf('secure') >= 0 || text.indexOf('password') >= 0) return true;
    return false;
  }
  function boundsOf(el) {
    try {
      var p = el.position();
      var s = el.size();
      return { x: Number(p[0]), y: Number(p[1]), width: Number(s[0]), height: Number(s[1]) };
    } catch (e) { return null; }
  }
  function walk(el, depth, path) {
    if (found || depth > 40) return;
    var role = roleOf(el);
    var name = titleOf(el);
    var description = descriptionOf(el);
    var subrole = subroleOf(el);
    var secure = isSecure(el, role, subrole, description);
    var bounds = boundsOf(el);
    var ref = '';
    if (role || name || description || bounds) {
      counter += 1;
      ref = 'n' + counter;
      if ((wantRef && ref === wantRef) || (wantPath && path === wantPath)) {
        found = {
          ref: ref,
          path: path,
          role: role,
          name: name,
          secure: secure,
          bounds: bounds
        };
        return;
      }
    }
    var children = [];
    try { children = el.uiElements(); } catch (e) { children = []; }
    for (var i = 0; i < children.length; i++) {
      if (found) break;
      walk(children[i], depth + 1, path ? (path + '/' + (i + 1)) : String(i + 1));
    }
  }
  walk(win, 0, '1');
  if (!found) throw new Error('target_not_found');
  return JSON.stringify(found);
}
`.trim();

    try {
      const { stdout } = await runner(
        '/usr/bin/osascript',
        ['-l', 'JavaScript', '-e', script, processName, String(windowId), ref, path],
        { timeout: 15000 },
      );
      const node = JSON.parse(String(stdout || '').trim());
      if (node.secure) {
        const error = new Error('不会点击密码或安全输入控件。');
        error.code = 'desktop_secure_target';
        throw error;
      }
      const point = centerOfBounds(node.bounds);
      if (!point) {
        const error = new Error('目标控件没有可用位置，无法点击。');
        error.code = 'desktop_target_no_bounds';
        throw error;
      }
      if (!pointInBounds(point, frame.bounds, 8)) {
        const error = new Error('目标控件不在指定窗口范围内，已拒绝点击。');
        error.code = 'desktop_target_outside_window';
        throw error;
      }
      return {
        windowId,
        point,
        ref: node.ref || ref,
        path: node.path || path,
        role: node.role || '',
        name: node.name || '',
        title: frame.title || '',
        mode: 'ref',
      };
    } catch (cause) {
      if (cause && cause.code && String(cause.code).startsWith('desktop_')) throw cause;
      const message = String(cause && cause.message ? cause.message : cause);
      if (/target_not_found/i.test(message)) {
        const error = new Error('找不到指定控件。请重新 desktop_snapshot 后再用 ref/path 点击。');
        error.code = 'desktop_target_not_found';
        throw error;
      }
      if (/window_not_found/i.test(message)) {
        const error = new Error('找不到指定窗口。请先用 desktop_windows 确认 windowId。');
        error.code = 'desktop_window_not_found';
        throw error;
      }
      const error = new Error(`无法定位点击目标：${message}`);
      error.code = 'desktop_target_resolve_failed';
      error.cause = cause;
      throw error;
    }
  }

  if (hasCoords) {
    const point = {
      x: Math.round(Number(options.x)),
      y: Math.round(Number(options.y)),
    };
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) {
      const error = new Error('点击坐标无效。');
      error.code = 'desktop_invalid_point';
      throw error;
    }
    if (!pointInBounds(point, frame.bounds, 2)) {
      const error = new Error('点击坐标不在指定窗口范围内，已拒绝。');
      error.code = 'desktop_point_outside_window';
      throw error;
    }
    return {
      windowId,
      point,
      ref: '',
      path: '',
      role: '',
      name: '',
      title: frame.title || '',
      mode: 'point',
    };
  }

  const error = new Error('请提供 snapshot 的 ref/path，或窗口内的屏幕坐标 x/y。');
  error.code = 'desktop_click_target_required';
  throw error;
}

async function clickDesktop(appTarget, options = {}, deps = {}) {
  if ((deps.platform || process.platform) !== 'darwin') {
    const error = new Error('电脑操控目前仅支持 macOS。');
    error.code = 'desktop_unsupported_platform';
    throw error;
  }
  const target = await resolveClickTarget(appTarget, options, deps);
  if (typeof deps.click === 'function') {
    return deps.click(appTarget, {
      ...options,
      windowId: target.windowId,
      x: target.point.x,
      y: target.point.y,
      ref: target.ref,
      path: target.path,
      resolved: target,
    });
  }

  const runner = deps.runner || defaultRunner;
  const processName = String(appTarget?.name || '').trim();
  const button = String(options.button || 'left').toLowerCase() === 'right' ? 'right' : 'left';

  const script = `
ObjC.import('Cocoa');
function run(argv) {
  var appName = String(argv[0] || '');
  var x = Number(argv[1] || 0);
  var y = Number(argv[2] || 0);
  var button = String(argv[3] || 'left');
  try {
    if (appName) {
      var app = Application(appName);
      app.includeStandardAdditions = true;
      app.activate();
      delay(0.05);
    }
  } catch (e) {}
  var point = $.CGPointMake(x, y);
  var mouseButton = button === 'right' ? $.kCGMouseButtonRight : $.kCGMouseButtonLeft;
  var downType = button === 'right' ? $.kCGEventRightMouseDown : $.kCGEventLeftMouseDown;
  var upType = button === 'right' ? $.kCGEventRightMouseUp : $.kCGEventLeftMouseUp;
  var down = $.CGEventCreateMouseEvent(null, downType, point, mouseButton);
  var up = $.CGEventCreateMouseEvent(null, upType, point, mouseButton);
  $.CGEventPost($.kCGHIDEventTap, down);
  delay(0.02);
  $.CGEventPost($.kCGHIDEventTap, up);
  return JSON.stringify({ ok: true, x: x, y: y, button: button });
}
`.trim();

  try {
    await runner(
      '/usr/bin/osascript',
      ['-l', 'JavaScript', '-e', script, processName, String(target.point.x), String(target.point.y), button],
      { timeout: 10000 },
    );
    return {
      ok: true,
      appName: String(appTarget?.name || ''),
      bundleId: String(appTarget?.bundleId || ''),
      windowId: target.windowId,
      title: target.title || '',
      x: target.point.x,
      y: target.point.y,
      button,
      ref: target.ref || '',
      path: target.path || '',
      role: target.role || '',
      name: target.name || '',
      mode: target.mode,
    };
  } catch (cause) {
    const error = new Error(`点击失败：${cause && cause.message ? cause.message : cause}`);
    error.code = 'desktop_click_failed';
    error.cause = cause;
    throw error;
  }
}

function normalizeTypeText(value, maxChars = DEFAULT_MAX_TYPE_CHARS) {
  const text = String(value ?? '');
  if (!text) {
    const error = new Error('请提供要输入的文本。');
    error.code = 'desktop_type_empty';
    throw error;
  }
  if (text.length > maxChars) {
    const error = new Error(`输入文本过长（最多 ${maxChars} 个字符）。`);
    error.code = 'desktop_type_too_long';
    throw error;
  }
  // Reject NULs and other control chars except tab/newline.
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(text)) {
    const error = new Error('输入文本包含不支持的控制字符。');
    error.code = 'desktop_type_invalid';
    throw error;
  }
  return text;
}

async function typeDesktop(appTarget, options = {}, deps = {}) {
  if ((deps.platform || process.platform) !== 'darwin') {
    const error = new Error('电脑操控目前仅支持 macOS。');
    error.code = 'desktop_unsupported_platform';
    throw error;
  }

  const text = normalizeTypeText(options.text, options.maxChars || DEFAULT_MAX_TYPE_CHARS);
  const windowId = options.windowId != null ? Number(options.windowId) : NaN;
  if (!windowId || Number.isNaN(windowId)) {
    const error = new Error('输入需要明确的 windowId。请先用 desktop_windows 获取窗口。');
    error.code = 'desktop_window_required';
    throw error;
  }

  // Ensure window is owned + visible first.
  const frame = await getWindowFrame(appTarget, windowId, deps);

  let focused = {
    ref: '',
    path: '',
    role: '',
    name: '',
    secure: false,
  };

  const hasTarget = Boolean(String(options.ref || '').trim() || String(options.path || options.elementPath || '').trim());
  if (hasTarget) {
    const target = await resolveClickTarget(appTarget, {
      windowId,
      ref: options.ref,
      path: options.path || options.elementPath,
    }, deps);
    focused = {
      ref: target.ref || '',
      path: target.path || '',
      role: target.role || '',
      name: target.name || '',
      secure: false,
    };
    // Click-to-focus first when a concrete control is provided.
    await clickDesktop(appTarget, {
      windowId,
      ref: options.ref,
      path: options.path || options.elementPath,
      button: 'left',
    }, deps);
  } else if (typeof deps.getFocusedNode === 'function') {
    const node = await deps.getFocusedNode(appTarget, { windowId });
    if (node) {
      focused = {
        ref: node.ref || '',
        path: node.path || '',
        role: node.role || '',
        name: node.name || '',
        secure: Boolean(node.secure),
      };
    }
  } else {
    // Best-effort focused element inspection.
    const runner = deps.runner || defaultRunner;
    const processName = String(appTarget?.name || '').trim();
    const script = `
function run(argv) {
  var target = String(argv[0] || '');
  var wantWindowId = Number(argv[1] || 0);
  var se = Application('System Events');
  var processes = se.processes.whose({ name: target })();
  if (!processes || !processes.length) throw new Error('process_not_found');
  var proc = processes[0];
  var windows = [];
  try { windows = proc.windows(); } catch (e) { windows = []; }
  var win = null;
  for (var i = 0; i < windows.length; i++) {
    var candidate = windows[i];
    var id = null;
    try { id = Number(candidate.attributes.byName('AXWindowNumber').value()); } catch (e) { id = null; }
    if (id === wantWindowId) { win = candidate; break; }
  }
  if (!win) throw new Error('window_not_found');
  var focused = null;
  try { focused = se.uiElements().whose({ focused: true })(); } catch (e) { focused = null; }
  if (!focused || !focused.length) {
    try { focused = proc.uiElements().whose({ focused: true })(); } catch (e2) { focused = null; }
  }
  if (!focused || !focused.length) {
    return JSON.stringify({ role: '', name: '', secure: false });
  }
  var el = focused[0];
  var role = '';
  var name = '';
  var subrole = '';
  var description = '';
  try { role = String(el.role()); } catch (e) {}
  try { name = String(el.title()); } catch (e) { try { name = String(el.name()); } catch (e2) {} }
  try { subrole = String(el.subrole()); } catch (e) {}
  try { description = String(el.description()); } catch (e) {}
  var text = (role + ' ' + subrole + ' ' + description).toLowerCase();
  var secure = text.indexOf('secure') >= 0 || text.indexOf('password') >= 0;
  return JSON.stringify({ role: role, name: name, secure: secure });
}
`.trim();
    try {
      const { stdout } = await runner(
        '/usr/bin/osascript',
        ['-l', 'JavaScript', '-e', script, processName, String(windowId)],
        { timeout: 10000 },
      );
      const node = JSON.parse(String(stdout || '').trim() || '{}');
      focused = {
        ref: '',
        path: '',
        role: String(node.role || ''),
        name: String(node.name || ''),
        secure: Boolean(node.secure),
      };
    } catch {
      /* ignore focus probe failures; typing may still work on current focus */
    }
  }

  if (focused.secure) {
    const error = new Error('不会向密码或安全输入框输入内容。');
    error.code = 'desktop_secure_target';
    throw error;
  }

  if (typeof deps.type === 'function') {
    return deps.type(appTarget, {
      ...options,
      windowId,
      text,
      focused,
      title: frame.title || '',
    });
  }

  const runner = deps.runner || defaultRunner;
  const processName = String(appTarget?.name || '').trim();
  // Use System Events keystroke in chunks to avoid oversized argv.
  const chunkSize = 120;
  const chunks = [];
  for (let i = 0; i < text.length; i += chunkSize) chunks.push(text.slice(i, i + chunkSize));

  try {
    if (processName) {
      const activate = `
function run(argv) {
  var appName = String(argv[0] || '');
  if (!appName) return;
  try {
    var app = Application(appName);
    app.includeStandardAdditions = true;
    app.activate();
  } catch (e) {}
}
`.trim();
      await runner('/usr/bin/osascript', ['-l', 'JavaScript', '-e', activate, processName], { timeout: 5000 });
    }

    for (const chunk of chunks) {
      const script = `
function run(argv) {
  var text = String(argv[0] || '');
  var se = Application('System Events');
  se.includeStandardAdditions = true;
  // keystroke supports plain text; newlines are sent as return.
  var parts = text.split('\\n');
  for (var i = 0; i < parts.length; i++) {
    if (parts[i]) se.keystroke(parts[i]);
    if (i < parts.length - 1) se.keyCode(36); // return
  }
  return 'ok';
}
`.trim();
      await runner('/usr/bin/osascript', ['-l', 'JavaScript', '-e', script, chunk], { timeout: 15000 });
    }

    return {
      ok: true,
      appName: String(appTarget?.name || ''),
      bundleId: String(appTarget?.bundleId || ''),
      windowId,
      title: frame.title || '',
      chars: text.length,
      ref: focused.ref || '',
      path: focused.path || '',
      role: focused.role || '',
      name: focused.name || '',
      mode: hasTarget ? 'target' : 'focused',
    };
  } catch (cause) {
    if (cause && cause.code && String(cause.code).startsWith('desktop_')) throw cause;
    const error = new Error(`输入失败：${cause && cause.message ? cause.message : cause}`);
    error.code = 'desktop_type_failed';
    error.cause = cause;
    throw error;
  }
}

function normalizeScrollDelta(options = {}) {
  const hasDx = options.dx != null && options.dx !== '';
  const hasDy = options.dy != null && options.dy !== '';
  let dx = 0;
  let dy = 0;
  let direction = '';

  if (hasDx || hasDy) {
    dx = Math.trunc(Number(options.dx) || 0);
    dy = Math.trunc(Number(options.dy) || 0);
    if (!Number.isFinite(dx) || !Number.isFinite(dy) || (dx === 0 && dy === 0)) {
      const error = new Error('请提供非零的滚动增量 dx/dy，或使用 direction + amount。');
      error.code = 'desktop_scroll_invalid';
      throw error;
    }
  } else {
    direction = String(options.direction || 'down').trim().toLowerCase();
    let amount = options.amount == null || options.amount === ''
      ? DEFAULT_SCROLL_AMOUNT
      : Math.trunc(Number(options.amount));
    if (!Number.isFinite(amount) || amount <= 0) {
      const error = new Error('滚动步数 amount 必须是正整数。');
      error.code = 'desktop_scroll_invalid';
      throw error;
    }
    if (amount > MAX_SCROLL_AMOUNT) {
      const error = new Error(`滚动步数过大（最多 ${MAX_SCROLL_AMOUNT}）。`);
      error.code = 'desktop_scroll_too_large';
      throw error;
    }
    // CGEvent: positive vertical delta scrolls up; positive horizontal scrolls left.
    switch (direction) {
      case 'up':
        dy = amount;
        break;
      case 'down':
        dy = -amount;
        break;
      case 'left':
        dx = amount;
        break;
      case 'right':
        dx = -amount;
        break;
      default: {
        const error = new Error('direction 仅支持 up / down / left / right。');
        error.code = 'desktop_scroll_invalid';
        throw error;
      }
    }
  }

  if (Math.abs(dx) > MAX_SCROLL_AMOUNT || Math.abs(dy) > MAX_SCROLL_AMOUNT) {
    const error = new Error(`滚动增量过大（每轴最多 ${MAX_SCROLL_AMOUNT}）。`);
    error.code = 'desktop_scroll_too_large';
    throw error;
  }

  return {
    dx,
    dy,
    direction: direction || (dy > 0 ? 'up' : dy < 0 ? 'down' : dx > 0 ? 'left' : 'right'),
    amount: Math.max(Math.abs(dx), Math.abs(dy)),
  };
}

async function resolveScrollPoint(appTarget, options = {}, deps = {}) {
  const windowId = options.windowId != null ? Number(options.windowId) : NaN;
  if (!windowId || Number.isNaN(windowId)) {
    const error = new Error('滚动需要明确的 windowId。请先用 desktop_windows 获取窗口。');
    error.code = 'desktop_window_required';
    throw error;
  }

  const frame = await getWindowFrame(appTarget, windowId, deps);
  const hasRef = Boolean(String(options.ref || '').trim() || String(options.path || options.elementPath || '').trim());
  const hasCoords = options.x != null || options.y != null;

  if (hasRef) {
    const target = await resolveClickTarget(appTarget, {
      windowId,
      ref: options.ref,
      path: options.path || options.elementPath,
    }, deps);
    return {
      windowId,
      point: target.point,
      ref: target.ref || '',
      path: target.path || '',
      role: target.role || '',
      name: target.name || '',
      title: target.title || frame.title || '',
      mode: 'ref',
      bounds: frame.bounds,
    };
  }

  if (hasCoords) {
    const point = {
      x: Math.round(Number(options.x)),
      y: Math.round(Number(options.y)),
    };
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) {
      const error = new Error('滚动坐标无效。');
      error.code = 'desktop_invalid_point';
      throw error;
    }
    if (!pointInBounds(point, frame.bounds, 2)) {
      const error = new Error('滚动坐标不在指定窗口范围内，已拒绝。');
      error.code = 'desktop_point_outside_window';
      throw error;
    }
    return {
      windowId,
      point,
      ref: '',
      path: '',
      role: '',
      name: '',
      title: frame.title || '',
      mode: 'point',
      bounds: frame.bounds,
    };
  }

  const center = centerOfBounds(frame.bounds);
  if (!center) {
    const error = new Error('无法确定窗口中心，拒绝滚动。');
    error.code = 'desktop_window_frame_failed';
    throw error;
  }
  return {
    windowId,
    point: center,
    ref: '',
    path: '',
    role: '',
    name: '',
    title: frame.title || '',
    mode: 'window',
    bounds: frame.bounds,
  };
}

async function scrollDesktop(appTarget, options = {}, deps = {}) {
  if ((deps.platform || process.platform) !== 'darwin') {
    const error = new Error('电脑操控目前仅支持 macOS。');
    error.code = 'desktop_unsupported_platform';
    throw error;
  }

  const delta = normalizeScrollDelta(options);
  const target = await resolveScrollPoint(appTarget, options, deps);

  if (typeof deps.scroll === 'function') {
    return deps.scroll(appTarget, {
      ...options,
      windowId: target.windowId,
      x: target.point.x,
      y: target.point.y,
      dx: delta.dx,
      dy: delta.dy,
      direction: delta.direction,
      amount: delta.amount,
      ref: target.ref,
      path: target.path,
      resolved: target,
    });
  }

  const runner = deps.runner || defaultRunner;
  const processName = String(appTarget?.name || '').trim();
  const script = `
ObjC.import('Cocoa');
function run(argv) {
  var appName = String(argv[0] || '');
  var x = Number(argv[1] || 0);
  var y = Number(argv[2] || 0);
  var dx = Number(argv[3] || 0);
  var dy = Number(argv[4] || 0);
  try {
    if (appName) {
      var app = Application(appName);
      app.includeStandardAdditions = true;
      app.activate();
      delay(0.05);
    }
  } catch (e) {}
  var point = $.CGPointMake(x, y);
  // Move cursor over the target so the scroll lands on the right surface.
  var move = $.CGEventCreateMouseEvent(null, $.kCGEventMouseMoved, point, $.kCGMouseButtonLeft);
  $.CGEventPost($.kCGHIDEventTap, move);
  delay(0.02);
  var wheelCount = (dx !== 0 && dy !== 0) ? 2 : 1;
  var event = null;
  if (dx !== 0 && dy !== 0) {
    event = $.CGEventCreateScrollWheelEvent(null, $.kCGScrollEventUnitLine, 2, dy, dx);
  } else if (dx !== 0) {
    event = $.CGEventCreateScrollWheelEvent(null, $.kCGScrollEventUnitLine, 2, 0, dx);
  } else {
    event = $.CGEventCreateScrollWheelEvent(null, $.kCGScrollEventUnitLine, 1, dy);
  }
  $.CGEventSetLocation(event, point);
  $.CGEventPost($.kCGHIDEventTap, event);
  return JSON.stringify({ ok: true, x: x, y: y, dx: dx, dy: dy, wheelCount: wheelCount });
}
`.trim();

  try {
    await runner(
      '/usr/bin/osascript',
      [
        '-l', 'JavaScript', '-e', script,
        processName,
        String(target.point.x),
        String(target.point.y),
        String(delta.dx),
        String(delta.dy),
      ],
      { timeout: 10000 },
    );
    return {
      ok: true,
      appName: String(appTarget?.name || ''),
      bundleId: String(appTarget?.bundleId || ''),
      windowId: target.windowId,
      title: target.title || '',
      x: target.point.x,
      y: target.point.y,
      dx: delta.dx,
      dy: delta.dy,
      direction: delta.direction,
      amount: delta.amount,
      ref: target.ref || '',
      path: target.path || '',
      role: target.role || '',
      name: target.name || '',
      mode: target.mode,
    };
  } catch (cause) {
    if (cause && cause.code && String(cause.code).startsWith('desktop_')) throw cause;
    const error = new Error(`滚动失败：${cause && cause.message ? cause.message : cause}`);
    error.code = 'desktop_scroll_failed';
    error.cause = cause;
    throw error;
  }
}

async function resolveDragEndpoint(appTarget, options = {}, deps = {}, label = 'start') {
  const windowId = options.windowId != null ? Number(options.windowId) : NaN;
  if (!windowId || Number.isNaN(windowId)) {
    const error = new Error('拖拽需要明确的 windowId。请先用 desktop_windows 获取窗口。');
    error.code = 'desktop_window_required';
    throw error;
  }

  const frame = options.frame || await getWindowFrame(appTarget, windowId, deps);
  const ref = String(options.ref || '').trim();
  const path = String(options.path || options.elementPath || '').trim();
  const hasCoords = options.x != null || options.y != null;

  if (ref || path) {
    const target = await resolveClickTarget(appTarget, {
      windowId,
      ref,
      path,
    }, deps);
    return {
      windowId,
      point: target.point,
      ref: target.ref || '',
      path: target.path || '',
      role: target.role || '',
      name: target.name || '',
      title: target.title || frame.title || '',
      mode: 'ref',
      frame,
    };
  }

  if (hasCoords) {
    const point = {
      x: Math.round(Number(options.x)),
      y: Math.round(Number(options.y)),
    };
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) {
      const error = new Error(label === 'end' ? '拖拽终点坐标无效。' : '拖拽起点坐标无效。');
      error.code = 'desktop_invalid_point';
      throw error;
    }
    if (!pointInBounds(point, frame.bounds, 2)) {
      const error = new Error(label === 'end'
        ? '拖拽终点不在指定窗口范围内，已拒绝。'
        : '拖拽起点不在指定窗口范围内，已拒绝。');
      error.code = 'desktop_point_outside_window';
      throw error;
    }
    return {
      windowId,
      point,
      ref: '',
      path: '',
      role: '',
      name: '',
      title: frame.title || '',
      mode: 'point',
      frame,
    };
  }

  const error = new Error(label === 'end'
    ? '请提供拖拽终点：toRef/toElementPath 或 toX/toY。'
    : '请提供拖拽起点：ref/elementPath 或 x/y。');
  error.code = 'desktop_drag_target_required';
  throw error;
}

function normalizeDragSteps(value) {
  if (value == null || value === '') return DEFAULT_DRAG_STEPS;
  const steps = Math.trunc(Number(value));
  if (!Number.isFinite(steps) || steps < 1) {
    const error = new Error('拖拽 steps 必须是正整数。');
    error.code = 'desktop_drag_invalid';
    throw error;
  }
  if (steps > MAX_DRAG_STEPS) {
    const error = new Error(`拖拽 steps 过大（最多 ${MAX_DRAG_STEPS}）。`);
    error.code = 'desktop_drag_invalid';
    throw error;
  }
  return steps;
}

async function dragDesktop(appTarget, options = {}, deps = {}) {
  if ((deps.platform || process.platform) !== 'darwin') {
    const error = new Error('电脑操控目前仅支持 macOS。');
    error.code = 'desktop_unsupported_platform';
    throw error;
  }

  const windowId = options.windowId != null ? Number(options.windowId) : NaN;
  if (!windowId || Number.isNaN(windowId)) {
    const error = new Error('拖拽需要明确的 windowId。请先用 desktop_windows 获取窗口。');
    error.code = 'desktop_window_required';
    throw error;
  }

  const frame = await getWindowFrame(appTarget, windowId, deps);
  const start = await resolveDragEndpoint(appTarget, {
    windowId,
    frame,
    ref: options.ref || options.fromRef,
    path: options.path || options.elementPath || options.fromPath || options.fromElementPath,
    elementPath: options.elementPath || options.fromElementPath,
    x: options.x != null ? options.x : options.fromX,
    y: options.y != null ? options.y : options.fromY,
  }, deps, 'start');

  const end = await resolveDragEndpoint(appTarget, {
    windowId,
    frame,
    ref: options.toRef || options.endRef,
    path: options.toPath || options.toElementPath || options.endPath || options.endElementPath,
    elementPath: options.toElementPath || options.endElementPath,
    x: options.toX != null ? options.toX : options.endX,
    y: options.toY != null ? options.toY : options.endY,
  }, deps, 'end');

  const dx = end.point.x - start.point.x;
  const dy = end.point.y - start.point.y;
  const distance = Math.hypot(dx, dy);
  if (distance < 1) {
    const error = new Error('拖拽起终点过近，请提供有效位移。');
    error.code = 'desktop_drag_too_short';
    throw error;
  }
  if (distance > MAX_DRAG_DISTANCE) {
    const error = new Error(`拖拽距离过大（最多 ${MAX_DRAG_DISTANCE}px）。`);
    error.code = 'desktop_drag_too_far';
    throw error;
  }

  const steps = normalizeDragSteps(options.steps);

  if (typeof deps.drag === 'function') {
    return deps.drag(appTarget, {
      ...options,
      windowId,
      fromX: start.point.x,
      fromY: start.point.y,
      toX: end.point.x,
      toY: end.point.y,
      steps,
      start,
      end,
    });
  }

  const runner = deps.runner || defaultRunner;
  const processName = String(appTarget?.name || '').trim();
  const script = `
ObjC.import('Cocoa');
function run(argv) {
  var appName = String(argv[0] || '');
  var x1 = Number(argv[1] || 0);
  var y1 = Number(argv[2] || 0);
  var x2 = Number(argv[3] || 0);
  var y2 = Number(argv[4] || 0);
  var steps = Math.max(1, Number(argv[5] || 12));
  try {
    if (appName) {
      var app = Application(appName);
      app.includeStandardAdditions = true;
      app.activate();
      delay(0.05);
    }
  } catch (e) {}
  var start = $.CGPointMake(x1, y1);
  var end = $.CGPointMake(x2, y2);
  var move = $.CGEventCreateMouseEvent(null, $.kCGEventMouseMoved, start, $.kCGMouseButtonLeft);
  $.CGEventPost($.kCGHIDEventTap, move);
  delay(0.02);
  var down = $.CGEventCreateMouseEvent(null, $.kCGEventLeftMouseDown, start, $.kCGMouseButtonLeft);
  $.CGEventPost($.kCGHIDEventTap, down);
  delay(0.03);
  for (var i = 1; i <= steps; i++) {
    var t = i / steps;
    var x = x1 + (x2 - x1) * t;
    var y = y1 + (y2 - y1) * t;
    var point = $.CGPointMake(x, y);
    var drag = $.CGEventCreateMouseEvent(null, $.kCGEventLeftMouseDragged, point, $.kCGMouseButtonLeft);
    $.CGEventPost($.kCGHIDEventTap, drag);
    delay(0.008);
  }
  var up = $.CGEventCreateMouseEvent(null, $.kCGEventLeftMouseUp, end, $.kCGMouseButtonLeft);
  $.CGEventPost($.kCGHIDEventTap, up);
  return JSON.stringify({ ok: true, fromX: x1, fromY: y1, toX: x2, toY: y2, steps: steps });
}
`.trim();

  try {
    await runner(
      '/usr/bin/osascript',
      [
        '-l', 'JavaScript', '-e', script,
        processName,
        String(start.point.x),
        String(start.point.y),
        String(end.point.x),
        String(end.point.y),
        String(steps),
      ],
      { timeout: 15000 },
    );
    return {
      ok: true,
      appName: String(appTarget?.name || ''),
      bundleId: String(appTarget?.bundleId || ''),
      windowId,
      title: start.title || end.title || frame.title || '',
      fromX: start.point.x,
      fromY: start.point.y,
      toX: end.point.x,
      toY: end.point.y,
      dx: Math.round(dx),
      dy: Math.round(dy),
      distance: Math.round(distance),
      steps,
      fromRef: start.ref || '',
      fromPath: start.path || '',
      fromRole: start.role || '',
      fromName: start.name || '',
      toRef: end.ref || '',
      toPath: end.path || '',
      toRole: end.role || '',
      toName: end.name || '',
      mode: `${start.mode}->${end.mode}`,
    };
  } catch (cause) {
    if (cause && cause.code && String(cause.code).startsWith('desktop_')) throw cause;
    const error = new Error(`拖拽失败：${cause && cause.message ? cause.message : cause}`);
    error.code = 'desktop_drag_failed';
    error.cause = cause;
    throw error;
  }
}

function normalizeHotkeyModifiers(value) {
  const list = Array.isArray(value) ? value : (value == null || value === '' ? [] : [value]);
  const out = [];
  const seen = new Set();
  for (const raw of list) {
    const key = MODIFIER_ALIASES[String(raw || '').trim().toLowerCase()];
    if (!key) {
      const error = new Error(`不支持的修饰键：${raw}。可用 command/cmd、shift、option/alt、control/ctrl。`);
      error.code = 'desktop_hotkey_invalid';
      throw error;
    }
    if (!seen.has(key)) {
      seen.add(key);
      out.push(key);
    }
  }
  return out;
}

function normalizeHotkey(options = {}) {
  let modifiers = normalizeHotkeyModifiers(options.modifiers || options.mods);
  let key = String(options.key ?? options.keys ?? '').trim();
  if (!key) {
    const error = new Error('请提供要按下的按键 key。');
    error.code = 'desktop_hotkey_empty';
    throw error;
  }

  // Allow "cmd+s" style in key when modifiers omitted.
  if ((!options.modifiers && !options.mods) && /[+－]/.test(key)) {
    const parts = key.split(/[+＋]/).map((part) => part.trim()).filter(Boolean);
    if (parts.length >= 2) {
      key = parts[parts.length - 1];
      const parsedMods = parts.slice(0, -1);
      modifiers = normalizeHotkeyModifiers([...modifiers, ...parsedMods]);
    }
  }

  const lower = key.toLowerCase();
  let kind = 'char';
  let keyCode = null;
  let keystroke = '';

  if (Object.prototype.hasOwnProperty.call(NAMED_KEY_CODES, lower)) {
    kind = 'code';
    keyCode = NAMED_KEY_CODES[lower];
    key = lower === 'esc' ? 'escape' : (lower === 'return' ? 'enter' : lower);
  } else if (/^f\d{1,2}$/i.test(key)) {
    const error = new Error(`不支持的功能键：${key}（仅 F1–F12）。`);
    error.code = 'desktop_hotkey_invalid';
    throw error;
  } else if (key.length === 1) {
    // Single printable character (letter/digit/punctuation).
    if (/[\u0000-\u001F\u007F]/.test(key)) {
      const error = new Error('按键包含不支持的控制字符。');
      error.code = 'desktop_hotkey_invalid';
      throw error;
    }
    kind = 'char';
    keystroke = key;
    key = key.length === 1 && /[A-Z]/.test(key) ? key.toLowerCase() : key;
  } else if (/^[a-z0-9]$/i.test(key)) {
    kind = 'char';
    keystroke = key.toLowerCase();
    key = keystroke;
  } else {
    const error = new Error(`不支持的按键：${key}。请使用单字符，或 enter/tab/escape/arrows/f1-f12 等命名键。`);
    error.code = 'desktop_hotkey_invalid';
    throw error;
  }

  // Dedup modifiers after combo parse.
  const uniqueMods = [];
  const seen = new Set();
  for (const mod of modifiers) {
    if (!seen.has(mod)) {
      seen.add(mod);
      uniqueMods.push(mod);
    }
  }

  const chord = [...uniqueMods, key].join('+');
  assertHotkeyAllowed(chord, uniqueMods, key);

  return {
    key,
    modifiers: uniqueMods,
    kind,
    keyCode,
    keystroke: kind === 'char' ? (keystroke || key) : '',
    chord,
  };
}

function assertHotkeyAllowed(chord, modifiers, key) {
  const mods = new Set(modifiers);
  const k = String(key || '').toLowerCase();
  const has = (...names) => names.every((name) => mods.has(name));
  const only = (...names) => mods.size === names.length && names.every((name) => mods.has(name));

  // Always refuse quitting / force-quit / lock / app-switcher / spotlight.
  if (k === 'q' && mods.has('command')) {
    const error = new Error('已拒绝退出类快捷键（⌘Q 等）。');
    error.code = 'desktop_hotkey_blocked';
    throw error;
  }
  if (k === 'escape' && mods.has('command') && mods.has('option')) {
    const error = new Error('已拒绝强制退出类快捷键（⌘⌥Esc）。');
    error.code = 'desktop_hotkey_blocked';
    throw error;
  }
  if (k === 'q' && mods.has('command') && mods.has('control')) {
    const error = new Error('已拒绝锁屏类快捷键（⌃⌘Q）。');
    error.code = 'desktop_hotkey_blocked';
    throw error;
  }
  if (k === 'tab' && mods.has('command')) {
    const error = new Error('已拒绝应用切换快捷键（⌘Tab）。');
    error.code = 'desktop_hotkey_blocked';
    throw error;
  }
  if (k === 'space' && mods.has('command') && !mods.has('control')) {
    // ⌘Space / ⌘⇧Space → Spotlight (⌃⌘Space emoji picker is allowed).
    const error = new Error('已拒绝 Spotlight 类快捷键（⌘Space）。');
    error.code = 'desktop_hotkey_blocked';
    throw error;
  }
  if (k === 'power' || k === 'eject') {
    const error = new Error('已拒绝电源相关按键。');
    error.code = 'desktop_hotkey_blocked';
    throw error;
  }
  // Silence unused lint-style helpers in older engines.
  void has;
  void only;
  void chord;
}

async function hotkeyDesktop(appTarget, options = {}, deps = {}) {
  if ((deps.platform || process.platform) !== 'darwin') {
    const error = new Error('电脑操控目前仅支持 macOS。');
    error.code = 'desktop_unsupported_platform';
    throw error;
  }

  const windowId = options.windowId != null ? Number(options.windowId) : NaN;
  if (!windowId || Number.isNaN(windowId)) {
    const error = new Error('快捷键需要明确的 windowId。请先用 desktop_windows 获取窗口。');
    error.code = 'desktop_window_required';
    throw error;
  }

  const hotkey = normalizeHotkey(options);
  // Ensure the window still belongs to the allowed app and is visible.
  const frame = await getWindowFrame(appTarget, windowId, deps);

  if (typeof deps.hotkey === 'function') {
    return deps.hotkey(appTarget, {
      ...options,
      windowId,
      key: hotkey.key,
      modifiers: hotkey.modifiers,
      chord: hotkey.chord,
      kind: hotkey.kind,
      keyCode: hotkey.keyCode,
      keystroke: hotkey.keystroke,
      title: frame.title || '',
    });
  }

  const runner = deps.runner || defaultRunner;
  const processName = String(appTarget?.name || '').trim();
  const script = `
function run(argv) {
  var appName = String(argv[0] || '');
  var kind = String(argv[1] || 'char');
  var payload = String(argv[2] || '');
  var modsCsv = String(argv[3] || '');
  var se = Application('System Events');
  se.includeStandardAdditions = true;
  try {
    if (appName) {
      var app = Application(appName);
      app.includeStandardAdditions = true;
      app.activate();
      delay(0.05);
    }
  } catch (e) {}
  var mods = [];
  if (modsCsv) {
    var parts = modsCsv.split(',');
    for (var i = 0; i < parts.length; i++) {
      var m = String(parts[i] || '').trim();
      if (m) mods.push(m + ' down');
    }
  }
  if (kind === 'code') {
    var code = Number(payload || 0);
    if (mods.length) se.keyCode(code, { using: mods });
    else se.keyCode(code);
  } else {
    if (mods.length) se.keystroke(payload, { using: mods });
    else se.keystroke(payload);
  }
  return 'ok';
}
`.trim();

  try {
    await runner(
      '/usr/bin/osascript',
      [
        '-l', 'JavaScript', '-e', script,
        processName,
        hotkey.kind,
        hotkey.kind === 'code' ? String(hotkey.keyCode) : String(hotkey.keystroke),
        hotkey.modifiers.join(','),
      ],
      { timeout: 10000 },
    );
    return {
      ok: true,
      appName: String(appTarget?.name || ''),
      bundleId: String(appTarget?.bundleId || ''),
      windowId,
      title: frame.title || '',
      key: hotkey.key,
      modifiers: hotkey.modifiers,
      chord: hotkey.chord,
    };
  } catch (cause) {
    if (cause && cause.code && String(cause.code).startsWith('desktop_')) throw cause;
    const error = new Error(`快捷键失败：${cause && cause.message ? cause.message : cause}`);
    error.code = 'desktop_hotkey_failed';
    error.cause = cause;
    throw error;
  }
}

module.exports = {
  centerOfBounds,
  pointInBounds,
  getWindowFrame,
  resolveClickTarget,
  clickDesktop,
  typeDesktop,
  normalizeTypeText,
  DEFAULT_MAX_TYPE_CHARS,
  normalizeScrollDelta,
  scrollDesktop,
  DEFAULT_SCROLL_AMOUNT,
  MAX_SCROLL_AMOUNT,
  dragDesktop,
  resolveDragEndpoint,
  normalizeDragSteps,
  DEFAULT_DRAG_STEPS,
  MAX_DRAG_STEPS,
  MAX_DRAG_DISTANCE,
  hotkeyDesktop,
  normalizeHotkey,
  normalizeHotkeyModifiers,
  assertHotkeyAllowed,
  NAMED_KEY_CODES,
};
