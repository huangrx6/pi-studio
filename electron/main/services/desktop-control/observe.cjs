/**
 * Read-only desktop observation helpers (running apps, windows, AX snapshot, window screenshot).
 * Real GUI work goes through an injectable runner so unit tests never need Accessibility.
 */
const { execFile } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { promisify } = require('node:util');

const execFileAsync = promisify(execFile);

const DEFAULT_MAX_NODES = 80;
const DEFAULT_MAX_CHARS = 12000;

/** Soft cap for returned screenshot payloads (bytes of PNG before base64). */
const DEFAULT_MAX_SCREENSHOT_BYTES = 900 * 1024;
const DEFAULT_MAX_SCREENSHOT_EDGE = 1600;

function escapeAppleScriptString(value) {
  return String(value || '')
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"');
}

function defaultRunner(command, args, options = {}) {
  return execFileAsync(command, args, {
    timeout: options.timeout || 8000,
    maxBuffer: options.maxBuffer || 8 * 1024 * 1024,
    encoding: 'utf8',
    ...options,
  }).then((result) => ({
    stdout: String(result.stdout || ''),
    stderr: String(result.stderr || ''),
  }));
}

function parseJsonLines(stdout) {
  const text = String(stdout || '').trim();
  if (!text) return [];
  // Prefer a single JSON array/object payload.
  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) return parsed;
    if (parsed && typeof parsed === 'object') return [parsed];
  } catch {
    /* fall through to NDJSON */
  }
  const rows = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      rows.push(JSON.parse(trimmed));
    } catch {
      /* skip bad lines */
    }
  }
  return rows;
}

async function listRunningDesktopApps(deps = {}) {
  if ((deps.platform || process.platform) !== 'darwin') {
    const error = new Error('电脑操控目前仅支持 macOS。');
    error.code = 'desktop_unsupported_platform';
    throw error;
  }
  const runner = deps.runner || defaultRunner;
  if (typeof deps.listRunningApps === 'function') {
    return deps.listRunningApps();
  }

  const script = `
ObjC.import('AppKit');
function run() {
  var ws = $.NSWorkspace.sharedWorkspace;
  var apps = ObjC.unwrap(ws.runningApplications) || [];
  var rows = [];
  for (var i = 0; i < apps.length; i++) {
    var app = apps[i];
    try {
      if (Number(app.activationPolicy) !== 0) continue;
      var name = ObjC.unwrap(app.localizedName) || '';
      var bundleId = ObjC.unwrap(app.bundleIdentifier) || '';
      var appPath = '';
      try {
        var url = app.bundleURL;
        if (url) appPath = ObjC.unwrap(url.path) || '';
      } catch (e) {}
      if (!name && !bundleId) continue;
      rows.push({ name: String(name), bundleId: String(bundleId), path: String(appPath) });
    } catch (e) {}
  }
  return JSON.stringify(rows);
}
`.trim();

  try {
    const { stdout } = await runner('/usr/bin/osascript', ['-l', 'JavaScript', '-e', script], { timeout: 8000 });
    const rows = parseJsonLines(stdout);
    const seen = new Set();
    const apps = [];
    for (const row of rows) {
      if (!row || typeof row !== 'object') continue;
      const name = String(row.name || '').trim();
      const bundleId = String(row.bundleId || '').trim();
      const appPath = String(row.path || '').trim();
      if (!name && !bundleId) continue;
      const key = `${bundleId || ''}::${name.toLowerCase()}::${appPath}`;
      if (seen.has(key)) continue;
      seen.add(key);
      apps.push({ name: name || bundleId, bundleId, path: appPath });
    }
    apps.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans'));
    return apps;
  } catch (cause) {
    const error = new Error(`无法列出运行中的应用：${cause && cause.message ? cause.message : cause}`);
    error.code = 'desktop_list_apps_failed';
    error.cause = cause;
    throw error;
  }
}

async function listDesktopWindowsForApp(appTarget, deps = {}) {
  if ((deps.platform || process.platform) !== 'darwin') {
    const error = new Error('电脑操控目前仅支持 macOS。');
    error.code = 'desktop_unsupported_platform';
    throw error;
  }
  const runner = deps.runner || defaultRunner;
  if (typeof deps.listWindows === 'function') {
    return deps.listWindows(appTarget);
  }

  const processName = String(appTarget?.name || '').trim();
  if (!processName) {
    const error = new Error('缺少应用名称，无法列出窗口。');
    error.code = 'desktop_invalid_app';
    throw error;
  }

  const script = `
ObjC.import('AppKit');
function run(argv) {
  var target = String(argv[0] || '');
  var se = Application('System Events');
  se.includeStandardAdditions = true;
  var processes = se.processes.whose({ name: target })();
  if (!processes || processes.length === 0) return JSON.stringify([]);
  var proc = processes[0];
  var windows = [];
  try { windows = proc.windows(); } catch (e) { return JSON.stringify([]); }
  var rows = [];
  for (var i = 0; i < windows.length; i++) {
    var win = windows[i];
    var title = '';
    var windowId = null;
    var minimized = false;
    var visible = true;
    try { title = String(win.name()); } catch (e) { title = ''; }
    try { windowId = win.attributes.byName('AXWindowNumber').value(); } catch (e) { windowId = null; }
    try { minimized = Boolean(win.attribute('AXMinimized').value()); } catch (e1) {
      try { minimized = Boolean(win.miniaturized()); } catch (e2) { minimized = false; }
    }
    try {
      var pos = win.position();
      var size = win.size();
      var w = Number(size[0] || 0);
      var h = Number(size[1] || 0);
      visible = !minimized && w > 1 && h > 1;
    } catch (e) {
      visible = !minimized;
    }
    if (windowId == null) continue;
    rows.push({
      id: String(windowId),
      windowId: Number(windowId),
      title: title,
      index: i + 1,
      appName: target,
      minimized: minimized,
      visible: visible
    });
  }
  return JSON.stringify(rows);
}
`.trim();

  try {
    const { stdout } = await runner(
      '/usr/bin/osascript',
      ['-l', 'JavaScript', '-e', script, processName],
      { timeout: 10000 },
    );
    const rows = parseJsonLines(stdout);
    return rows
      .filter((row) => row && row.windowId != null)
      .map((row, index) => ({
        id: String(row.id || row.windowId),
        windowId: Number(row.windowId),
        title: String(row.title || ''),
        index: Number(row.index || index + 1),
        appName: String(row.appName || processName),
        bundleId: String(appTarget.bundleId || ''),
        path: String(appTarget.path || ''),
        minimized: Boolean(row.minimized),
        visible: row.visible == null ? true : Boolean(row.visible),
      }));
  } catch (cause) {
    const error = new Error(`无法列出「${processName}」的窗口：${cause && cause.message ? cause.message : cause}`);
    error.code = 'desktop_list_windows_failed';
    error.cause = cause;
    throw error;
  }
}

/**
 * List windows for many apps in one System Events pass when possible.
 * Falls back to per-app listing when a custom listWindows injector is provided.
 */
async function listDesktopWindowsForApps(appTargets = [], deps = {}) {
  const targets = (Array.isArray(appTargets) ? appTargets : [])
    .filter((app) => app && String(app.name || '').trim());
  if (!targets.length) return [];

  if ((deps.platform || process.platform) !== 'darwin') {
    const error = new Error('电脑操控目前仅支持 macOS。');
    error.code = 'desktop_unsupported_platform';
    throw error;
  }

  // Injected single-app lister: keep sequential but bounded concurrency.
  if (typeof deps.listWindows === 'function') {
    const out = [];
    for (const app of targets) {
      const rows = await listDesktopWindowsForApp(app, deps);
      out.push(...rows);
    }
    return out;
  }

  if (targets.length === 1) {
    return listDesktopWindowsForApp(targets[0], deps);
  }

  const runner = deps.runner || defaultRunner;
  const names = targets.map((app) => String(app.name || '').trim());
  const script = `
function run(argv) {
  var names = [];
  try { names = JSON.parse(String(argv[0] || '[]')); } catch (e) { names = []; }
  var se = Application('System Events');
  var all = [];
  for (var n = 0; n < names.length; n++) {
    var target = String(names[n] || '');
    if (!target) continue;
    var processes = [];
    try { processes = se.processes.whose({ name: target })(); } catch (e) { processes = []; }
    if (!processes || !processes.length) continue;
    var proc = processes[0];
    var windows = [];
    try { windows = proc.windows(); } catch (e) { windows = []; }
    for (var i = 0; i < windows.length; i++) {
      var win = windows[i];
      var title = '';
      var windowId = null;
      var minimized = false;
      var visible = true;
      try { title = String(win.name()); } catch (e) { title = ''; }
      try { windowId = win.attributes.byName('AXWindowNumber').value(); } catch (e) { windowId = null; }
      try { minimized = Boolean(win.attribute('AXMinimized').value()); } catch (e1) {
        try { minimized = Boolean(win.miniaturized()); } catch (e2) { minimized = false; }
      }
      try {
        var pos = win.position();
        var size = win.size();
        var w = Number(size[0] || 0);
        var h = Number(size[1] || 0);
        visible = !minimized && w > 1 && h > 1;
      } catch (e) {
        visible = !minimized;
      }
      if (windowId == null) continue;
      all.push({
        id: String(windowId),
        windowId: Number(windowId),
        title: title,
        index: i + 1,
        appName: target,
        minimized: minimized,
        visible: visible
      });
    }
  }
  return JSON.stringify(all);
}
`.trim();

  try {
    const { stdout } = await runner(
      '/usr/bin/osascript',
      ['-l', 'JavaScript', '-e', script, JSON.stringify(names)],
      { timeout: 15000 },
    );
    const rows = parseJsonLines(stdout);
    const byName = new Map(targets.map((app) => [String(app.name || '').trim(), app]));
    return rows
      .filter((row) => row && row.windowId != null)
      .map((row, index) => {
        const app = byName.get(String(row.appName || '').trim()) || {};
        return {
          id: String(row.id || row.windowId),
          windowId: Number(row.windowId),
          title: String(row.title || ''),
          index: Number(row.index || index + 1),
          appName: String(row.appName || app.name || ''),
          bundleId: String(app.bundleId || ''),
          path: String(app.path || ''),
          minimized: Boolean(row.minimized),
          visible: row.visible == null ? true : Boolean(row.visible),
        };
      });
  } catch (cause) {
    // Batch failed: degrade to sequential single-app calls.
    const out = [];
    for (const app of targets) {
      try {
        const rows = await listDesktopWindowsForApp(app, deps);
        out.push(...rows);
      } catch {
        /* skip failing app */
      }
    }
    return out;
  }
}

function clampText(value, maxChars) {
  const text = String(value || '');
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 1))}…`;
}

/**
 * Ensure windowId belongs to the allowed app before snapshot/screenshot.
 * @returns {Promise<{ windowId: number, title: string, appName: string, minimized: boolean, visible: boolean }>}
 */
async function assertWindowBelongsToApp(appTarget, windowId, deps = {}) {
  const id = Number(windowId);
  if (!id || Number.isNaN(id)) {
    const error = new Error('需要明确的 windowId。请先用 desktop_windows 获取窗口。');
    error.code = 'desktop_window_required';
    throw error;
  }
  const windows = await listDesktopWindowsForApp(appTarget, deps);
  const match = windows.find((row) => Number(row.windowId) === id);
  if (!match) {
    const error = new Error(
      `窗口 ${id} 不属于应用「${appTarget?.name || ''}」，或该窗口已关闭。请重新用 desktop_windows 获取 windowId。`,
    );
    error.code = 'desktop_window_mismatch';
    throw error;
  }
  return {
    windowId: id,
    title: String(match.title || ''),
    appName: String(match.appName || appTarget?.name || ''),
    minimized: Boolean(match.minimized),
    visible: match.visible == null ? true : Boolean(match.visible),
  };
}

async function captureDesktopSnapshot(appTarget, options = {}, deps = {}) {
  if ((deps.platform || process.platform) !== 'darwin') {
    const error = new Error('电脑操控目前仅支持 macOS。');
    error.code = 'desktop_unsupported_platform';
    throw error;
  }
  if (typeof deps.captureSnapshot === 'function') {
    return deps.captureSnapshot(appTarget, options);
  }

  const runner = deps.runner || defaultRunner;
  const processName = String(appTarget?.name || '').trim();
  let windowId = options.windowId != null ? Number(options.windowId) : null;
  const maxNodes = Math.min(Math.max(Number(options.maxNodes) || DEFAULT_MAX_NODES, 10), 200);
  const maxChars = Math.min(Math.max(Number(options.maxChars) || DEFAULT_MAX_CHARS, 1000), 40000);

  if (!processName) {
    const error = new Error('缺少应用名称，无法读取窗口结构。');
    error.code = 'desktop_invalid_app';
    throw error;
  }

  // Require explicit window ownership when an id is provided; otherwise pin to first owned window.
  if (windowId != null && !Number.isNaN(windowId)) {
    await assertWindowBelongsToApp(appTarget, windowId, deps);
  } else {
    const windows = await listDesktopWindowsForApp(appTarget, deps);
    if (!windows.length) {
      return {
        appName: processName,
        bundleId: String(appTarget.bundleId || ''),
        path: String(appTarget.path || ''),
        windowId: null,
        title: '',
        nodes: [],
        truncated: false,
        nodeCount: 0,
      };
    }
    windowId = Number(windows[0].windowId);
  }

  const script = `
function run(argv) {
  var target = String(argv[0] || '');
  var wantWindowId = argv[1] ? Number(argv[1]) : null;
  var maxNodes = Number(argv[2] || 80);
  var se = Application('System Events');
  var processes = se.processes.whose({ name: target })();
  if (!processes || processes.length === 0) {
    throw new Error('process_not_found');
  }
  var proc = processes[0];
  var windows = [];
  try { windows = proc.windows(); } catch (e) { windows = []; }
  if (!windows.length) {
    return JSON.stringify({ appName: target, windowId: null, title: '', nodes: [], truncated: false });
  }

  var win = windows[0];
  if (wantWindowId != null && !isNaN(wantWindowId)) {
    var matched = null;
    for (var i = 0; i < windows.length; i++) {
      var candidate = windows[i];
      var id = null;
      try { id = Number(candidate.attributes.byName('AXWindowNumber').value()); } catch (e) { id = null; }
      if (id === wantWindowId) { matched = candidate; break; }
    }
    if (!matched) throw new Error('window_not_found');
    win = matched;
  }

  var title = '';
  var windowId = null;
  try { title = String(win.name()); } catch (e) {}
  try { windowId = Number(win.attributes.byName('AXWindowNumber').value()); } catch (e) {}

  var nodes = [];
  var truncated = false;

  function roleOf(el) {
    try { return String(el.role()); } catch (e) { return ''; }
  }
  function titleOf(el) {
    try { return String(el.title()); } catch (e) {
      try { return String(el.name()); } catch (e2) { return ''; }
    }
  }
  function valueOf(el) {
    try {
      var value = el.value();
      if (value == null) return '';
      return String(value);
    } catch (e) { return ''; }
  }
  function descriptionOf(el) {
    try { return String(el.description()); } catch (e) { return ''; }
  }
  function subroleOf(el) {
    try { return String(el.subrole()); } catch (e) { return ''; }
  }
  function isSecure(el, role, subrole, description) {
    var text = (String(role || '') + ' ' + String(subrole || '') + ' ' + String(description || '')).toLowerCase();
    if (text.indexOf('secure') >= 0 || text.indexOf('password') >= 0) return true;
    try {
      var attrs = el.attributes();
      for (var i = 0; i < attrs.length; i++) {
        var attrName = '';
        try { attrName = String(attrs[i].name()); } catch (e) { attrName = ''; }
        if (/securetextfield|password/i.test(attrName)) return true;
      }
    } catch (e) {}
    return false;
  }
  function boundsOf(el) {
    try {
      var p = el.position();
      var s = el.size();
      return {
        x: Number(p[0]),
        y: Number(p[1]),
        width: Number(s[0]),
        height: Number(s[1])
      };
    } catch (e) {
      return null;
    }
  }

  function walk(el, depth, path) {
    if (nodes.length >= maxNodes) {
      truncated = true;
      return;
    }
    var role = roleOf(el);
    var name = titleOf(el);
    var subrole = subroleOf(el);
    var description = descriptionOf(el);
    var secure = isSecure(el, role, subrole, description);
    var value = secure ? '' : valueOf(el);
    var bounds = boundsOf(el);
    if (role || name || value || description || bounds) {
      nodes.push({
        ref: 'n' + (nodes.length + 1),
        role: role,
        name: name,
        value: value,
        description: description,
        depth: depth,
        path: path,
        bounds: bounds,
        secure: secure
      });
    }
    var children = [];
    try { children = el.uiElements(); } catch (e) { children = []; }
    for (var i = 0; i < children.length; i++) {
      if (nodes.length >= maxNodes) {
        truncated = true;
        break;
      }
      var childPath = path ? (path + '/' + (i + 1)) : String(i + 1);
      walk(children[i], depth + 1, childPath);
    }
  }

  walk(win, 0, '1');
  return JSON.stringify({
    appName: target,
    windowId: windowId,
    title: title,
    nodes: nodes,
    truncated: truncated
  });
}
`.trim();

  const args = [
    '-l', 'JavaScript', '-e', script,
    processName,
    windowId != null && !Number.isNaN(windowId) ? String(windowId) : '',
    String(maxNodes),
  ];

  try {
    const { stdout } = await runner('/usr/bin/osascript', args, { timeout: 15000 });
    const rows = parseJsonLines(stdout);
    const payload = rows[0] || {};
    const nodes = Array.isArray(payload.nodes) ? payload.nodes : [];
    let used = 0;
    const limited = [];
    let truncated = Boolean(payload.truncated);
    for (const node of nodes) {
      const bounds = node.bounds && typeof node.bounds === 'object'
        ? {
          x: Number(node.bounds.x) || 0,
          y: Number(node.bounds.y) || 0,
          width: Number(node.bounds.width) || 0,
          height: Number(node.bounds.height) || 0,
        }
        : null;
      const next = {
        ref: String(node.ref || `n${limited.length + 1}`),
        role: clampText(node.role, 80),
        name: clampText(node.name, 240),
        value: clampText(node.value, 240),
        description: clampText(node.description, 240),
        depth: Number(node.depth) || 0,
        path: clampText(node.path, 120),
        bounds,
        secure: Boolean(node.secure),
      };
      const cost = JSON.stringify(next).length + 1;
      if (used + cost > maxChars) {
        truncated = true;
        break;
      }
      limited.push(next);
      used += cost;
    }
    return {
      appName: String(payload.appName || processName),
      bundleId: String(appTarget.bundleId || ''),
      path: String(appTarget.path || ''),
      windowId: payload.windowId != null ? Number(payload.windowId) : windowId,
      title: String(payload.title || ''),
      nodes: limited,
      truncated,
      nodeCount: limited.length,
    };
  } catch (cause) {
    const message = String(cause && cause.message ? cause.message : cause);
    if (/window_not_found/i.test(message)) {
      const error = new Error('找不到指定窗口。请先用 desktop_windows 确认 windowId。');
      error.code = 'desktop_window_not_found';
      throw error;
    }
    if (/process_not_found/i.test(message)) {
      const error = new Error(`应用「${processName}」当前没有可读取的进程。`);
      error.code = 'desktop_process_not_found';
      throw error;
    }
    const error = new Error(`无法读取窗口结构：${message}`);
    error.code = 'desktop_snapshot_failed';
    error.cause = cause;
    throw error;
  }
}

async function captureDesktopScreenshot(appTarget, options = {}, deps = {}) {
  if ((deps.platform || process.platform) !== 'darwin') {
    const error = new Error('电脑操控目前仅支持 macOS。');
    error.code = 'desktop_unsupported_platform';
    throw error;
  }
  if (typeof deps.captureScreenshot === 'function') {
    return deps.captureScreenshot(appTarget, options);
  }

  const runner = deps.runner || defaultRunner;
  const windowId = options.windowId != null ? Number(options.windowId) : NaN;
  if (!windowId || Number.isNaN(windowId)) {
    const error = new Error('截图需要明确的 windowId，不会进行全屏截图。请先用 desktop_windows 获取窗口。');
    error.code = 'desktop_window_required';
    throw error;
  }

  const owned = await assertWindowBelongsToApp(appTarget, windowId, deps);
  if (owned.minimized || owned.visible === false) {
    const error = new Error(
      `窗口 ${windowId} 当前不可见或已最小化，无法截图。请先恢复窗口，或换一个可见窗口。`,
    );
    error.code = 'desktop_window_not_visible';
    throw error;
  }

  const tempFile = path.join(
    os.tmpdir(),
    `pi-studio-desktop-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.png`,
  );
  const scaledFile = `${tempFile}.scaled.png`;

  try {
    await runner('/usr/sbin/screencapture', ['-x', '-l', String(windowId), tempFile], { timeout: 12000 });
    if (!fs.existsSync(tempFile)) {
      const error = new Error('截图失败：未生成图像文件。请确认屏幕录制权限已授予，且 windowId 有效。');
      error.code = 'desktop_screenshot_failed';
      throw error;
    }
    let buffer = fs.readFileSync(tempFile);
    if (!buffer.length) {
      const error = new Error('截图失败：图像为空。目标窗口可能不可见或 windowId 无效。');
      error.code = 'desktop_screenshot_failed';
      throw error;
    }

    // Soft-cap large retina captures before they enter tool/session history.
    const maxBytes = Number(options.maxBytes) || DEFAULT_MAX_SCREENSHOT_BYTES;
    const maxEdge = Number(options.maxEdge) || DEFAULT_MAX_SCREENSHOT_EDGE;
    let scaled = false;
    if (buffer.length > maxBytes) {
      try {
        await runner(
          '/usr/bin/sips',
          ['-Z', String(maxEdge), tempFile, '--out', scaledFile],
          { timeout: 12000 },
        );
        if (fs.existsSync(scaledFile)) {
          const next = fs.readFileSync(scaledFile);
          if (next.length && next.length < buffer.length) {
            buffer = next;
            scaled = true;
          }
        }
      } catch {
        /* keep original if sips fails */
      }
    }

    return {
      mimeType: 'image/png',
      data: buffer.toString('base64'),
      windowId,
      appName: String(appTarget?.name || ''),
      bundleId: String(appTarget?.bundleId || ''),
      bytes: buffer.length,
      scaled,
    };
  } catch (cause) {
    if (cause && cause.code && String(cause.code).startsWith('desktop_')) throw cause;
    const error = new Error(`窗口截图失败：${cause && cause.message ? cause.message : cause}`);
    error.code = 'desktop_screenshot_failed';
    error.cause = cause;
    throw error;
  } finally {
    try {
      fs.unlinkSync(tempFile);
    } catch {
      /* ignore temp cleanup */
    }
    try {
      fs.unlinkSync(scaledFile);
    } catch {
      /* ignore */
    }
  }
}

module.exports = {
  escapeAppleScriptString,
  defaultRunner,
  listRunningDesktopApps,
  listDesktopWindowsForApp,
  listDesktopWindowsForApps,
  assertWindowBelongsToApp,
  captureDesktopSnapshot,
  captureDesktopScreenshot,
  DEFAULT_MAX_NODES,
  DEFAULT_MAX_CHARS,
  DEFAULT_MAX_SCREENSHOT_BYTES,
  DEFAULT_MAX_SCREENSHOT_EDGE,
};
