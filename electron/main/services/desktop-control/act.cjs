const { JXA_TARGET_WINDOW_GUARD, foregroundError } = require('./foreground.cjs');
/**
 * Desktop write actions (click / type / scroll / drag / hotkey). Reuses window ownership + allow policy from observe/policy.
 */
const {
  JXA_DESKTOP_HELPERS,
  assertWindowBelongsToApp,
  defaultRunner,
} = require('./observe.cjs');
const { snapshotTarget, JXA_AX_IDENTITY } = require('./ax-targets.cjs');

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

/**
 * Convert window-normalized (0..1000), window-relative (rx, ry), or image-pixel
 * coordinates into absolute OS screen coordinates within `bounds`.
 */
function resolveCoordinateFromOptions(options = {}, bounds = null) {
  const hasNorm = options.normX != null && options.normY != null;
  if (hasNorm) {
    const nx = Number(options.normX);
    const ny = Number(options.normY);
    if (!Number.isFinite(nx) || !Number.isFinite(ny) || nx < 0 || nx > 1000 || ny < 0 || ny > 1000) {
      const error = new Error('归一化坐标 normX/normY 必须在 0–1000 之间。');
      error.code = 'desktop_invalid_point';
      throw error;
    }
    if (!bounds || !(bounds.width > 0) || !(bounds.height > 0)) {
      const error = new Error('无法获取目标窗口尺寸，不能换算相对坐标。');
      error.code = 'desktop_window_bounds_missing';
      throw error;
    }
    return {
      point: {
        x: Math.round(bounds.x + (nx / 1000) * bounds.width),
        y: Math.round(bounds.y + (ny / 1000) * bounds.height),
      },
      mode: 'norm',
    };
  }

  const hasRelative = options.rx != null && options.ry != null;
  if (hasRelative) {
    const rx = Number(options.rx);
    const ry = Number(options.ry);
    if (!Number.isFinite(rx) || !Number.isFinite(ry)) {
      const error = new Error('窗口相对坐标 rx/ry 无效。');
      error.code = 'desktop_invalid_point';
      throw error;
    }
    if (!bounds || !(bounds.width > 0) || !(bounds.height > 0)) {
      const error = new Error('无法获取目标窗口尺寸，不能换算相对坐标。');
      error.code = 'desktop_window_bounds_missing';
      throw error;
    }
    // Optional imageWidth/imageHeight allows passing raw pixel coordinates directly from a scaled screenshot.
    const imgW = Number(options.imageWidth) || 0;
    const imgH = Number(options.imageHeight) || 0;
    const sx = imgW > 0 ? (rx / imgW) * bounds.width : rx;
    const sy = imgH > 0 ? (ry / imgH) * bounds.height : ry;
    return {
      point: {
        x: Math.round(bounds.x + sx),
        y: Math.round(bounds.y + sy),
      },
      mode: imgW > 0 ? 'image' : 'relative',
    };
  }

  if (options.x != null && options.y != null) {
    const point = {
      x: Math.round(Number(options.x)),
      y: Math.round(Number(options.y)),
    };
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) {
      const error = new Error('点击坐标无效。');
      error.code = 'desktop_invalid_point';
      throw error;
    }
    return { point, mode: 'point' };
  }

  return null;
}

async function getWindowFrame(appTarget, windowId, deps = {}, allowOffscreen = false) {
  const owned = await assertWindowBelongsToApp(appTarget, windowId, deps);
  if (owned.minimized || (!allowOffscreen && owned.visible === false)) {
    const error = new Error(
      `窗口 ${windowId} 当前不可见或已最小化，无法操作。请先恢复窗口。`,
    );
    error.code = owned.minimized ? 'desktop_window_not_visible' : 'desktop_foreground_required';
    throw error;
  }

  if (typeof deps.getWindowFrame === 'function') {
    const frame = await deps.getWindowFrame(appTarget, windowId);
    const bounds = frame && typeof frame === 'object' && frame.bounds ? frame.bounds : frame;
    return { ...owned, bounds };
  }

  if (owned.bounds && owned.bounds.width > 0 && owned.bounds.height > 0) {
    return owned;
  }

  const runner = deps.runner || defaultRunner;
  const processName = String(appTarget?.name || '').trim();
  const bundleId = String(appTarget?.bundleId || '').trim();
  const appPath = String(appTarget?.path || '').trim();
  const script = `
ObjC.import('AppKit');
ObjC.import('CoreGraphics');
${JXA_DESKTOP_HELPERS}
function run(argv) {
  var target = String(argv[0] || '');
  var wantWindowId = Number(argv[1] || 0);
  var targetBundle = String(argv[2] || '');
  var targetPath = String(argv[3] || '');
  var app = findRunningApp(target, targetBundle, targetPath);
  if (!app) throw new Error('process_not_found');
  var cgWins = listCgWindowsForPid(app.pid);
  for (var i = 0; i < cgWins.length; i++) {
    if (cgWins[i].windowId === wantWindowId) {
      var cw = cgWins[i];
      return JSON.stringify({
        x: Number(cw.x) || 0,
        y: Number(cw.y) || 0,
        width: Number(cw.width) || 0,
        height: Number(cw.height) || 0,
        title: String(cw.title || '')
      });
    }
  }
  throw new Error('window_not_found');
}
`.trim();

  try {
    const { stdout } = await runner(
      '/usr/bin/osascript',
      ['-l', 'JavaScript', '-e', script, processName, String(windowId), bundleId, appPath],
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
    if (cause?.code === 'desktop_action_outcome_unknown') throw cause;
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

async function resolveClickTarget(appTarget, options = {}, deps = {}, axAction = null) {
  const windowId = options.windowId != null ? Number(options.windowId) : NaN;
  if (!windowId || Number.isNaN(windowId)) {
    const error = new Error('点击需要明确的 windowId。请先用 desktop_windows 获取窗口。');
    error.code = 'desktop_window_required';
    throw error;
  }

  const ref = String(options.ref || '').trim();
  const path = String(options.elementPath || options.path || '').trim();
  const frame = await getWindowFrame(appTarget, windowId, deps, Boolean(axAction && (ref || path)));
  const hasCoords = (options.x != null && options.y != null)
    || (options.rx != null && options.ry != null)
    || (options.normX != null && options.normY != null);

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

    const expected = snapshotTarget(deps.sessionId, windowId, ref, path);
    const runner = deps.runner || defaultRunner;
    const script = `
ObjC.import('AppKit');
ObjC.import('CoreGraphics');
${JXA_DESKTOP_HELPERS}
${JXA_AX_IDENTITY}
function run(argv) {
  var app = findRunningApp(argv[0], argv[1], argv[2]);
  var windowId = Number(argv[3]);
  var expected = JSON.parse(argv[4]);
  var action = JSON.parse(argv[5]);
  if (!app || app.pid !== expected.pid) throw new Error('target_not_found');
  var windows = listCgWindowsForPid(app.pid);
  var cgWin = windows.find(function (window) { return window.windowId === windowId; });
  var proc = findSeProcess(Application('System Events'), app.name, app.bundleId, app.pid);
  if (!proc || Number(proc.unixId()) !== app.pid) throw new Error('target_not_found');
  var el = cgWin && findSeWindowForWindowId(proc, cgWin, windowId, windows);
  if (!el) throw new Error('window_not_found');
  var indexes = expected.path.split('/');
  if (indexes[0] !== '1') throw new Error('target_not_found');
  for (var i = 1; i < indexes.length; i++) {
    el = el.uiElements()[Number(indexes[i]) - 1];
    if (!el) throw new Error('target_not_found');
  }
  var role = '', name = '', subrole = '', description = '';
  try { role = String(el.role()); } catch (e) {}
  try { name = String(el.title()); } catch (e) { try { name = String(el.name()); } catch (err) {} }
  try { subrole = String(el.subrole()); } catch (e) {}
  try { description = String(el.description()); } catch (e) {}
  if (axIdentity(el, role, name, subrole, description) !== expected.identity) throw new Error('target_not_found');
  if (/secure|password/i.test(role + ' ' + subrole + ' ' + description) || expected.secure) throw new Error('secure_target');
  var node = { role: role, name: name };
  try {
    var p = el.position(), s = el.size();
    node.bounds = { x: Number(p[0]), y: Number(p[1]), width: Number(s[0]), height: Number(s[1]) };
  } catch (e) {}
  if (action && action.kind === 'press') {
    var press = el.actions.byName('AXPress');
    if (press.exists()) {
      try { press.perform(); } catch (e) { throw new Error('action_outcome_unknown'); }
      node.method = 'AXPress';
    }
  }
  if (action && action.kind === 'setValue' && /^(AXTextArea|AXTextField|AXComboBox)$/.test(role)) {
    var attr = el.attributes.byName('AXValue');
    if (attr.exists() && attr.settable() && (action.clear || attr.value() === '')) {
      try {
        attr.value = action.text;
        if (attr.value() !== action.text) throw new Error('value_mismatch');
      } catch (e) { throw new Error('action_outcome_unknown'); }
      node.method = 'AXValue';
    }
  }
  return JSON.stringify(node);
}
`.trim();
    try {
      const { stdout } = await runner('/usr/bin/osascript', [
        '-l', 'JavaScript', '-e', script, appTarget.name || '', appTarget.bundleId || '', appTarget.path || '',
        String(windowId), JSON.stringify(expected), JSON.stringify(axAction),
      ], { timeout: 15000 });
      let node;
      try {
        node = JSON.parse(stdout);
        if (!node || typeof node.role !== 'string') throw new Error('invalid AX node acknowledgement');
      } catch (cause) {
        if (axAction) {
          throw Object.assign(new Error('未收到有效的控件操作回执，请先核对窗口。', { cause }), { code: 'desktop_action_outcome_unknown' });
        }
        throw cause;
      }
      const point = centerOfBounds(node.bounds);
      if (!node.method) {
        if (frame.visible === false) throw Object.assign(new Error('此控件需要前台窗口才能操作。'), { code: 'desktop_foreground_required' });
        if (!point) throw Object.assign(new Error('控件没有可用位置。'), { code: 'desktop_target_no_bounds' });
        if (!pointInBounds(point, frame.bounds, 8)) {
          throw Object.assign(new Error('控件位置已超出目标窗口，请重新观察。'), { code: 'desktop_target_outside_window' });
        }
      }
      return {
        windowId, point, bounds: frame.bounds || null, ref: expected.ref, path: expected.path,
        role: node.role || '', name: node.name || '', title: frame.title || '', mode: node.method ? 'accessibility' : 'ref',
        ...(node.method ? { method: node.method } : {}),
      };
    } catch (cause) {
      if (String(cause?.code || '').startsWith('desktop_')) throw cause;
      const message = String(cause?.stderr || cause?.message || cause);
      if (message.includes('action_outcome_unknown')) {
        throw Object.assign(new Error('控件操作已派发但无法确认结果，请先核对目标窗口。', { cause }), { code: 'desktop_action_outcome_unknown' });
      }
      if (message.includes('secure_target')) {
        throw Object.assign(new Error('不会操作密码或安全输入控件。'), { code: 'desktop_secure_target' });
      }
      if (message.includes('window_not_found')) {
        throw Object.assign(new Error('无法核对指定窗口，请重新读取窗口列表。'), { code: 'desktop_window_not_found' });
      }
      if (message.includes('target_not_found')) {
        throw Object.assign(new Error('目标控件已变化，请重新读取 desktop_snapshot。'), { code: 'desktop_target_not_found' });
      }
      throw Object.assign(new Error('无法读取目标控件。', { cause }), { code: 'desktop_target_resolve_failed' });
    }
  }

  if (hasCoords) {
    const resolved = resolveCoordinateFromOptions(options, frame.bounds);
    const point = resolved.point;
    if (!pointInBounds(point, frame.bounds, 4)) {
      const error = new Error('点击坐标不在指定窗口范围内，已拒绝。');
      error.code = 'desktop_point_outside_window';
      throw error;
    }
    return {
      windowId,
      point,
      bounds: frame.bounds || null,
      ref: '',
      path: '',
      role: '',
      name: '',
      title: frame.title || '',
      mode: resolved.mode,
    };
  }

  const error = new Error('请提供 snapshot 的 ref/path，窗口内相对坐标 rx/ry（或 0–1000 归一化 normX/normY），或屏幕坐标 x/y。');
  error.code = 'desktop_click_target_required';
  throw error;
}



async function clickDesktop(appTarget, options = {}, deps = {}, { focusOnly = false, resolvedTarget } = {}) {
  if ((deps.platform || process.platform) !== 'darwin') {
    const error = new Error('电脑操控目前仅支持 macOS。');
    error.code = 'desktop_unsupported_platform';
    throw error;
  }
  const singleLeft = (!options.button || options.button === 'left') && !options.double && Number(options.clickCount || 1) === 1;
  const action = !focusOnly && singleLeft && !deps.click ? { kind: 'press' } : null;
  const target = resolvedTarget || await resolveClickTarget(appTarget, options, deps, action);
  if (target.method === 'AXPress') {
    return {
      ok: true, appName: appTarget.name || '', bundleId: appTarget.bundleId || '',
      ...target, x: target.point?.x ?? null, y: target.point?.y ?? null, button: 'left', clickCount: 1,
    };
  }
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
  const processName = String(appTarget?.bundleId || appTarget?.name || '').trim();
  const button = String(options.button || 'left').toLowerCase() === 'right' ? 'right' : 'left';
  const clickCount = options.double === true ? 2 : Math.min(Math.max(Number(options.clickCount) || 1, 1), 3);

  const script = `
ObjC.import('AppKit');
ObjC.import('CoreGraphics');
${JXA_DESKTOP_HELPERS}
${JXA_TARGET_WINDOW_GUARD}
function run(argv) {
  var target = findRunningApp(argv[0], argv[6], argv[7]);
  var windowId = Number(argv[5]);
  var x = Number(argv[1] || 0);
  var y = Number(argv[2] || 0);
  var button = String(argv[3] || 'left');
  var clicks = Math.max(1, Math.min(3, Number(argv[4] || 1)));
  ObjC.bindFunction('CGPreflightPostEventAccess', ['bool', []]);
  if (!$.CGPreflightPostEventAccess()) throw new Error('desktop_mouse_permission');
  // A headless osascript needs an AppKit application connection for cross-process hit tests.
  $.NSApplication.sharedApplication;

  var point = $.CGPointMake(x, y);
  var mouseButton = button === 'right' ? $.kCGMouseButtonRight : $.kCGMouseButtonLeft;
  var downType = button === 'right' ? $.kCGEventRightMouseDown : $.kCGEventLeftMouseDown;
  var upType = button === 'right' ? $.kCGEventRightMouseUp : $.kCGEventLeftMouseUp;
  for (var i = 1; i <= clicks; i++) {
    try {
      requireForeground(target);
      if (!hitTarget(windowId, x, y, target.pid)) throw new Error('desktop_foreground_required');
    } catch (e) {
      if (i > 1) throw new Error('desktop_partial_click：已发出部分点击，请先检查窗口。');
      throw e;
    }
    var down = $.CGEventCreateMouseEvent(null, downType, point, mouseButton);
    var up = $.CGEventCreateMouseEvent(null, upType, point, mouseButton);
    $.CGEventSetIntegerValueField(down, $.kCGMouseEventClickState, i);
    $.CGEventSetIntegerValueField(up, $.kCGMouseEventClickState, i);
    $.CGEventPost($.kCGHIDEventTap, down);
    delay(0.02);
    $.CGEventPost($.kCGHIDEventTap, up);
    if (i < clicks) delay(0.04);
  }
  return JSON.stringify({ ok: true, x: x, y: y, button: button, clickCount: clicks });
}
`.trim();

  try {
    await runner(
      '/usr/bin/osascript',
      ['-l', 'JavaScript', '-e', script, processName, String(target.point.x), String(target.point.y), button, String(clickCount),
        String(target.windowId), String(appTarget?.bundleId || ''), String(appTarget?.path || '')],
      { timeout: 10000 },
    );
    return {
      ok: true,
      appName: String(appTarget?.name || ''),
      bundleId: String(appTarget?.bundleId || ''),
      windowId: target.windowId,
      title: target.title || '',
      bounds: target.bounds || null,
      x: target.point.x,
      y: target.point.y,
      button,
      clickCount,
      ref: target.ref || '',
      path: target.path || '',
      role: target.role || '',
      name: target.name || '',
      mode: target.mode,
    };
  } catch (cause) {
    if (cause?.code === 'desktop_action_outcome_unknown') throw cause;
    if (String(cause?.message || cause).includes('desktop_mouse_permission')) {
      const error = new Error('macOS 未允许发送鼠标事件。请在系统设置的辅助功能中授权 Pi Studio Computer Use，然后刷新权限。', { cause });
      error.code = 'desktop_accessibility_permission';
      throw error;
    }
    const focusError = foregroundError(cause);
    if (focusError) throw focusError;
    const error = new Error(`点击失败：${cause && cause.message ? cause.message : cause}`);
    error.code = String(cause?.message || cause).includes('desktop_partial_click') ? 'desktop_action_outcome_unknown' : 'desktop_click_failed';
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

// The pasteboard is shared across Studio conversations. Reject an overlapping input
// before it can click a field or snapshot another in-flight operation's text.
let textEntryInProgress = false;
async function typeDesktop(appTarget, options = {}, deps = {}) {
  if (textEntryInProgress) {
    const error = new Error('另一个桌面输入正在执行，请等待其完成后再检查目标窗口。');
    error.code = 'desktop_input_busy';
    throw error;
  }
  textEntryInProgress = true;
  try {
    return await performTextEntry(appTarget, options, deps);
  } finally {
    textEntryInProgress = false;
  }
}

async function performTextEntry(appTarget, options, deps) {
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

  let resolvedTarget;
  if ((options.ref || options.elementPath || options.path) && !options.submit && !deps.type && !deps.resolveNode) {
    resolvedTarget = await resolveClickTarget(appTarget, options, deps, { kind: 'setValue', text, clear: options.clear === true });
    if (resolvedTarget.method === 'AXValue') {
      return {
        ok: true, appName: appTarget.name || '', bundleId: appTarget.bundleId || '', ...resolvedTarget,
        chars: text.length, valueVerified: true, submitted: false,
      };
    }
  }

  // Pointer and paste operations require a visible window.
  deps.assertKeyboardAllowed?.();
  const frame = resolvedTarget || await getWindowFrame(appTarget, windowId, deps);

  let focused = {
    ref: '',
    path: '',
    role: '',
    name: '',
    secure: false,
  };

  const hasTarget = Boolean(
    String(options.ref || '').trim()
    || String(options.path || options.elementPath || '').trim()
    || (options.x != null && options.y != null)
    || (options.rx != null && options.ry != null)
    || (options.normX != null && options.normY != null),
  );
  if (hasTarget) {
    const target = await clickDesktop(appTarget, {
      ...options,
      windowId,
      path: options.path || options.elementPath,
      button: 'left',
    }, deps, { focusOnly: true, resolvedTarget });
    focused = {
      ref: target.ref || '',
      path: target.path || '',
      role: target.role || '',
      name: target.name || '',
      secure: false,
    };
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
  const processName = String(appTarget?.bundleId || appTarget?.name || '').trim();
  const clearBefore = options.clear === true;
  const submitAfter = options.submit === true;
  // Paste literal text for all input sources, including Latin searches in a CJK IME.
  const pasteScript = `
ObjC.import('AppKit');
ObjC.import('CoreGraphics');
${JXA_DESKTOP_HELPERS}
${JXA_TARGET_WINDOW_GUARD}

function withPasteboardText(board, text, paste) {
  var originalChange = Number(board.changeCount);
  var saved = $.NSMutableArray.alloc.init;
  var items = board.pasteboardItems;
  for (var i = 0; i < Number(items.count); i++) {
    var item = items.objectAtIndex(i);
    var copy = $.NSPasteboardItem.alloc.init;
    var types = item.types;
    for (var j = 0; j < Number(types.count); j++) {
      var type = types.objectAtIndex(j);
      var data = item.dataForType(type);
      if (!data || data.isNil() || !copy.setDataForType(data, type)) {
        throw new Error('无法保存当前剪贴板格式，已停止输入。');
      }
    }
    saved.addObject(copy);
  }
  if (Number(board.changeCount) !== originalChange) throw new Error('剪贴板已变化，请重新确认输入。');
  // The ObjC bridge invokes zero-argument selectors on property access.
  var ownedChange = Number(board.clearContents);
  try {
    if (!board.setStringForType($(text), $.NSPasteboardTypeString)) throw new Error('无法写入剪贴板。');
    paste(function () {
      if (Number(board.changeCount) !== ownedChange) throw new Error('剪贴板已变化，请检查目标输入框。');
    });
  } finally {
    if (Number(board.changeCount) === ownedChange) {
      board.clearContents;
      if (Number(saved.count) && !board.writeObjects(saved)) throw new Error('无法还原剪贴板，请先检查目标输入框。');
    }
  }
}

function run(argv) {
  var target = findRunningApp(argv[0], argv[5], argv[6]);
  var windowId = Number(argv[4]);

  var pastePosted = false;
  function checkWindow() {
    try { assertTargetFrontWindow(target, windowId); }
    catch (e) { if (pastePosted) throw new Error('desktop_partial_paste'); throw e; }
  }
  checkWindow();
  var se = Application('System Events');
  var proc = findSeProcess(se, target.name, target.bundleId, target.pid);
  var element = null;
  var role = '', subrole = '', name = '', description = '';
  try { element = proc.attributes.byName('AXFocusedUIElement').value(); } catch (e) {}
  if (element) {
    try { role = String(element.role() || ''); } catch (e) {}
    try { subrole = String(element.subrole() || ''); } catch (e) {}
    try { description = String(element.description() || ''); } catch (e) {}
    try { name = String(element.name() || ''); } catch (e) {}
  }
  if (/secure|password/i.test(role + ' ' + subrole + ' ' + description)) throw new Error('desktop_secure_target');
  function fieldValue() {
    try {
      var value = element.value();
      return typeof value === 'string' ? value : null;
    } catch (e) { return null; }
  }
  var editable = /^(AXTextArea|AXTextField|AXComboBox)$/.test(role);
  var previous = editable ? fieldValue() : null;
  var canVerify = previous !== null && (argv[2] === '1' || previous === '');
  var verified = false;
  withPasteboardText($.NSPasteboard.generalPasteboard, argv[1], function (checkClipboard) {
    if (argv[2] === '1') {
      checkWindow();
      se.keyCode(0, { using: ['command down'] }); // Select existing text; paste replaces it.
    }
    checkWindow();
    checkClipboard();
    se.keyCode(9, { using: ['command down'] });
    pastePosted = true;
    if (canVerify) {
      if (previous === argv[1]) delay(0.15);
      // Keep the clipboard intact until the target consumes it.
      for (var attempt = 0; attempt < 10; attempt++) {
        if (fieldValue() === argv[1]) { verified = true; break; }
        delay(0.05);
      }
      if (!verified) throw new Error('粘贴后输入框内容与预期不符，请先检查界面。');
    } else {
      delay(0.15); // Custom controls may expose no AX value.
    }
    if (argv[3] === '1') {
      checkWindow();
      checkClipboard();
      se.keyCode(36);
    }
  });
  return JSON.stringify({ role: role, name: name, verified: verified });
}
`.trim();
  try {
    const { stdout } = await runner(
      '/usr/bin/osascript',
      ['-l', 'JavaScript', '-e', pasteScript, processName, text, clearBefore ? '1' : '0', submitAfter ? '1' : '0',
        String(windowId), String(appTarget?.bundleId || ''), String(appTarget?.path || '')],
      { timeout: 15000 },
    );

    const observation = String(stdout || '').trim().startsWith('{') ? JSON.parse(stdout) : {};
    return {
      ok: true,
      appName: String(appTarget?.name || ''),
      bundleId: String(appTarget?.bundleId || ''),
      windowId,
      title: frame.title || '',
      bounds: frame.bounds || null,
      chars: text.length,
      method: 'paste',
      submitted: submitAfter,
      valueVerified: observation.verified === true,
      ref: focused.ref || '',
      path: focused.path || '',
      role: observation.role || focused.role || '',
      name: observation.name || focused.name || '',
      mode: hasTarget ? 'target' : 'focused',
    };
  } catch (cause) {
    if (cause && cause.code && String(cause.code).startsWith('desktop_')) throw cause;
    const focusError = foregroundError(cause);
    if (focusError) throw focusError;
    if (String(cause?.stderr || cause?.message || '').includes('desktop_partial_paste')) {
      throw Object.assign(new Error('目标窗口未在前台或已进入调度中心。粘贴已派发，未按回车，请核对输入框。', { cause }), { code: 'desktop_action_outcome_unknown' });
    }
    if (/Error: desktop_secure_target\b/.test(String(cause?.stderr || cause?.message || ''))) {
      const error = new Error('不会向密码或安全输入框输入内容。');
      error.code = 'desktop_secure_target';
      throw error;
    }
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
  const processName = String(appTarget?.bundleId || appTarget?.name || '').trim();
  const script = `
ObjC.import('AppKit');
ObjC.import('CoreGraphics');
${JXA_DESKTOP_HELPERS}
${JXA_TARGET_WINDOW_GUARD}
function run(argv) {
  var target = findRunningApp(argv[0], argv[6], argv[7]);
  var windowId = Number(argv[5]);
  var x = Number(argv[1] || 0);
  var y = Number(argv[2] || 0);
  var dx = Number(argv[3] || 0);
  var dy = Number(argv[4] || 0);
  var point = $.CGPointMake(x, y);
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
  requireForeground(target);
  if (!hitTarget(windowId, x, y, target.pid)) throw new Error('desktop_foreground_required');
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
        String(delta.dy), String(target.windowId), String(appTarget?.bundleId || ''), String(appTarget?.path || ''),
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
    const focusError = foregroundError(cause);
    if (focusError) throw focusError;
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
  const processName = String(appTarget?.bundleId || appTarget?.name || '').trim();
  const script = `
ObjC.import('AppKit');
ObjC.import('CoreGraphics');
${JXA_DESKTOP_HELPERS}
${JXA_TARGET_WINDOW_GUARD}
function run(argv) {
  var target = findRunningApp(argv[0], argv[7], argv[8]);
  var windowId = Number(argv[6]);
  var x1 = Number(argv[1] || 0);
  var y1 = Number(argv[2] || 0);
  var x2 = Number(argv[3] || 0);
  var y2 = Number(argv[4] || 0);
  var steps = Math.max(1, Number(argv[5] || 12));
  requireForeground(target);
  if (!hitTarget(windowId, x1, y1, target.pid) || !hitTarget(windowId, x2, y2, target.pid)) throw new Error('desktop_foreground_required');
  var start = $.CGPointMake(x1, y1);
  var end = $.CGPointMake(x2, y2);
  var down = $.CGEventCreateMouseEvent(null, $.kCGEventLeftMouseDown, start, $.kCGMouseButtonLeft);
  $.CGEventPost($.kCGHIDEventTap, down);
  var lastPoint = start;
  try {
    delay(0.03);
    for (var i = 1; i <= steps; i++) {
      var t = i / steps;
      var x = x1 + (x2 - x1) * t, y = y1 + (y2 - y1) * t;
      requireForeground(target);
      if (!hitTarget(windowId, x, y, target.pid)) throw new Error('focus_changed');
      lastPoint = $.CGPointMake(x, y);
      var drag = $.CGEventCreateMouseEvent(null, $.kCGEventLeftMouseDragged, lastPoint, $.kCGMouseButtonLeft);
      $.CGEventPost($.kCGHIDEventTap, drag);
      delay(0.008);
    }
    requireForeground(target);
    if (!hitTarget(windowId, x2, y2, target.pid)) throw new Error('focus_changed');
    $.CGEventPost($.kCGHIDEventTap, $.CGEventCreateMouseEvent(null, $.kCGEventLeftMouseUp, end, $.kCGMouseButtonLeft));
  } catch (e) {
    $.CGEventPostToPid(target.pid, $.CGEventCreateMouseEvent(null, $.kCGEventLeftMouseUp, lastPoint, $.kCGMouseButtonLeft));
    throw new Error('desktop_partial_drag');
  }
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
        String(steps), String(windowId), String(appTarget?.bundleId || ''), String(appTarget?.path || ''),
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
    const focusError = foregroundError(cause);
    if (focusError) throw focusError;
    const error = new Error(`拖拽失败：${cause && cause.message ? cause.message : cause}`);
    error.code = String(cause?.stderr || cause?.message || cause).includes('desktop_partial_drag')
      ? 'desktop_action_outcome_unknown' : 'desktop_drag_failed';
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
  const processName = String(appTarget?.bundleId || appTarget?.name || '').trim();
  const script = `
ObjC.import('AppKit');
ObjC.import('CoreGraphics');
${JXA_DESKTOP_HELPERS}
${JXA_TARGET_WINDOW_GUARD}
function run(argv) {
  var target = findRunningApp(argv[0], argv[5], argv[6]);
  var windowId = Number(argv[4]);
  var kind = String(argv[1] || 'char');
  var payload = String(argv[2] || '');
  var modsCsv = String(argv[3] || '');
  var se = Application('System Events');
  se.includeStandardAdditions = true;

  var mods = [];
  if (modsCsv) {
    var parts = modsCsv.split(',');
    for (var i = 0; i < parts.length; i++) {
      var m = String(parts[i] || '').trim();
      if (m) mods.push(m + ' down');
    }
  }
  assertTargetFrontWindow(target, windowId);
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
        String(windowId), String(appTarget?.bundleId || ''), String(appTarget?.path || ''),
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
    const focusError = foregroundError(cause);
    if (focusError) throw focusError;
    const error = new Error(`快捷键失败：${cause && cause.message ? cause.message : cause}`);
    error.code = 'desktop_hotkey_failed';
    error.cause = cause;
    throw error;
  }
}

module.exports = {
  resolveCoordinateFromOptions,
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
