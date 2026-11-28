/**
 * Floating "Computer Use active" visual badge overlay anchored to the target
 * window's top-left corner (macOS traffic-light area / Windows titlebar edge).
 *
 * Uses a frameless, transparent, click-through, non-focusable Electron
 * BrowserWindow so it works identically on macOS and Windows without ever
 * stealing focus or appearing in single-window captures (`screencapture -l` /
 * `PrintWindow`). Gracefully no-ops in headless/unit-test environments.
 */
const { app, BrowserWindow } = require('electron');
const { getWindow } = require('../../core/state.cjs');

const BADGE_WIDTH = 74;
const BADGE_HEIGHT = 30;
const AUTO_HIDE_MS = 4500;

const BADGE_HTML = `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html, body {
    width: 100%;
    height: 100%;
    overflow: hidden;
    background: transparent;
    -webkit-user-select: none;
    user-select: none;
    pointer-events: none;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .pill {
    width: 62px;
    height: 22px;
    border-radius: 11px;
    background: linear-gradient(135deg, #7c8cf8 0%, #5b67f1 55%, #4f46e5 100%);
    box-shadow: 0 2px 10px rgba(79, 70, 229, 0.45), inset 0 0.5px 0 rgba(255, 255, 255, 0.42);
    border: 0.5px solid rgba(255, 255, 255, 0.28);
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 4px;
    animation: cu-pulse 2.2s ease-in-out infinite;
  }
  .pill svg {
    width: 14px;
    height: 14px;
    stroke: #ffffff;
    fill: none;
    stroke-width: 1.9;
    stroke-linecap: round;
    stroke-linejoin: round;
    filter: drop-shadow(0 1px 2px rgba(15, 23, 42, 0.25));
  }
  .dot {
    width: 4px;
    height: 4px;
    border-radius: 50%;
    background: rgba(255, 255, 255, 0.92);
    animation: cu-dot 1.4s ease-in-out infinite;
  }
  @keyframes cu-pulse {
    0%, 100% { box-shadow: 0 2px 10px rgba(79, 70, 229, 0.42), inset 0 0.5px 0 rgba(255, 255, 255, 0.42); }
    50% { box-shadow: 0 2px 15px rgba(99, 102, 241, 0.68), inset 0 0.5px 0 rgba(255, 255, 255, 0.52); }
  }
  @keyframes cu-dot {
    0%, 100% { opacity: 0.45; transform: scale(0.85); }
    50% { opacity: 1; transform: scale(1.1); }
  }
</style>
</head>
<body>
  <div class="pill" aria-hidden="true">
    <svg viewBox="0 0 24 24">
      <rect x="2.5" y="3.5" width="19" height="13.5" rx="2.5" />
      <path d="M8.5 20.5h7M12 17v3.5" />
      <path d="M11 8.5l2.2 4.8 1-2 2-.9z" fill="#ffffff" stroke="none" />
    </svg>
    <span class="dot"></span>
  </div>
</body>
</html>`;

let overlayWin = null;
let hideTimer = null;
let readyLoaded = false;
let currentBadgeRect = null;
let boundMainWin = null;

function rectsOverlap(a, b) {
  if (!a || !b) return false;
  return a.x < (b.x + b.width)
    && (a.x + a.width) > b.x
    && a.y < (b.y + b.height)
    && (a.y + a.height) > b.y;
}

function isOccludedByMainWindow(rect) {
  try {
    const mainWin = typeof getWindow === 'function' ? getWindow() : null;
    if (!mainWin || mainWin.isDestroyed() || !mainWin.isVisible()) return false;
    // Only treat Pi Studio as covering the target corner when Pi Studio itself is focused
    // and its window bounds actually intersect the badge location (dual-monitor safe!).
    if (!mainWin.isFocused()) return false;
    return rectsOverlap(rect, mainWin.getBounds());
  } catch {
    return false;
  }
}

function attachMainWindowGuard() {
  try {
    const mainWin = typeof getWindow === 'function' ? getWindow() : null;
    if (!mainWin || mainWin.isDestroyed() || boundMainWin === mainWin) return;
    boundMainWin = mainWin;
    const onFocusOrMove = () => {
      if (currentBadgeRect && isOccludedByMainWindow(currentBadgeRect)) {
        hideWindowControlBadge();
      }
    };
    mainWin.on('focus', onFocusOrMove);
    mainWin.on('move', onFocusOrMove);
    mainWin.on('closed', () => {
      if (boundMainWin === mainWin) boundMainWin = null;
    });
  } catch {
    /* ignore in headless tests */
  }
}

function canRenderOverlay() {
  try {
    return Boolean(BrowserWindow && typeof BrowserWindow === 'function' && app && typeof app.isReady === 'function' && app.isReady());
  } catch {
    return false;
  }
}

function computeBadgeRect(bounds, platform = process.platform) {
  if (!bounds || typeof bounds !== 'object') return null;
  const x = Number(bounds.x);
  const y = Number(bounds.y);
  const width = Number(bounds.width);
  const height = Number(bounds.height);
  if (!Number.isFinite(x) || !Number.isFinite(y) || !(width > 80) || !(height > 40)) return null;
  // macOS traffic lights live at ~(x+12, y+10), width ~56px; center our 62px pill right over them.
  const offsetX = platform === 'win32' ? 8 : 6;
  const offsetY = platform === 'win32' ? 4 : 3;
  return {
    x: Math.round(x + offsetX),
    y: Math.round(y + offsetY),
    width: BADGE_WIDTH,
    height: BADGE_HEIGHT,
  };
}

function ensureOverlayWindow(platform = process.platform) {
  if (overlayWin && !overlayWin.isDestroyed()) return overlayWin;
  if (!canRenderOverlay()) return null;

  const win = new BrowserWindow({
    width: BADGE_WIDTH,
    height: BADGE_HEIGHT,
    frame: false,
    transparent: true,
    hasShadow: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    closable: false,
    focusable: false,
    skipTaskbar: true,
    show: false,
    ...(platform === 'darwin' ? { type: 'panel' } : {}),
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  try {
    win.setIgnoreMouseEvents(true, { forward: true });
    if (platform === 'darwin') {
      win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
      win.setAlwaysOnTop(true, 'floating');
    } else {
      win.setAlwaysOnTop(true, 'screen-saver');
    }
  } catch {
    /* best effort */
  }

  readyLoaded = false;
  const dataUrl = `data:text/html;charset=utf-8,${encodeURIComponent(BADGE_HTML)}`;
  win.loadURL(dataUrl).then(() => {
    readyLoaded = true;
  }).catch(() => { /* ignore */ });

  win.on('closed', () => {
    if (overlayWin === win) overlayWin = null;
    readyLoaded = false;
  });

  overlayWin = win;
  return win;
}

function showWindowControlBadge({ bounds, platform = process.platform, holdMs = AUTO_HIDE_MS } = {}) {
  const rect = computeBadgeRect(bounds, platform);
  if (!rect) return false;
  currentBadgeRect = rect;
  attachMainWindowGuard();
  if (isOccludedByMainWindow(rect)) {
    hideWindowControlBadge();
    return false;
  }
  const win = ensureOverlayWindow(platform);
  if (!win || win.isDestroyed()) return false;

  try {
    win.setBounds(rect, false);
    if (!win.isVisible()) {
      win.showInactive();
    }
    if (platform === 'darwin') {
      win.setAlwaysOnTop(true, 'floating');
    }
  } catch {
    return false;
  }

  if (hideTimer) clearTimeout(hideTimer);
  hideTimer = setTimeout(() => {
    hideWindowControlBadge();
  }, Math.max(1000, Math.min(Number(holdMs) || AUTO_HIDE_MS, 20000)));
  hideTimer.unref?.();
  return true;
}

function hideWindowControlBadge() {
  currentBadgeRect = null;
  if (hideTimer) {
    clearTimeout(hideTimer);
    hideTimer = null;
  }
  if (overlayWin && !overlayWin.isDestroyed()) {
    try {
      overlayWin.hide();
    } catch {
      /* ignore */
    }
  }
}

function destroyWindowControlBadge() {
  hideWindowControlBadge();
  if (overlayWin && !overlayWin.isDestroyed()) {
    try {
      overlayWin.destroy();
    } catch {
      /* ignore */
    }
  }
  overlayWin = null;
  readyLoaded = false;
}

module.exports = {
  BADGE_WIDTH,
  BADGE_HEIGHT,
  computeBadgeRect,
  showWindowControlBadge,
  hideWindowControlBadge,
  destroyWindowControlBadge,
  isOverlayLoaded: () => readyLoaded,
};
