/**
 * Windows (win32) desktop-control platform adapter.
 *
 * Uses a persistent hidden PowerShell + inline C# (Win32 / DWM / UI Automation /
 * PrintWindow / SendInput) worker so native types compile once and calls run in
 * ~10–30ms with zero console flash and full multi-monitor / high-DPI support.
 *
 * Supports injectable `win32Bridge` in unit tests so all logic can be verified
 * cross-platform without requiring a live Windows desktop.
 */
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const HELPER_SCRIPT = path.join(__dirname, 'win32-helper.ps1');

function resolveRunnableScriptPath(scriptPath) {
  // PowerShell `-File` cannot execute a script packed inside an Electron `.asar` archive.
  // Materialize a deterministic temp copy when running from inside `.asar`.
  if (!String(scriptPath || '').includes('.asar')) return scriptPath;
  try {
    const content = fs.readFileSync(scriptPath, 'utf8');
    const hash = crypto.createHash('sha1').update(content).digest('hex').slice(0, 12);
    const target = path.join(os.tmpdir(), `pi-studio-win32-helper-${hash}.ps1`);
    if (!fs.existsSync(target)) {
      fs.writeFileSync(target, content, 'utf8');
    }
    return target;
  } catch {
    return scriptPath;
  }
}
const DEFAULT_MAX_NODES = 80;
const DEFAULT_MAX_CHARS = 12000;
const DEFAULT_MAX_SCREENSHOT_EDGE = 1600;
const DEFAULT_MAX_TYPE_CHARS = 2000;
const DEFAULT_SCROLL_AMOUNT = 3;
const MAX_SCROLL_AMOUNT = 40;
const DEFAULT_DRAG_STEPS = 12;
const MAX_DRAG_STEPS = 40;
const MAX_DRAG_DISTANCE = 3000;

/** Named non-character keys → Windows Virtual-Key (VK_*) codes. */
const WIN32_VK_CODES = Object.freeze({
  return: 0x0d,
  enter: 0x0d,
  tab: 0x09,
  space: 0x20,
  escape: 0x1b,
  esc: 0x1b,
  delete: 0x08,
  backspace: 0x08,
  forwarddelete: 0x2e,
  del: 0x2e,
  left: 0x25,
  up: 0x26,
  right: 0x27,
  down: 0x28,
  home: 0x24,
  end: 0x23,
  pageup: 0x21,
  pagedown: 0x22,
  f1: 0x70,
  f2: 0x71,
  f3: 0x72,
  f4: 0x73,
  f5: 0x74,
  f6: 0x75,
  f7: 0x76,
  f8: 0x77,
  f9: 0x78,
  f10: 0x79,
  f11: 0x7a,
  f12: 0x7b,
});

const WIN32_MODIFIER_VK = Object.freeze({
  control: 0x11, // VK_CONTROL
  shift: 0x10,   // VK_SHIFT
  alt: 0x12,     // VK_MENU
  win: 0x5b,     // VK_LWIN
});

const WIN32_MODIFIER_ALIASES = Object.freeze({
  ctrl: 'control',
  control: 'control',
  cmd: 'control',
  command: 'control',
  shift: 'shift',
  alt: 'alt',
  option: 'alt',
  opt: 'alt',
  win: 'win',
  meta: 'win',
  super: 'win',
});

const WIN32_BLOCKED_HOTKEYS = Object.freeze([
  { key: 'f4', modifiers: ['alt'], reason: '不会发送 Alt+F4（关闭应用窗口）' },
  { key: 'tab', modifiers: ['alt'], reason: '不会发送 Alt+Tab（切换系统应用）' },
  { key: 'delete', modifiers: ['control', 'alt'], reason: '不会发送 Ctrl+Alt+Delete（系统安全界面）' },
  { key: 'forwarddelete', modifiers: ['control', 'alt'], reason: '不会发送 Ctrl+Alt+Delete（系统安全界面）' },
  { key: 'l', modifiers: ['win'], reason: '不会发送 Win+L（锁屏）' },
  { key: 'r', modifiers: ['win'], reason: '不会发送 Win+R（运行系统命令框）' },
  { key: 'escape', modifiers: ['control', 'shift'], reason: '不会发送 Ctrl+Shift+Esc（任务管理器）' },
]);

function createWin32HelperClient(options = {}) {
  const scriptPath = options.scriptPath || HELPER_SCRIPT;
  const spawnHelper = options.spawn || spawn;
  let child = null;
  let readyPromise = null;
  let reqSeq = 0;
  /** @type {Map<string, { resolve: Function, reject: Function, timer: NodeJS.Timeout }>} */
  const pending = new Map();

  function failAll(err) {
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(err);
    }
    pending.clear();
  }

  function ensureStarted() {
    if (readyPromise && child && !child.killed) return readyPromise;
    const runnableScript = resolveRunnableScriptPath(scriptPath);
    readyPromise = new Promise((resolve, reject) => {
      const proc = spawnHelper(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', runnableScript],
        {
          stdio: ['pipe', 'pipe', 'pipe'],
          windowsHide: true,
        },
      );
      child = proc;
      let buffer = '';
      let started = false;
      const startTimer = setTimeout(() => {
        if (!started) {
          stop();
          const err = new Error('Windows 电脑操控辅助进程启动超时。');
          err.code = 'desktop_helper_timeout';
          reject(err);
        }
      }, 15000);
      startTimer.unref?.();

      proc.stdout.setEncoding('utf8');
      proc.stdout.on('data', (chunk) => {
        if (child !== proc) return;
        buffer += chunk;
        let idx = buffer.indexOf('\n');
        while (idx !== -1) {
          const line = buffer.slice(0, idx).trim();
          buffer = buffer.slice(idx + 1);
          idx = buffer.indexOf('\n');
          if (!line) continue;
          let msg;
          try { msg = JSON.parse(line); } catch { continue; }
          if (!started && msg.ready === true) {
            started = true;
            clearTimeout(startTimer);
            resolve();
            continue;
          }
          const id = String(msg.id || '');
          const waiter = pending.get(id);
          if (!waiter) continue;
          pending.delete(id);
          clearTimeout(waiter.timer);
          if (msg.ok) waiter.resolve(msg.result);
          else {
            const err = new Error(String(msg.error || 'win32_helper_error'));
            err.code = /^desktop_[a-z_]+$/.test(msg.code || '') ? msg.code
              : (/\b(desktop_[a-z_]+)\b/.exec(err.message)?.[1] || 'desktop_win32_helper_error');
            waiter.reject(err);
          }
        }
      });

      let stderrTail = '';
      proc.stderr.setEncoding('utf8');
      proc.stderr.on('data', (chunk) => {
        stderrTail = (stderrTail + chunk).slice(-1200);
      });

      function disconnected(err) {
        clearTimeout(startTimer);
        if (!started) reject(err);
        if (child !== proc) return;
        child = null;
        readyPromise = null;
        failAll(err);
        if (proc.pid && !proc.killed && proc.exitCode == null && proc.signalCode == null) proc.kill();
      }
      proc.on('error', cause => disconnected(Object.assign(
        new Error(`无法启动 Windows 电脑操控辅助进程：${cause.message || cause}`), { code: 'desktop_helper_unavailable' })));
      proc.stdin.on('error', cause => disconnected(Object.assign(
        new Error('Windows 电脑操控助手的输入管道已断开。', { cause }), { code: 'desktop_helper_exited' })));
      proc.on('exit', code => disconnected(Object.assign(
        new Error(`Windows 电脑操控辅助进程已退出（code=${code}）${stderrTail ? `：${stderrTail.trim()}` : ''}`),
        { code: 'desktop_helper_exited' })));
    });
    return readyPromise;
  }

  async function request(action, params = {}, timeoutMs = 15000) {
    await ensureStarted();
    if (!child || !child.stdin || child.killed) {
      const err = new Error('Windows 电脑操控辅助进程不可用。');
      err.code = 'desktop_helper_unavailable';
      throw err;
    }
    const id = `w${++reqSeq}`;
    const proc = child;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        const err = new Error(`Windows 电脑操控请求超时（${action}）`);
        err.code = 'desktop_helper_timeout';
        reject(err);
        // Terminate a blocked worker so queued input cannot run after its caller timed out.
        if (child === proc) stop();
      }, timeoutMs);
      timer.unref?.();
      pending.set(id, { resolve, reject, timer });
      proc.stdin.write(`${JSON.stringify({ id, action, params })}\n`);
    });
  }

  function stop() {
    const proc = child;
    child = null;
    readyPromise = null;
    if (proc && !proc.killed) {
      try { proc.kill(); } catch { /* ignore */ }
    }
    failAll(Object.assign(new Error('Windows helper stopped'), { code: 'desktop_helper_stopped' }));
    return Promise.resolve();
  }

  return { request, stop };
}

const defaultWin32Helper = createWin32HelperClient();
let win32MappingsCache = null;

function getBridge(deps = {}) {
  return deps.win32Bridge || defaultWin32Helper;
}

function normalizeWin32Hotkey(options = {}) {
  const rawKey = String(options.key || options.keys || '').trim();
  const rawMods = Array.isArray(options.modifiers)
    ? options.modifiers
    : (Array.isArray(options.mods) ? options.mods : []);
  if (!rawKey) {
    const err = new Error('快捷键不能为空。');
    err.code = 'desktop_hotkey_empty';
    throw err;
  }

  const tokens = rawKey.includes('+')
    ? rawKey.split('+').map((t) => t.trim()).filter(Boolean)
    : [rawKey];
  const mods = new Set();
  for (const m of rawMods) {
    const canonical = WIN32_MODIFIER_ALIASES[String(m || '').trim().toLowerCase()];
    if (!canonical) {
      const err = new Error(`不支持的修饰键：${m}`);
      err.code = 'desktop_hotkey_invalid';
      throw err;
    }
    mods.add(canonical);
  }
  let keyToken = tokens[tokens.length - 1];
  for (let i = 0; i < tokens.length - 1; i += 1) {
    const canonical = WIN32_MODIFIER_ALIASES[tokens[i].toLowerCase()];
    if (!canonical) {
      const err = new Error(`不支持的修饰键：${tokens[i]}`);
      err.code = 'desktop_hotkey_invalid';
      throw err;
    }
    mods.add(canonical);
  }

  const keyAliases = {
    enter: 'return',
    esc: 'escape',
    backspace: 'delete',
    del: 'forwarddelete',
  };

  const lowerKey = String(keyToken || '').trim().toLowerCase();
  const canonicalKey = keyAliases[lowerKey] || lowerKey;
  let keyVk = WIN32_VK_CODES[canonicalKey] ?? WIN32_VK_CODES[lowerKey];
  if (keyVk == null) {
    if (lowerKey.length === 1 && /^[a-z0-9]$/.test(lowerKey)) {
      keyVk = lowerKey.toUpperCase().charCodeAt(0);
    } else {
      const err = new Error(`不支持的快捷键按键：${keyToken}`);
      err.code = 'desktop_hotkey_invalid';
      throw err;
    }
  }

  const sortedMods = [...mods].sort();
  for (const blocked of WIN32_BLOCKED_HOTKEYS) {
    const bMods = [...blocked.modifiers].sort();
    if (blocked.key === canonicalKey && bMods.length === sortedMods.length && bMods.every((v, i) => v === sortedMods[i])) {
      const err = new Error(blocked.reason);
      err.code = 'desktop_hotkey_blocked';
      throw err;
    }
  }

  return {
    key: canonicalKey,
    keyVk,
    modifiers: sortedMods,
    modifierVks: sortedMods.map((m) => WIN32_MODIFIER_VK[m]),
    chord: [...sortedMods, canonicalKey].join('+'),
  };
}

function clampText(value, maxChars) {
  const text = String(value || '');
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 1))}…`;
}


function matchesAppRow(row, target) {
  if (!row || !target) return false;
  const wantBundle = String(target.bundleId || '').trim().toLowerCase();
  const wantPath = String(target.path || '').trim().toLowerCase();
  const wantName = String(target.name || '').trim().toLowerCase();
  const rowExe = String(row.exeName || '').trim().toLowerCase();
  const rowProc = String(row.processName || '').trim().toLowerCase();
  const rowDisp = String(row.displayName || '').trim().toLowerCase();
  const rowPath = String(row.path || '').trim().toLowerCase();

  if (wantPath && !wantPath.startsWith('shell:')) return rowPath === wantPath;
  if (wantBundle && rowExe && !wantBundle.includes('!')) return rowExe === wantBundle || rowProc === wantBundle || rowExe === `${wantBundle}.exe`;
  if (wantName && (rowDisp === wantName || rowProc === wantName || rowExe === wantName || rowExe === `${wantName}.exe`)) return true;
  return false;
}

function centerOfBounds(bounds) {
  if (!bounds || typeof bounds !== 'object') return null;
  const x = Number(bounds.x);
  const y = Number(bounds.y);
  const w = Number(bounds.width);
  const h = Number(bounds.height);
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) {
    return null;
  }
  return { x: Math.round(x + w / 2), y: Math.round(y + h / 2) };
}

function pointInBounds(point, bounds, margin = 4) {
  if (!point || !bounds) return false;
  return point.x >= bounds.x - margin
    && point.y >= bounds.y - margin
    && point.x <= bounds.x + bounds.width + margin
    && point.y <= bounds.y + bounds.height + margin;
}

async function listInstalledAppMappings(options = {}, deps = {}) {
  if (win32MappingsCache && !options.refresh && !deps.win32Bridge) {
    return win32MappingsCache;
  }
  const bridge = getBridge(deps);
  const rows = await bridge.request('installed_mappings', {}, 15000);
  const normalized = (Array.isArray(rows) ? rows : []).map((item) => ({
    name: String(item.name || '').trim(),
    displayName: String(item.displayName || item.name || '').trim(),
    bundleId: String(item.bundleId || item.executableName || '').trim(),
    executableName: String(item.executableName || item.name || '').trim(),
    path: String(item.path || '').trim(),
  })).filter((item) => item.name || item.bundleId || item.path);
  normalized.sort((a, b) => a.displayName.localeCompare(b.displayName, 'zh-Hans'));
  if (!deps.win32Bridge) win32MappingsCache = normalized;
  return normalized;
}

async function listRunningApps(deps = {}) {
  if (typeof deps.listRunningApps === 'function') return deps.listRunningApps();
  const bridge = getBridge(deps);
  const windows = await bridge.request('list_windows', {}, 10000);
  const seen = new Set();
  const apps = [];
  for (const w of (Array.isArray(windows) ? windows : [])) {
    const exeName = String(w.exeName || '').trim();
    const displayName = String(w.displayName || w.processName || exeName).trim();
    const appPath = String(w.path || '').trim();
    const bundleId = exeName.toLowerCase();
    const key = `${bundleId}::${appPath.toLowerCase()}`;
    if (!displayName || seen.has(key)) continue;
    seen.add(key);
    apps.push({
      name: displayName,
      bundleId,
      path: appPath,
      elevated: Boolean(w.elevated),
    });
  }
  apps.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans'));
  return apps;
}

async function listWindowsForApps(appTargets = [], deps = {}) {
  const targets = (Array.isArray(appTargets) ? appTargets : []).filter(Boolean);
  if (!targets.length) return [];
  if (typeof deps.listWindows === 'function') {
    const out = [];
    for (const t of targets) {
      const rows = await deps.listWindows(t);
      if (Array.isArray(rows)) out.push(...rows);
    }
    return out;
  }
  const bridge = getBridge(deps);
  const all = await bridge.request('list_windows', {}, 10000);
  const out = [];
  let idx = 0;
  for (const w of (Array.isArray(all) ? all : [])) {
    const matchedTarget = targets.find((t) => matchesAppRow(w, t));
    if (!matchedTarget) continue;
    idx += 1;
    out.push({
      id: String(w.windowId),
      windowId: Number(w.windowId),
      pid: Number(w.pid),
      title: String(w.title || ''),
      index: idx,
      appName: String(matchedTarget.name || w.displayName || w.processName || ''),
      bundleId: String(matchedTarget.bundleId || String(w.exeName || '').toLowerCase()),
      path: String(w.path || matchedTarget.path || ''),
      minimized: Boolean(w.minimized),
      visible: w.visible == null ? !w.minimized : Boolean(w.visible),
      elevated: Boolean(w.elevated),
      bounds: w.bounds || null,
    });
  }
  return out;
}

async function listWindowsForApp(appTarget, deps = {}) {
  return listWindowsForApps([appTarget], deps);
}

async function assertWindowOwnership(appTarget, windowId, deps = {}) {
  const id = Number(windowId);
  if (!id || Number.isNaN(id)) {
    const err = new Error('需要明确的 windowId。请先用 desktop_windows 获取窗口。');
    err.code = 'desktop_window_required';
    throw err;
  }
  const windows = await listWindowsForApp(appTarget, deps);
  const match = windows.find((row) => Number(row.windowId) === id);
  if (!match) {
    const err = new Error(`窗口 ${id} 不属于应用「${appTarget?.name || ''}」，或该窗口已关闭。请重新用 desktop_windows 获取 windowId。`);
    err.code = 'desktop_window_mismatch';
    throw err;
  }
  return match;
}

async function assertNotUipiBlocked(win, deps = {}) {
  if (!win || !win.elevated) return;
  const bridge = getBridge(deps);
  let selfElevated = false;
  try {
    const info = await bridge.request('ping', {}, 5000);
    selfElevated = Boolean(info?.elevated);
  } catch {
    selfElevated = false;
  }
  if (!selfElevated) {
    const err = new Error('目标窗口以管理员权限运行，受 Windows UIPI 保护，普通权限的 Pi Studio 无法操控它。');
    err.code = 'desktop_uipi_elevated';
    throw err;
  }
}

async function captureSnapshot(appTarget, options = {}, deps = {}) {
  if (typeof deps.captureSnapshot === 'function') return deps.captureSnapshot(appTarget, options);
  const maxNodes = Math.min(Math.max(Number(options.maxNodes) || DEFAULT_MAX_NODES, 10), 200);
  const maxChars = Math.min(Math.max(Number(options.maxChars) || DEFAULT_MAX_CHARS, 1000), 40000);
  let windowId = options.windowId != null ? Number(options.windowId) : null;
  if (windowId != null && !Number.isNaN(windowId)) {
    await assertWindowOwnership(appTarget, windowId, deps);
  } else {
    const wins = await listWindowsForApp(appTarget, deps);
    if (!wins.length) {
      return { appName: appTarget.name, bundleId: appTarget.bundleId || '', path: appTarget.path || '', windowId: null, title: '', nodes: [], truncated: false, nodeCount: 0 };
    }
    windowId = wins[0].windowId;
  }

  const bridge = getBridge(deps);
  const payload = await bridge.request('snapshot', { windowId, maxNodes }, 15000);
  const rawNodes = Array.isArray(payload?.nodes) ? payload.nodes : [];
  const limited = [];
  let used = 0;
  let truncated = Boolean(payload?.truncated);
  for (const node of rawNodes) {
    const next = {
      ref: String(node.ref || `n${limited.length + 1}`),
      role: clampText(node.role, 80),
      name: clampText(node.name, 240),
      value: node.secure ? '' : clampText(node.value, 240),
      description: clampText(node.description, 240),
      depth: Number(node.depth) || 0,
      path: clampText(node.path, 120),
      bounds: node.bounds || null,
      secure: Boolean(node.secure),
    };
    const cost = JSON.stringify(next).length + 1;
    if (used + cost > maxChars) { truncated = true; break; }
    limited.push(next);
    used += cost;
  }
  return {
    appName: String(appTarget?.name || ''),
    bundleId: String(appTarget?.bundleId || ''),
    path: String(appTarget?.path || ''),
    windowId,
    title: String(payload?.title || ''),
    nodes: limited,
    truncated,
    nodeCount: limited.length,
  };
}

function readPngDimensions(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 24) return null;
  if (buffer[0] !== 0x89 || buffer[1] !== 0x50 || buffer[2] !== 0x4e || buffer[3] !== 0x47) return null;
  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);
  if (!(width > 0) || !(height > 0)) return null;
  return { width, height };
}

async function captureScreenshot(appTarget, options = {}, deps = {}) {
  if (typeof deps.captureScreenshot === 'function') return deps.captureScreenshot(appTarget, options);
  const windowId = options.windowId != null ? Number(options.windowId) : NaN;
  const owned = await assertWindowOwnership(appTarget, windowId, deps);
  if (owned.minimized || owned.visible === false) {
    const err = new Error(`窗口 ${windowId} 当前不可见或已最小化，无法截图。`);
    err.code = 'desktop_window_not_visible';
    throw err;
  }
  const bridge = getBridge(deps);
  const maxEdge = Number(options.maxEdge) || DEFAULT_MAX_SCREENSHOT_EDGE;
  const shot = await bridge.request('screenshot', {
    windowId, pid: owned.pid, maxEdge, includePopups: options.includePopups !== false, popupWaitMs: options.popupWaitMs || 0,
  }, 12000);
  const data = String(shot?.data || '');
  const dims = data ? readPngDimensions(Buffer.from(data, 'base64')) : null;
  return {
    mimeType: 'image/png',
    data,
    windowId,
    appName: String(appTarget?.name || ''),
    bundleId: String(appTarget?.bundleId || ''),
    title: owned.title || '',
    bounds: shot?.bounds || owned.bounds || null,
    imageWidth: dims ? dims.width : null,
    imageHeight: dims ? dims.height : null,
    bytes: Number(shot?.bytes) || 0,
    scaled: Boolean(shot?.scaled),
    captureMode: 'print_window',
    panels: shot?.panels || [],
    overlayCount: shot?.panels?.length || 0,
  };
}

async function resolveTargetPoint(appTarget, options, deps, owned) {
  const ref = String(options.ref || '').trim();
  const nodePath = String(options.path || '').trim();
  if (ref || nodePath) {
    let node = null;
    if (typeof deps.resolveNode === 'function') {
      node = await deps.resolveNode(appTarget, { windowId: owned.windowId, ref, path: nodePath });
    } else {
      const snap = await captureSnapshot(appTarget, { windowId: owned.windowId, maxNodes: 200, maxChars: 40000 }, deps);
      node = snap.nodes.find((n) => (ref && n.ref === ref) || (nodePath && n.path === nodePath)) || null;
    }
    if (!node) {
      const err = new Error('找不到指定控件。请重新 desktop_snapshot 后再试。');
      err.code = 'desktop_target_not_found';
      throw err;
    }
    if (node.secure) {
      const err = new Error('不会操作密码或安全输入控件。');
      err.code = 'desktop_secure_target';
      throw err;
    }
    const point = centerOfBounds(node.bounds);
    if (!point) {
      const err = new Error('目标控件没有可用位置。');
      err.code = 'desktop_target_no_bounds';
      throw err;
    }
    if (owned.bounds && !pointInBounds(point, owned.bounds, 8)) {
      const err = new Error('目标控件不在指定窗口范围内，已拒绝操作。');
      err.code = 'desktop_target_outside_window';
      throw err;
    }
    return { point, ref: node.ref || ref, path: node.path || nodePath, mode: 'ref' };
  }

  if (options.normX != null && options.normY != null) {
    const nx = Number(options.normX);
    const ny = Number(options.normY);
    if (!Number.isFinite(nx) || !Number.isFinite(ny) || nx < 0 || nx > 1000 || ny < 0 || ny > 1000) {
      throw Object.assign(new Error('归一化坐标 normX/normY 必须在 0–1000 之间。'), { code: 'desktop_invalid_point' });
    }
    if (!owned.bounds || !(owned.bounds.width > 0) || !(owned.bounds.height > 0)) {
      throw Object.assign(new Error('无法获取目标窗口尺寸。'), { code: 'desktop_window_bounds_missing' });
    }
    return {
      point: {
        x: Math.round(owned.bounds.x + (nx / 1000) * owned.bounds.width),
        y: Math.round(owned.bounds.y + (ny / 1000) * owned.bounds.height),
      },
      ref: '',
      path: '',
      mode: 'norm',
    };
  }

  if (options.rx != null && options.ry != null) {
    const rx = Number(options.rx);
    const ry = Number(options.ry);
    if (!Number.isFinite(rx) || !Number.isFinite(ry)) {
      throw Object.assign(new Error('窗口相对坐标 rx/ry 无效。'), { code: 'desktop_invalid_point' });
    }
    if (!owned.bounds || !(owned.bounds.width > 0) || !(owned.bounds.height > 0)) {
      throw Object.assign(new Error('无法获取目标窗口尺寸。'), { code: 'desktop_window_bounds_missing' });
    }
    const imgW = Number(options.imageWidth) || 0;
    const imgH = Number(options.imageHeight) || 0;
    const sx = imgW > 0 ? (rx / imgW) * owned.bounds.width : rx;
    const sy = imgH > 0 ? (ry / imgH) * owned.bounds.height : ry;
    const point = {
      x: Math.round(owned.bounds.x + sx),
      y: Math.round(owned.bounds.y + sy),
    };
    if (!pointInBounds(point, owned.bounds, 4)) {
      throw Object.assign(new Error('指定坐标超出目标窗口范围，已拒绝操作。'), { code: 'desktop_point_outside_window' });
    }
    return { point, ref: '', path: '', mode: imgW > 0 ? 'image' : 'relative' };
  }

  const x = Number(options.x);
  const y = Number(options.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    const err = new Error('请提供控件 ref/path、窗口内相对坐标 (rx, ry)/(normX, normY) 或屏幕坐标 (x, y)。');
    err.code = 'desktop_target_required';
    throw err;
  }
  const point = { x: Math.round(x), y: Math.round(y) };
  if (owned.bounds && !pointInBounds(point, owned.bounds, 4)) {
    const err = new Error('指定坐标超出目标窗口范围，已拒绝操作。');
    err.code = 'desktop_point_outside_window';
    throw err;
  }
  return { point, ref: '', path: '', mode: 'coords' };
}

async function click(appTarget, options = {}, deps = {}) {
  const owned = await assertWindowOwnership(appTarget, options.windowId, deps);
  if (owned.minimized || owned.visible === false) {
    throw Object.assign(new Error('目标窗口不可见或已最小化。'), { code: 'desktop_window_not_visible' });
  }
  await assertNotUipiBlocked(owned, deps);
  const popup = options.popupWindowId != null;
  if (popup && (!options.popupBounds || options.ref || options.path || options.elementPath)) {
    throw Object.assign(new Error('请从最近的弹窗截图选择坐标。'), { code: 'desktop_popup_changed' });
  }
  const target = await resolveTargetPoint(appTarget, options, deps, popup ? { ...owned, bounds: options.popupBounds } : owned);
  const button = String(options.button || 'left').toLowerCase() === 'right' ? 'right' : 'left';
  const clickCount = options.double === true ? 2 : Math.min(Math.max(Number(options.clickCount) || 1, 1), 3);
  if (typeof deps.click === 'function') {
    return deps.click(appTarget, { windowId: owned.windowId, x: target.point.x, y: target.point.y, button, clickCount, resolved: target });
  }
  const bridge = getBridge(deps);
  for (let i = 0; i < clickCount; i += 1) {
    await bridge.request('click', {
      windowId: owned.windowId, x: target.point.x, y: target.point.y, button,
      ...(popup ? { pid: owned.pid, popupWindowId: options.popupWindowId, popupBounds: options.popupBounds } : {}),
    }, 10000);
  }
  return {
    ok: true,
    appName: String(appTarget?.name || ''),
    bundleId: String(appTarget?.bundleId || ''),
    windowId: owned.windowId,
    title: owned.title || '',
    bounds: owned.bounds || null,
    x: target.point.x,
    y: target.point.y,
    button,
    clickCount,
    mode: target.mode,
    ref: target.ref,
  };
}

async function type(appTarget, options = {}, deps = {}) {
  const text = typeof options.text === 'string' ? options.text : '';
  if (!text) throw Object.assign(new Error('输入文本不能为空。'), { code: 'desktop_type_empty' });
  if (text.length > DEFAULT_MAX_TYPE_CHARS) throw Object.assign(new Error('输入文本过长。'), { code: 'desktop_type_too_long' });
  const owned = await assertWindowOwnership(appTarget, options.windowId, deps);
  if (owned.minimized || owned.visible === false) {
    throw Object.assign(new Error('目标窗口不可见或已最小化。'), { code: 'desktop_window_not_visible' });
  }
  await assertNotUipiBlocked(owned, deps);

  let focusTarget = null;
  if (
    options.ref
    || options.path
    || options.elementPath
    || (options.x != null && options.y != null)
    || (options.rx != null && options.ry != null)
    || (options.normX != null && options.normY != null)
  ) {
    focusTarget = await click(appTarget, {
      ...options,
      path: options.path || options.elementPath,
    }, deps);
  }

  const bridge = getBridge(deps);
  const focused = typeof deps.getFocusedNode === 'function'
    ? await deps.getFocusedNode(appTarget, { windowId: owned.windowId })
    : await bridge.request('focused', { windowId: owned.windowId }, 5000);
  if (focused && focused.secure) {
    throw Object.assign(new Error('不会向密码或安全输入框输入文本。'), { code: 'desktop_secure_target' });
  }

  if (typeof deps.type === 'function') {
    return deps.type(appTarget, { windowId: owned.windowId, text, clear: options.clear === true, submit: options.submit === true });
  }
  if (options.clear === true) {
    await bridge.request('hotkey', { windowId: owned.windowId, keyVk: 0x41, modifierVks: [WIN32_MODIFIER_VK.control] }, 5000);
    await bridge.request('hotkey', { windowId: owned.windowId, keyVk: WIN32_VK_CODES.backspace, modifierVks: [] }, 5000);
  }
  await bridge.request('type', { windowId: owned.windowId, text }, 12000);
  if (options.submit === true) {
    await bridge.request('hotkey', { windowId: owned.windowId, keyVk: WIN32_VK_CODES.enter, modifierVks: [] }, 5000);
  }
  return {
    ok: true,
    appName: String(appTarget?.name || ''),
    bundleId: String(appTarget?.bundleId || ''),
    windowId: owned.windowId,
    title: owned.title || '',
    bounds: owned.bounds || null,
    chars: text.length,
    length: text.length,
    submitted: options.submit === true,
    ref: focusTarget?.ref || '',
    path: options.path || options.elementPath || '',
    mode: focusTarget ? focusTarget.mode : 'focused',
  };
}

async function scroll(appTarget, options = {}, deps = {}) {
  const owned = await assertWindowOwnership(appTarget, options.windowId, deps);
  if (owned.minimized || owned.visible === false) {
    throw Object.assign(new Error('目标窗口不可见或已最小化。'), { code: 'desktop_window_not_visible' });
  }
  await assertNotUipiBlocked(owned, deps);
  const direction = String(options.direction || '').trim().toLowerCase();
  const amount = options.amount != null ? Number(options.amount) : DEFAULT_SCROLL_AMOUNT;
  if (!Number.isFinite(amount) || amount <= 0 || amount > MAX_SCROLL_AMOUNT) {
    throw Object.assign(new Error(`滚动步长需在 1–${MAX_SCROLL_AMOUNT} 之间。`), { code: 'desktop_scroll_invalid' });
  }
  let dx = Number(options.dx != null ? options.dx : options.deltaX) || 0;
  let dy = Number(options.dy != null ? options.dy : options.deltaY) || 0;
  const effectiveDirection = direction || (dx === 0 && dy === 0 ? 'down' : '');
  if (effectiveDirection === 'down') dy = -Math.abs(amount);
  else if (effectiveDirection === 'up') dy = Math.abs(amount);
  else if (effectiveDirection === 'right') dx = Math.abs(amount);
  else if (effectiveDirection === 'left') dx = -Math.abs(amount);
  if (dx === 0 && dy === 0) {
    throw Object.assign(new Error('请提供滚动方向（up/down/left/right）或偏移量。'), { code: 'desktop_scroll_invalid' });
  }
  const hasExplicitTarget = Boolean(options.ref || options.path || options.elementPath || (options.x != null && options.y != null));
  const resolved = hasExplicitTarget
    ? await resolveTargetPoint(appTarget, { ...options, path: options.path || options.elementPath }, deps, owned)
    : null;
  const point = resolved ? resolved.point : (centerOfBounds(owned.bounds) || { x: 0, y: 0 });
  if (typeof deps.scroll === 'function') {
    return deps.scroll(appTarget, { windowId: owned.windowId, x: point.x, y: point.y, dx, dy });
  }
  const bridge = getBridge(deps);
  await bridge.request('scroll', { windowId: owned.windowId, x: point.x, y: point.y, dx, dy }, 10000);
  return {
    ok: true,
    appName: String(appTarget?.name || ''),
    bundleId: String(appTarget?.bundleId || ''),
    windowId: owned.windowId,
    title: owned.title || '',
    x: point.x,
    y: point.y,
    direction: effectiveDirection || (dy < 0 ? 'down' : dy > 0 ? 'up' : dx > 0 ? 'right' : 'left'),
    amount: Math.max(Math.abs(dx), Math.abs(dy)),
    deltaX: dx,
    deltaY: dy,
    ref: resolved?.ref || '',
  };
}

async function drag(appTarget, options = {}, deps = {}) {
  const owned = await assertWindowOwnership(appTarget, options.windowId, deps);
  if (owned.minimized || owned.visible === false) {
    throw Object.assign(new Error('目标窗口不可见或已最小化。'), { code: 'desktop_window_not_visible' });
  }
  await assertNotUipiBlocked(owned, deps);
  const start = await resolveTargetPoint(appTarget, {
    ref: options.fromRef || options.ref,
    path: options.fromPath || options.path || options.elementPath,
    x: options.fromX != null ? options.fromX : options.x,
    y: options.fromY != null ? options.fromY : options.y,
  }, deps, owned);
  const end = await resolveTargetPoint(appTarget, {
    ref: options.toRef,
    path: options.toPath || options.toElementPath,
    x: options.toX,
    y: options.toY,
  }, deps, owned);
  const dist = Math.hypot(end.point.x - start.point.x, end.point.y - start.point.y);
  if (dist < 4) throw Object.assign(new Error('拖拽距离过短。'), { code: 'desktop_drag_too_short' });
  if (dist > MAX_DRAG_DISTANCE) throw Object.assign(new Error('拖拽距离超出上限。'), { code: 'desktop_drag_invalid' });
  const steps = Math.min(Math.max(Number(options.steps) || DEFAULT_DRAG_STEPS, 1), MAX_DRAG_STEPS);
  if (typeof deps.drag === 'function') {
    return deps.drag(appTarget, { windowId: owned.windowId, fromX: start.point.x, fromY: start.point.y, toX: end.point.x, toY: end.point.y, steps });
  }
  const bridge = getBridge(deps);
  await bridge.request('drag', {
    windowId: owned.windowId,
    x1: start.point.x,
    y1: start.point.y,
    x2: end.point.x,
    y2: end.point.y,
    steps,
  }, 15000);
  return {
    ok: true,
    appName: String(appTarget?.name || ''),
    bundleId: String(appTarget?.bundleId || ''),
    windowId: owned.windowId,
    title: owned.title || '',
    fromX: start.point.x,
    fromY: start.point.y,
    toX: end.point.x,
    toY: end.point.y,
    dx: end.point.x - start.point.x,
    dy: end.point.y - start.point.y,
    fromRef: start.ref || '',
    toRef: end.ref || '',
    steps,
  };
}

async function hotkey(appTarget, options = {}, deps = {}) {
  const owned = await assertWindowOwnership(appTarget, options.windowId, deps);
  if (owned.minimized || owned.visible === false) {
    throw Object.assign(new Error('目标窗口不可见或已最小化。'), { code: 'desktop_window_not_visible' });
  }
  await assertNotUipiBlocked(owned, deps);
  const parsed = normalizeWin32Hotkey(options);
  if (typeof deps.hotkey === 'function') {
    return deps.hotkey(appTarget, { windowId: owned.windowId, ...parsed });
  }
  const bridge = getBridge(deps);
  await bridge.request('hotkey', {
    windowId: owned.windowId,
    keyVk: parsed.keyVk,
    modifierVks: parsed.modifierVks,
  }, 10000);
  return {
    ok: true,
    appName: String(appTarget?.name || ''),
    bundleId: String(appTarget?.bundleId || ''),
    windowId: owned.windowId,
    title: owned.title || '',
    key: parsed.key,
    modifiers: parsed.modifiers,
    chord: parsed.chord,
  };
}

async function launchApp(target, deps = {}) {
  if (typeof deps.launchApp === 'function') return deps.launchApp(target);
  const bridge = getBridge(deps);
  return bridge.request('launch', {
    name: String(target?.name || ''),
    bundleId: String(target?.bundleId || ''),
    path: String(target?.path || ''),
  }, 10000);
}

async function getPermissionStatus(deps = {}) {
  let elevated = false;
  let available = true;
  let errorDetail = '';
  try {
    const bridge = getBridge(deps);
    if (deps.win32Bridge || process.platform === 'win32') {
      const info = await bridge.request('ping', {}, 8000);
      elevated = Boolean(info?.elevated);
    }
  } catch (cause) {
    available = false;
    errorDetail = cause && cause.message ? String(cause.message) : String(cause);
  }
  return {
    platform: 'win32',
    supported: true,
    screenRecording: available ? 'granted' : 'unknown',
    accessibility: available,
    ready: available,
    elevated,
    message: available
      ? (elevated
        ? 'Windows 电脑操控已就绪（当前以管理员权限运行）。'
        : 'Windows 原生支持 UI Automation 与单窗口捕获，无需额外系统授权（受 UIPI 保护，不会操控以管理员身份运行的窗口）。')
      : `无法启动 Windows 电脑操控辅助进程：${errorDetail}`,
    helper: {
      name: 'Windows UIA & Win32 Helper',
      bundleId: 'win32.uia',
      path: HELPER_SCRIPT,
      available,
      ...(available ? {} : { code: 'desktop_helper_unavailable', error: errorDetail }),
    },
  };
}

function getCachedAppMappings() {
  return Array.isArray(win32MappingsCache) ? win32MappingsCache : [];
}

function stopHelper() {
  return defaultWin32Helper.stop();
}

module.exports = {
  platform: 'win32',
  HELPER_SCRIPT,
  WIN32_VK_CODES,
  WIN32_MODIFIER_VK,
  WIN32_BLOCKED_HOTKEYS,
  createWin32HelperClient,
  resolveRunnableScriptPath,
  normalizeWin32Hotkey,
  getCachedAppMappings,
  listInstalledAppMappings,
  listRunningApps,
  listWindowsForApp,
  listWindowsForApps,
  assertWindowOwnership,
  captureSnapshot,
  captureScreenshot,
  click,
  type,
  scroll,
  drag,
  hotkey,
  launchApp,
  getPermissionStatus,
  stopHelper,
};
