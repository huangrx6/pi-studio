/**
 * Read-only desktop observation helpers (running apps, windows, AX snapshot, window screenshot).
 * Real GUI work goes through an injectable runner so unit tests never need Accessibility.
 */
const { execFile } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { promisify } = require('node:util');
const { bindSnapshotNodes, JXA_AX_IDENTITY } = require('./ax-targets.cjs');

const execFileAsync = promisify(execFile);

const DEFAULT_MAX_NODES = 80;
const DEFAULT_MAX_CHARS = 12000;

/** Soft cap for returned screenshot payloads (bytes of PNG before base64). */
const DEFAULT_MAX_SCREENSHOT_BYTES = 900 * 1024;
const DEFAULT_MAX_SCREENSHOT_EDGE = 1600;

function readPngDimensions(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 24) return null;
  if (buffer[0] !== 0x89 || buffer[1] !== 0x50 || buffer[2] !== 0x4e || buffer[3] !== 0x47) return null;
  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);
  if (!(width > 0) || !(height > 0)) return null;
  return { width, height };
}

/**
 * Shared JXA helpers for macOS desktop observation/actions:
 * - Resolves running apps by bundleId, path, localizedName, or executable name
 *   so either the localized or executable name can identify an application.
 * - Enumerates real CGWindow IDs & bounds via CoreGraphics across ALL displays
 *   (primary + secondary monitors), instead of relying on System Events'
 *   unreliable AXWindowNumber attribute.
 * - Matches a CGWindow ID to an AX window by ID, or by uniquely corresponding frames.
 */
const JXA_DESKTOP_HELPERS = `
function findRunningApp(name, bundleId, appPath) {
  var ws = $.NSWorkspace.sharedWorkspace;
  var apps = ObjC.unwrap(ws.runningApplications) || [];
  var wantBundle = String(bundleId || '').trim().toLowerCase();
  var wantPath = String(appPath || '').trim().toLowerCase();
  var wantName = String(name || '').trim().toLowerCase();
  var byName = null;
  for (var i = 0; i < apps.length; i++) {
    var app = apps[i];
    try {
      var b = String(ObjC.unwrap(app.bundleIdentifier) || '').trim();
      var n = String(ObjC.unwrap(app.localizedName) || '').trim();
      var p = '';
      var execName = '';
      try { var u = app.bundleURL; if (u) p = String(ObjC.unwrap(u.path) || '').trim(); } catch (e) {}
      try { var eu = app.executableURL; if (eu) execName = String(ObjC.unwrap(eu.lastPathComponent) || '').trim(); } catch (e) {}
      var pid = Number(app.processIdentifier) || 0;
      if (!pid) continue;
      if (wantBundle && b.toLowerCase() !== wantBundle) continue;
      if (wantPath && p.toLowerCase() !== wantPath) continue;
      if (wantBundle || wantPath) {
        return { pid: pid, name: n || execName, bundleId: b, path: p, execName: execName, nsApp: app };
      }
      if (!byName && wantName && (n.toLowerCase() === wantName || execName.toLowerCase() === wantName)) {
        byName = { pid: pid, name: n || execName, bundleId: b, path: p, execName: execName, nsApp: app };
      }
    } catch (e) {}
  }
  return byName;
}

function listCgWindowsForPid(pid) {
  if (!pid) return [];
  var raw = $.CGWindowListCopyWindowInfo($.kCGWindowListOptionAll | $.kCGWindowListExcludeDesktopElements, 0);
  var wins = ObjC.deepUnwrap(ObjC.castRefToObject(raw)) || [];
  var out = [];
  for (var i = 0; i < wins.length; i++) {
    var w = wins[i];
    if (!w || Number(w.kCGWindowOwnerPID) !== Number(pid)) continue;
    if (Number(w.kCGWindowLayer) !== 0) continue;
    var b = w.kCGWindowBounds || {};
    var width = Number(b.Width) || 0;
    var height = Number(b.Height) || 0;
    // Skip tiny status/helper bars (e.g. 1920x30 or 1x1 invisible overlays).
    if (width < 80 || height < 60) continue;
    var winId = Number(w.kCGWindowNumber);
    if (!winId || isNaN(winId)) continue;
    out.push({
      windowId: winId,
      title: String(w.kCGWindowName || ''),
      x: Number(b.X) || 0,
      y: Number(b.Y) || 0,
      width: width,
      height: height,
      onscreen: Boolean(w.kCGWindowIsOnscreen) && (w.kCGWindowAlpha == null || Number(w.kCGWindowAlpha) > 0.01),
      captureProtected: w.kCGWindowSharingState != null && Number(w.kCGWindowSharingState) === 0,
    });
  }
  out.sort(function (a, b) {
    if (a.onscreen !== b.onscreen) return a.onscreen ? -1 : 1;
    return (b.width * b.height) - (a.width * a.height);
  });
  return out;
}

function findSeProcess(se, name, bundleId, pid) {
  var list = [];
  if (pid) {
    try { list = se.processes.whose({ unixId: Number(pid) })(); } catch (e) { list = []; }
    return list && list.length === 1 ? list[0] : null;
  }
  if (bundleId) {
    try { list = se.processes.whose({ bundleIdentifier: String(bundleId) })(); } catch (e) { list = []; }
    if (list && list.length) return list[0];
  }
  if (name) {
    try { list = se.processes.whose({ displayedName: String(name) })(); } catch (e) { list = []; }
    if (list && list.length) return list[0];
    try { list = se.processes.whose({ name: String(name) })(); } catch (e) { list = []; }
    if (list && list.length) return list[0];
  }
  return null;
}

function describeAxWindows(proc) {
  var windows = [];
  try { windows = proc.windows(); } catch (e) { windows = []; }
  return windows.map(function (win) {
    var row = { window: win, windowId: 0, title: '' };
    try { row.windowId = Number(win.attributes.byName('AXWindowNumber').value()) || 0; } catch (e) {}
    try { row.title = String(win.name() || ''); } catch (e) {}
    try {
      var p = win.position(), s = win.size();
      row.x = Number(p[0]); row.y = Number(p[1]);
      row.width = Number(s[0]); row.height = Number(s[1]);
    } catch (e) {}
    return row;
  });
}

function correspondingFrames(ax, cg) {
  if (ax.title && cg.title && ax.title !== cg.title) return false;
  return ['x', 'y', 'width', 'height'].every(function (k) { return Math.abs(ax[k] - cg[k]) <= 2; });
}

function matchAxWindow(axWindows, cgWindow, cgWindows) {
  var exact = axWindows.filter(function (ax) { return ax.windowId === cgWindow.windowId; });
  if (exact.length) return exact.length === 1 ? exact[0] : null;
  if (!cgWindows) return null;
  var possible = axWindows.filter(function (ax) { return !ax.windowId && correspondingFrames(ax, cgWindow); });
  if (possible.length !== 1) return null;
  var ax = possible[0];
  return cgWindows.filter(function (cg) { return correspondingFrames(ax, cg); }).length === 1 ? ax : null;
}

function findSeWindowForWindowId(proc, cgWindow, wantWindowId, cgWindows) {
  if (!proc || !cgWindow || cgWindow.windowId !== Number(wantWindowId)) return null;
  var match = matchAxWindow(describeAxWindows(proc), cgWindow, cgWindows);
  return match ? match.window : null;
}
`.trim();

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
  const bundleId = String(appTarget?.bundleId || '').trim();
  const appPath = String(appTarget?.path || '').trim();
  if (!processName && !bundleId) {
    const error = new Error('缺少应用名称，无法列出窗口。');
    error.code = 'desktop_invalid_app';
    throw error;
  }

  const script = `
ObjC.import('AppKit');
ObjC.import('CoreGraphics');
${JXA_DESKTOP_HELPERS}
function run(argv) {
  var targetName = String(argv[0] || '');
  var targetBundle = String(argv[1] || '');
  var targetPath = String(argv[2] || '');
  var app = findRunningApp(targetName, targetBundle, targetPath);
  if (!app) return JSON.stringify([]);
  var cgWins = listCgWindowsForPid(app.pid);
  if (!cgWins.length) return JSON.stringify([]);

  var axWindows = [], mainIds = [];
  try {
    var se = Application('System Events');
    var proc = findSeProcess(se, app.name || targetName, app.bundleId || targetBundle, app.pid);
    if (proc) {
      axWindows = describeAxWindows(proc);
      try {
        var mainWindow = proc.attributes.byName('AXMainWindow').value();
        var mainId = Number(mainWindow.attributes.byName('AXWindowNumber').value());
        if (mainId > 0) mainIds.push(mainId);
      } catch (e) {}
    }
  } catch (e) {}

  var rows = [];
  for (var i = 0; i < cgWins.length; i++) {
    var cw = cgWins[i];
    var title = cw.title || '';
    var minimized = cw.onscreen ? false : null;
    var match = matchAxWindow(axWindows, cw, cgWins);
    if (match) {
      if (!title) title = match.title;
      try {
        if (match.window.attributes.byName('AXMain').value() === true) mainIds.push(cw.windowId);
      } catch (e) {}
      try {
        var state = match.window.attributes.byName('AXMinimized').value();
        if (typeof state === 'boolean') minimized = state;
      } catch (e) {}
    }
    rows.push({
      id: String(cw.windowId),
      windowId: cw.windowId,
      title: title,
      index: i + 1,
      appName: targetName || app.name,
      minimized: minimized,
      visible: cw.onscreen && !minimized,
      captureProtected: Boolean(cw.captureProtected),
      bounds: { x: cw.x, y: cw.y, width: cw.width, height: cw.height }
    });
  }
  if (mainIds.length && mainIds.every(function (id) { return id === mainIds[0]; })) {
    var mainRows = rows.filter(function (row) { return row.windowId === mainIds[0]; });
    if (mainRows.length === 1) mainRows[0].main = true;
  }
  return JSON.stringify(rows);
}
`.trim();

  try {
    const { stdout } = await runner(
      '/usr/bin/osascript',
      ['-l', 'JavaScript', '-e', script, processName, bundleId, appPath],
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
        minimized: row.minimized == null ? null : Boolean(row.minimized),
        ...(row.main === true ? { main: true } : {}),
        visible: row.visible == null ? true : Boolean(row.visible),
        captureProtected: Boolean(row.captureProtected),
        ...(row.bounds ? { bounds: row.bounds } : {}),
      }));
  } catch (cause) {
    const error = new Error(`无法列出「${processName}」的窗口：${cause && cause.message ? cause.message : cause}`);
    error.code = 'desktop_list_windows_failed';
    error.cause = cause;
    throw error;
  }
}

/**
 * List windows for many apps in one CoreGraphics pass when possible.
 * Falls back to per-app listing when a custom listWindows injector is provided.
 */
async function listDesktopWindowsForApps(appTargets = [], deps = {}) {
  const targets = (Array.isArray(appTargets) ? appTargets : [])
    .filter((app) => app && (String(app.name || '').trim() || String(app.bundleId || '').trim()));
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
  const descriptors = targets.map((app) => ({
    name: String(app.name || '').trim(),
    bundleId: String(app.bundleId || '').trim(),
    path: String(app.path || '').trim(),
  }));
  const script = `
ObjC.import('AppKit');
ObjC.import('CoreGraphics');
${JXA_DESKTOP_HELPERS}
function run(argv) {
  var list = [];
  try { list = JSON.parse(String(argv[0] || '[]')); } catch (e) { list = []; }
  var all = [];
  for (var n = 0; n < list.length; n++) {
    var spec = list[n] || {};
    var app = findRunningApp(spec.name, spec.bundleId, spec.path);
    if (!app) continue;
    var cgWins = listCgWindowsForPid(app.pid);
    for (var i = 0; i < cgWins.length; i++) {
      var cw = cgWins[i];
      all.push({
        id: String(cw.windowId),
        windowId: cw.windowId,
        title: cw.title || '',
        index: i + 1,
        appName: spec.name || app.name,
        bundleId: spec.bundleId || app.bundleId || '',
        path: spec.path || app.path || '',
        minimized: cw.onscreen ? false : null,
        visible: Boolean(cw.onscreen),
        captureProtected: Boolean(cw.captureProtected),
        bounds: { x: cw.x, y: cw.y, width: cw.width, height: cw.height }
      });
    }
  }
  return JSON.stringify(all);
}
`.trim();

  try {
    const { stdout } = await runner(
      '/usr/bin/osascript',
      ['-l', 'JavaScript', '-e', script, JSON.stringify(descriptors)],
      { timeout: 15000 },
    );
    const rows = parseJsonLines(stdout);
    const byKey = new Map(targets.map((app) => [String(app.bundleId || app.name || '').trim(), app]));
    return rows
      .filter((row) => row && row.windowId != null)
      .map((row, index) => {
        const app = byKey.get(String(row.bundleId || row.appName || '').trim()) || {};
        return {
          id: String(row.id || row.windowId),
          windowId: Number(row.windowId),
          title: String(row.title || ''),
          index: Number(row.index || index + 1),
          appName: String(row.appName || app.name || ''),
          bundleId: String(row.bundleId || app.bundleId || ''),
          path: String(row.path || app.path || ''),
          minimized: row.minimized == null ? null : Boolean(row.minimized),
          visible: row.visible == null ? true : Boolean(row.visible),
          captureProtected: Boolean(row.captureProtected),
          ...(row.bounds ? { bounds: row.bounds } : {}),
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
 * @returns {Promise<{ windowId: number, title: string, appName: string, minimized: boolean | null, visible: boolean }>}
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
    minimized: match.minimized == null ? null : Boolean(match.minimized),
    visible: match.visible == null ? true : Boolean(match.visible),
    captureProtected: Boolean(match.captureProtected),
    ...(match.bounds ? { bounds: match.bounds } : {}),
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
  if (windowId != null) {
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
ObjC.import('AppKit');
ObjC.import('CoreGraphics');
${JXA_DESKTOP_HELPERS}
${JXA_AX_IDENTITY}
function run(argv) {
  var target = String(argv[0] || '');
  var wantWindowId = argv[1] ? Number(argv[1]) : null;
  var maxNodes = Number(argv[2] || 80);
  var targetBundle = String(argv[3] || '');
  var targetPath = String(argv[4] || '');
  var runningApp = findRunningApp(target, targetBundle, targetPath);
  var cgWins = runningApp ? listCgWindowsForPid(runningApp.pid) : [];
  var cgWin = null;
  if (wantWindowId != null && !isNaN(wantWindowId)) {
    for (var c = 0; c < cgWins.length; c++) {
      if (cgWins[c].windowId === wantWindowId) { cgWin = cgWins[c]; break; }
    }
  } else if (cgWins.length) {
    cgWin = cgWins[0];
  }
  var se = Application('System Events');
  var proc = findSeProcess(se, runningApp ? runningApp.name : target, runningApp ? runningApp.bundleId : targetBundle, runningApp ? runningApp.pid : 0);
  if (!proc) {
    throw new Error('process_not_found');
  }
  if (!cgWin) throw new Error('window_not_found');
  var win = findSeWindowForWindowId(proc, cgWin, wantWindowId, cgWins);
  if (!win) {
    throw new Error('ax_window_unresolved');
  }

  var title = cgWin && cgWin.title ? cgWin.title : '';
  var windowId = cgWin ? cgWin.windowId : wantWindowId;
  try { var axTitle = String(win.name() || ''); if (axTitle) title = axTitle; } catch (e) {}
  if (windowId == null) {
    try { windowId = Number(win.attributes.byName('AXWindowNumber').value()); } catch (e) {}
  }

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
        axIdentity: axIdentity(el, role, name, subrole, description),
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
    pid: runningApp.pid,
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
    String(appTarget?.bundleId || ''),
    String(appTarget?.path || ''),
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
      next.axIdentity = node.axIdentity;
      limited.push(next);
      used += cost;
    }
    bindSnapshotNodes(deps.sessionId, windowId, payload.pid, limited);
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
    const message = String(cause?.stderr || cause?.message || cause);
    if (/ax_window_unresolved/i.test(message)) {
      const error = new Error(`窗口 ${windowId} 仍存在，但辅助功能未能唯一识别它。可以用同一 windowId 检查单窗口画面。`);
      error.code = 'desktop_ax_window_unresolved';
      throw error;
    }
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

  const owned = deps.ownedWindow?.windowId === windowId
    ? deps.ownedWindow : await assertWindowBelongsToApp(appTarget, windowId, deps);
  if (owned.minimized === true) {
    const error = new Error(
      `窗口 ${windowId} 已最小化。请先恢复这个窗口再截图。`,
    );
    error.code = 'desktop_window_not_visible';
    throw error;
  }
  if (owned.captureProtected) {
    const error = new Error(
      `窗口 ${windowId} 的 Core Graphics 共享状态为 0，Pi Studio 已跳过自动截图。要验证该窗口能否共享，请在 macOS 屏幕共享选择器中手动选择它。`,
    );
    error.code = 'desktop_window_capture_protected';
    throw error;
  }

  const maxBytes = Number(options.maxBytes) || DEFAULT_MAX_SCREENSHOT_BYTES;
  const maxEdge = Number(options.maxEdge) || DEFAULT_MAX_SCREENSHOT_EDGE;
  const popupWaitMs = Math.min(3000, Math.max(0, Number(options.popupWaitMs) || 0));
  const captureStarted = Date.now();

  // Prefer native ScreenCaptureKit composite capture (captures target window + its
  // search dropdowns/popovers/menus while still excluding all other applications).
  if (typeof deps.captureWindow === 'function') {
    try {
      const sck = await deps.captureWindow({
        windowId,
        includePopups: options.includePopups !== false,
        popupWaitMs,
        maxEdge,
        format: options.format || 'png',
        quality: options.quality,
        timeoutMs: Number(options.timeoutMs) || 12000,
      });
      if (sck && sck.data) {
        return {
          mimeType: String(sck.mimeType || 'image/png'),
          data: String(sck.data),
          windowId,
          appName: String(appTarget?.name || ''),
          bundleId: String(appTarget?.bundleId || ''),
          title: owned.title || '',
          bounds: sck.bounds || owned.bounds || null,
          imageWidth: Number(sck.imageWidth) || null,
          imageHeight: Number(sck.imageHeight) || null,
          bytes: Number(sck.bytes) || Buffer.byteLength(String(sck.data), 'base64'),
          scaled: Boolean(sck.scaled),
          overlayCount: Number(sck.overlayCount || 0),
          panels: sck.panels || [],
          accessibilityOptions: sck.accessibilityOptions || [],
          popupRegions: sck.popupRegions || [],
          ...(sck.captureMode ? { captureMode: String(sck.captureMode) } : {}),
        };
      }
    } catch {
      /* Fall back cleanly to screencapture -l on macOS 13 or transient SCK errors. */
    }
  }

  const tempFile = path.join(
    os.tmpdir(),
    `pi-studio-desktop-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.png`,
  );
  const scaledFile = `${tempFile}.scaled.png`;

  try {
    // A single-window fallback can still see suggestions drawn inside the window.
    const remaining = popupWaitMs - (Date.now() - captureStarted);
    if (remaining > 0) await new Promise(resolve => setTimeout(resolve, remaining));
    // `-o` omits the macOS drop shadow so image pixel (0,0) aligns strictly with window bounds (x,y).
    await runner('/usr/sbin/screencapture', ['-x', '-o', '-l', String(windowId), tempFile], { timeout: 12000 });
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
    let scaled = false;
    if (buffer.length > maxBytes) {
      try {
        const resize = deps.localRunner || runner;
        await resize(
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

    const dims = readPngDimensions(buffer);
    return {
      captureMode: 'single_window_fallback',
      overlayCount: 0,
      mimeType: 'image/png',
      data: buffer.toString('base64'),
      windowId,
      appName: String(appTarget?.name || ''),
      bundleId: String(appTarget?.bundleId || ''),
      title: owned.title || '',
      bounds: owned.bounds || null,
      imageWidth: dims ? dims.width : null,
      imageHeight: dims ? dims.height : null,
      bytes: buffer.length,
      scaled,
    };
  } catch (cause) {
    if (owned.visible === false && (!cause?.code || !String(cause.code).startsWith('desktop_') || cause.code === 'desktop_screenshot_failed')) {
      const error = new Error(`窗口 ${windowId} 仍在该应用的窗口列表，但系统未返回离屏画面。可尝试读取同一窗口的辅助功能结构，或切回其桌面。`, { cause });
      error.code = 'desktop_window_offscreen';
      throw error;
    }
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
  JXA_DESKTOP_HELPERS,
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
