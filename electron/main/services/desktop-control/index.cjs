/**
 * Public desktop-control service API for capabilities and IPC.
 * Supports macOS (`darwin`) and Windows (`win32`) through `./platform/`.
 */
const { installedAppMappings, applicationIcon } = require('../mac-apps.cjs');
const {
  getDesktopControlPreferences,
  setDesktopControlPreferences,
  addAlwaysAllowApp,
  removeAlwaysAllowApp,
  addSessionAllowApp,
  clearSessionAllowApps,
  decideDesktopAccess,
  assertDesktopEnabled,
  selfIdentity,
  isBlockedApp,
  normalizeAllowEntry,
} = require('./policy.cjs');
const {
  createKeyboardPermissionMonitor,
  getDesktopPermissionStatus,
  assertDesktopPermissions,
  openDesktopPermissionSettings,
} = require('./permissions.cjs');
const {
  listDesktopActivity,
  appendDesktopActivity,
  clearDesktopActivity,
} = require('./activity.cjs');
const {
  assertSupportedDesktopPlatform,
  win32Adapter,
} = require('./platform/index.cjs');
const { defaultHelperClient } = require('./helper-client.cjs');
const { createDesktopStageLifecycle } = require('./stage-lifecycle.cjs');
const { popupObservation, bindPopupClick, popupChanged } = require('./popup-observation.cjs');
const { defaultRunner } = require('./observe.cjs');
const { getWindow } = require('../../core/state.cjs');
const { getStudioDatabase } = require('../../core/studio-db.cjs');
const { requestPolicyConfirmation } = require('../confirmations.cjs');
const {
  showWindowControlBadge,
  hideWindowControlBadge,
  destroyWindowControlBadge,
} = require('./overlay.cjs');

/** Public tool names exposed by the desktop-control capability (for status/agent UX). */
const DESKTOP_CONTROL_TOOLS = Object.freeze([
  'desktop_status',
  'desktop_apps',
  'desktop_windows',
  'desktop_launch',
  'desktop_act',
  'desktop_snapshot',
  'desktop_screenshot',
  'desktop_click',
  'desktop_type',
  'desktop_scroll',
  'desktop_drag',
  'desktop_hotkey',
]);

const DESKTOP_CONTROL_ACTIONS = Object.freeze([
  'observe',
  'launch',
  'act',
  'click',
  'type',
  'scroll',
  'drag',
  'hotkey',
]);

const SEARCH_POPUP_WAIT_MS = 1200;

function recordActivity(input, db) {
  try {
    appendDesktopActivity(input, db);
  } catch {
    /* activity log must never break observation */
  }
}

function normalizeCursorForBounds(x, y, bounds, kind = 'click') {
  if (!Number.isFinite(Number(x)) || !Number.isFinite(Number(y)) || !bounds) return null;
  const w = Number(bounds.width) || 0;
  const h = Number(bounds.height) || 0;
  if (w <= 1 || h <= 1) return null;
  const nx = Math.round(((Number(x) - (Number(bounds.x) || 0)) / w) * 1000);
  const ny = Math.round(((Number(y) - (Number(bounds.y) || 0)) / h) * 1000);
  return {
    normX: Math.max(0, Math.min(1000, nx)),
    normY: Math.max(0, Math.min(1000, ny)),
    kind,
  };
}

function resolvePublicSessionId(rawId, db) {
  const id = String(rawId || '').trim();
  if (!id) return '';
  try {
    const row = getStudioDatabase(db).getConversation(id);
    if (row && row.publicId) return String(row.publicId);
  } catch {
    /* ignore when Studio DB is unavailable in isolated unit tests */
  }
  return id;
}

function previewPanels(shot) {
  return (shot?.panels || []).map(({ windowId, imageWidth, imageHeight, mimeType, data }) => ({
    windowId, imageWidth, imageHeight, imageDataUrl: `data:${mimeType};base64,${data}`,
  }));
}

function emitDesktopPreview(payload = {}) {
  try {
    const win = typeof getWindow === 'function' ? getWindow() : null;
    if (!win || win.isDestroyed() || !win.webContents || win.webContents.isDestroyed()) return;
    const dataUrl = payload.imageDataUrl || (payload.screenshot?.data
      ? `data:${payload.screenshot.mimeType || 'image/png'};base64,${payload.screenshot.data}`
      : undefined);
    const resolvedSessionId = resolvePublicSessionId(payload.sessionId, payload.db);
    win.webContents.send('pi:desktop-control-preview', {
      sessionId: resolvedSessionId,
      ...(payload.runId ? { runId: String(payload.runId) } : {}),
      appName: String(payload.appName || ''),
      bundleId: String(payload.bundleId || ''),
      windowId: Number(payload.windowId || 0),
      title: String(payload.title || ''),
      action: String(payload.action || '实时预览'),
      status: payload.status || 'active',
      ...(typeof payload.staged === 'boolean' ? { staged: payload.staged } : {}),
      ...(payload.errorMessage ? { errorMessage: String(payload.errorMessage) } : {}),
      ...(payload.overlayCount != null ? { overlayCount: Number(payload.overlayCount) } : {}),
      bounds: payload.bounds || null,
      cursor: payload.cursor || null,
      ...(dataUrl ? { imageDataUrl: dataUrl, panels: previewPanels(payload.screenshot) } : {}),
      ...(payload.imageWidth ? { imageWidth: Number(payload.imageWidth) } : {}),
      ...(payload.imageHeight ? { imageHeight: Number(payload.imageHeight) } : {}),
      updatedAt: Date.now(),
    });
  } catch {
    /* preview broadcasting must never interrupt desktop actions */
  }
}

function chooseWindow(windows, platform, disambiguate = platform === 'darwin') {
  if (!disambiguate) return windows.find(win => win.visible !== false && !win.minimized) || windows[0];
  const open = windows.filter(win => !win.minimized);
  const main = open.filter(win => win.main === true);
  if (main.length === 1) return main[0];
  const visible = open.filter(win => win.visible !== false);
  const candidates = visible.length ? visible : open;
  if (candidates.length <= 1) return candidates[0];
  // If one titled primary window clearly dominates small hidden/helper panels,
  // prefer it automatically instead of failing with ambiguity.
  const ranked = candidates
    .map((win) => {
      const w = Number(win?.bounds?.width || 0);
      const h = Number(win?.bounds?.height || 0);
      return { win, w, h, area: w * h, titled: Boolean(String(win?.title || '').trim()) };
    })
    .sort((a, b) => b.area - a.area);
  const top = ranked[0];
  const runnerUp = ranked[1];
  if (top && runnerUp && top.titled && top.w >= 600 && top.h >= 400 && runnerUp.area > 0 && top.area >= runnerUp.area * 2.5) {
    return top.win;
  }
  const ids = candidates.map(win => win.windowId).join(', ');
  const error = new Error(`此应用有多个候选窗口（${ids}）。请读取候选窗口，确认目标后指定 windowId。`);
  error.code = 'desktop_window_ambiguous';
  throw error;
}

const VIRTUAL_STAGE_FALLBACK_CODES = new Set([
  'virtual_stage_unavailable',
  'stage_window_not_accessible',
  'stage_move_failed',
]);

function isVirtualStageFallbackError(err) {
  return Boolean(err && VIRTUAL_STAGE_FALLBACK_CODES.has(String(err.code || '')));
}

function canUseVirtualStageActions(actions) {
  if (!Array.isArray(actions)) return false;
  return actions.every((item) => {
    if (!item || typeof item !== 'object') return false;
    const kind = String(item.type || item.action || '').trim().toLowerCase();
    if (kind === 'launch') return false;
    if (item.ref || item.elementPath || item.path || item.toRef || item.toElementPath || item.toPath) return false;
    return true;
  });
}

function createDesktopControlService(deps = {}) {
  const platform = deps.platform || process.platform;
  const helperClient = deps.helperClient || defaultHelperClient;
  const useHelperRunner = platform === 'darwin' && !deps.runner;
  const hasCustomActionInjectors = Boolean(
    deps.click || deps.type || deps.scroll || deps.drag || deps.hotkey,
  );
  const observeDeps = {
    runner: deps.runner || (useHelperRunner ? (cmd, args, opts) => helperClient.exec(cmd, args, opts) : undefined),
    localRunner: deps.localRunner || deps.runner || defaultRunner,
    captureWindow: deps.captureWindow || (useHelperRunner && typeof helperClient.captureWindow === 'function' ? (opts) => helperClient.captureWindow(opts) : undefined),
    stageWindow: deps.stageWindow || (useHelperRunner && typeof helperClient.stageWindow === 'function' ? (opts) => helperClient.stageWindow(opts) : undefined),
    stageRelease: deps.stageRelease || (useHelperRunner && typeof helperClient.stageRelease === 'function' ? (opts) => helperClient.stageRelease(opts) : undefined),
    stageAct: deps.stageAct || (useHelperRunner && !hasCustomActionInjectors && typeof helperClient.stageAct === 'function' ? (opts) => helperClient.stageAct(opts) : undefined),
    stageStatus: deps.stageStatus || (useHelperRunner && typeof helperClient.stageStatus === 'function' ? () => helperClient.stageStatus() : undefined),
    platform: deps.platform,
    win32Bridge: deps.win32Bridge,
    listRunningApps: deps.listRunningApps,
    listWindows: deps.listWindows,
    captureSnapshot: deps.captureSnapshot,
    captureScreenshot: deps.captureScreenshot,
    click: deps.click,
    resolveNode: deps.resolveNode,
    getWindowFrame: deps.getWindowFrame,
    type: deps.type,
    getFocusedNode: deps.getFocusedNode,
    scroll: deps.scroll,
    drag: deps.drag,
    hotkey: deps.hotkey,
    launchApp: deps.launchApp,
  };
  let badgeRunId;
  const lifecycle = createDesktopStageLifecycle({
    release: observeDeps.stageRelease,
    onClose(sessionId, runId) {
      if (badgeRunId === runId) {
        hideWindowControlBadge();
        badgeRunId = undefined;
      }
      emitDesktopPreview({ sessionId, runId, status: 'closed' });
    },
  });
  for (const method of ['stageAct', 'stageWindow']) {
    const native = observeDeps[method];
    if (native) observeDeps[method] = opts => lifecycle.stage(native, opts);
  }
  if (observeDeps.stageRelease) observeDeps.stageRelease = lifecycle.releaseExplicitly;
  function rememberModelScreenshot(target, windowId, shot) {
    const run = lifecycle.current();
    if (run && !run.closed) run.popupObservation = shot?.data ? popupObservation(target, windowId, shot) : undefined;
  }

  function stageCaptureResult(result, target, windowId, bounds) {
    const shot = result.screenshot;
    if (!shot?.data) {
      if (!result.screenshotError) return {};
      rememberModelScreenshot(target, windowId, null);
      return { screenshotError: result.screenshotError };
    }
    const screenshot = {
      appName: target.name || '', bundleId: target.bundleId || '', path: target.path || '', windowId,
      bounds: shot.bounds || bounds || null, mimeType: shot.mimeType || 'image/png', data: shot.data,
      bytes: Number(shot.bytes || 0), scaled: Boolean(shot.scaled), overlayCount: Number(shot.overlayCount || 0),
      panels: shot.panels || [], popupRegions: shot.popupRegions || [],
      accessibilityOptions: shot.accessibilityOptions || [],
      captureMode: shot.captureMode || 'sck_display_composite',
      imageWidth: Number(shot.imageWidth) || null, imageHeight: Number(shot.imageHeight) || null,
    };
    rememberModelScreenshot(target, windowId, screenshot);
    return { screenshot };
  }
  function publishPreview(payload) {
    const run = lifecycle.current();
    if (!run?.closed) emitDesktopPreview({ ...payload, runId: run?.id });
  }
  const permissionDeps = {
    keyboardMonitor: platform === 'darwin' ? createKeyboardPermissionMonitor() : null,
    helperClient,
    win32Bridge: deps.win32Bridge,
    shell: deps.shell,
    platform: deps.platform,
  };

  function getAdapter() {
    return assertSupportedDesktopPlatform(platform);
  }

  function runKeyboardAction(kind, target, options, actionDeps = observeDeps) {
    const monitor = permissionDeps.keyboardMonitor;
    if (!monitor) return getAdapter()[kind](target, options, actionDeps);
    const run = () => getAdapter()[kind](target, options, { ...actionDeps, assertKeyboardAllowed: monitor.assertAllowed });
    return monitor.run(run, canUseAccessibleField(kind, options));
  }

  function canUseAccessibleField(kind, item) {
    return platform === 'darwin' && kind === 'type' && item.submit !== true && Boolean(item.ref || item.elementPath);
  }

  function permissionStatus(options = {}) {
    const refresh = options?.refresh === true || options?.restartHelper === true;
    if (refresh && permissionDeps.keyboardMonitor) {
      // Pending actions from the old helper keep their own monitor.
      permissionDeps.keyboardMonitor = createKeyboardPermissionMonitor();
    }
    return getDesktopPermissionStatus({ ...permissionDeps, refresh });
  }

  function showControlBadge(bounds) {
    const run = lifecycle.current();
    if (!bounds || run?.closed) return;
    badgeRunId = run?.id;
    try {
      if (typeof deps.showOverlay === 'function') {
        deps.showOverlay({ bounds, platform });
      } else {
        showWindowControlBadge({ bounds, platform });
      }
    } catch {
      /* overlay must never break desktop actions */
    }
  }

  /**
   * Enforce app allowlist + hard-blocks. When an unblocked app is not yet
   * allowed and we are inside an interactive chat session, surface an inline
   * Codex-style Computer Use approval card (`始终允许` / `允许此对话` / `拒绝`)
   * instead of failing out to Settings.
   */
  async function ensureAppAllowed(target, { sessionId = '', db, actionLabel = '' } = {}) {
    const dbRef = db || deps.db;
    const prefs = preferences(dbRef);
    const verdict = decideDesktopAccess(target, { preferences: prefs, db: dbRef, sessionId });
    if (verdict.decision === 'allow') return verdict;
    if (verdict.decision === 'deny') {
      const error = new Error(verdict.reason);
      error.code = verdict.code;
      error.decision = verdict.decision;
      throw error;
    }

    const canPrompt = typeof deps.requestApproval === 'function'
      || (Boolean(sessionId) && Boolean(getWindow() && !getWindow().isDestroyed()));
    if (!canPrompt) {
      const error = new Error(verdict.reason);
      error.code = verdict.code;
      error.decision = verdict.decision;
      throw error;
    }

    const appLabel = String(target?.displayName || target?.name || target?.bundleId || '该应用').trim();
    const requester = typeof deps.requestApproval === 'function'
      ? deps.requestApproval
      : requestPolicyConfirmation;
    const response = await requester({
      sessionId: sessionId || 'desktop-control',
      tool: 'desktop_control_app',
      decision: 'ask',
      title: `允许使用 ${appLabel}？`,
      message: `Computer Use → ${appLabel}${target?.bundleId ? ` (${target.bundleId})` : ''}`,
      explanation: actionLabel || `允许智能体在当前对话中观察并操作「${appLabel}」的窗口。`,
      rememberScopes: ['session', 'always'],
      risk: {
        level: 'medium',
        title: '电脑操控应用授权',
      },
    });

    if (!response || !response.accepted) {
      const error = new Error(`用户拒绝了使用应用「${appLabel}」。`);
      error.code = 'desktop_approval_denied';
      error.decision = 'deny';
      throw error;
    }

    if (response.remember === 'always') {
      addAlwaysAllowApp(enrichAllowInput(target), dbRef);
    } else if (sessionId) {
      addSessionAllowApp(sessionId, target);
    }
    return {
      decision: 'allow',
      reason: response.remember === 'always' ? '用户已选择始终允许。' : '用户已允许此对话使用该应用。',
      code: 'desktop_allowed',
    };
  }

  function preferences(db) {
    return getDesktopControlPreferences(db || deps.db);
  }

  async function status(db) {
    const prefs = preferences(db);
    const permission = await getDesktopPermissionStatus(permissionDeps);
    const alwaysAllow = (prefs.alwaysAllow || []).map((entry) => {
      let icon;
      try {
        if (entry.path) {
          if (typeof deps.applicationIcon === 'function') {
            icon = deps.applicationIcon(entry.path);
          } else if (platform === 'darwin') {
            icon = applicationIcon(entry.path);
          }
        }
      } catch {
        icon = undefined;
      }
      return icon ? { ...entry, icon } : { ...entry };
    });
    return {
      enabled: prefs.enabled,
      allowAnyApp: prefs.allowAnyApp,
      alwaysAllowCount: alwaysAllow.length,
      alwaysAllow,
      permission,
      self: selfIdentity(),
      platform: permission.platform,
      supported: permission.supported,
      ready: prefs.enabled && permission.ready,
      actions: DESKTOP_CONTROL_ACTIONS.slice(),
      tools: DESKTOP_CONTROL_TOOLS.slice(),
      activity: listDesktopActivity(30, db || deps.db),
    };
  }

  async function readStaticMappings(options = {}) {
    const adapter = getAdapter();
    const raw = typeof deps.listInstalledApps === 'function'
      ? await deps.listInstalledApps(options)
      : await adapter.listInstalledAppMappings({ refresh: options.refresh === true }, observeDeps);
    return (Array.isArray(raw) ? raw : []).map((app) => ({
      name: String(app.name || '').trim(),
      displayName: String(app.displayName || app.name || '').trim(),
      bundleId: String(app.bundleId || '').trim(),
      executableName: String(app.executableName || app.name || '').trim(),
      path: String(app.path || '').trim(),
    })).filter((app) => app.name || app.bundleId || app.path);
  }

  async function listAppMappings(options = {}, db) {
    getAdapter();
    const prefs = preferences(db);
    const items = await readStaticMappings(options);
    return items.map((app) => {
      const entry = normalizeAllowEntry({
        name: app.displayName || app.name,
        path: app.path,
        bundleId: app.bundleId,
      });
      const verdict = decideDesktopAccess({
        name: app.displayName || app.name,
        bundleId: app.bundleId,
        path: app.path,
      }, { preferences: prefs, db: db || deps.db });
      return {
        id: entry?.id || `path:${app.path || app.name}`,
        name: app.name,
        displayName: app.displayName || app.name,
        bundleId: app.bundleId,
        executableName: app.executableName || app.name,
        path: app.path,
        blocked: verdict.code === 'desktop_blocked' || isBlockedApp(app),
        allowed: verdict.decision === 'allow',
        decision: verdict.decision,
      };
    });
  }

  function enrichAllowInput(input) {
    if (!input || typeof input !== 'object') return input;
    if (input.bundleId) return input;
    try {
      let mappings = [];
      if (platform === 'darwin') {
        mappings = installedAppMappings();
      } else if (platform === 'win32') {
        mappings = win32Adapter.getCachedAppMappings();
      }
      const wantPath = String(input.path || '').trim().toLowerCase();
      const wantName = String(input.name || '').trim().toLowerCase();
      const hit = mappings.find((m) => (
        (wantPath && String(m.path || '').toLowerCase() === wantPath)
        || (wantName && (
          String(m.displayName || '').toLowerCase() === wantName
          || String(m.name || '').toLowerCase() === wantName
        ))
      ));
      if (hit) {
        return {
          ...input,
          name: input.name || hit.displayName || hit.name,
          bundleId: hit.bundleId || '',
          path: input.path || hit.path,
        };
      }
    } catch {
      /* ignore enrichment failure */
    }
    return input;
  }

  async function listInstalledApps(options = {}) {
    const adapter = getAdapter();
    try {
      const apps = await readStaticMappings(options);
      let running = [];
      try {
        running = await adapter.listRunningApps(observeDeps);
      } catch {
        running = [];
      }
      const runningKeys = new Set();
      for (const app of running) {
        const bundle = String(app.bundleId || '').toLowerCase();
        const name = String(app.name || '').toLowerCase();
        const appPath = String(app.path || '').toLowerCase();
        if (bundle) runningKeys.add(`bundle:${bundle}`);
        if (name) runningKeys.add(`name:${name}`);
        if (appPath) runningKeys.add(`path:${appPath}`);
      }

      const mapped = apps.map((app) => {
        const displayName = app.displayName || app.name;
        const entry = normalizeAllowEntry({
          name: displayName,
          path: app.path,
          bundleId: app.bundleId || '',
        });
        let icon;
        try {
          if (typeof deps.applicationIcon === 'function') {
            icon = deps.applicationIcon(app.path);
          } else if (platform === 'darwin' && app.path) {
            icon = applicationIcon(app.path);
          }
        } catch {
          icon = undefined;
        }
        const bundle = String(entry?.bundleId || '').toLowerCase();
        const name = String(displayName || '').toLowerCase();
        const englishName = String(app.name || '').toLowerCase();
        const appPath = String(entry?.path || '').toLowerCase();
        const runningNow = Boolean(
          (bundle && runningKeys.has(`bundle:${bundle}`))
          || (appPath && runningKeys.has(`path:${appPath}`))
          || (!bundle && name && runningKeys.has(`name:${name}`))
          || (!bundle && englishName && runningKeys.has(`name:${englishName}`)),
        );
        return {
          ...entry,
          displayName,
          englishName: app.name,
          executableName: app.executableName || app.name,
          blocked: isBlockedApp(entry) || isBlockedApp({ name: app.name, bundleId: app.bundleId, path: app.path }),
          icon: icon || undefined,
          running: runningNow,
        };
      }).filter(Boolean);

      mapped.sort((a, b) => {
        if (Boolean(a.running) !== Boolean(b.running)) return a.running ? -1 : 1;
        return String(a.displayName || a.name || '').localeCompare(String(b.displayName || b.name || ''), 'zh-Hans');
      });
      return mapped;
    } catch (cause) {
      if (cause && cause.code) throw cause;
      const error = new Error(`无法读取本机应用列表：${cause && cause.message ? cause.message : cause}`);
      error.code = 'desktop_list_installed_failed';
      error.cause = cause;
      throw error;
    }
  }

  async function listApps(db) {
    assertDesktopEnabled({ db: db || deps.db, preferences: preferences(db) });
    const adapter = getAdapter();
    // Running-app inventory uses NSWorkspace (macOS) / EnumWindows (Windows) without Accessibility.
    const prefs = preferences(db);
    try {
      const running = await adapter.listRunningApps(observeDeps);
      const rows = running.map((app) => {
        const verdict = decideDesktopAccess(app, { preferences: prefs, db: db || deps.db });
        return {
          name: app.name,
          bundleId: app.bundleId || '',
          path: app.path || '',
          allowed: verdict.decision === 'allow',
          decision: verdict.decision,
          needsApproval: verdict.decision === 'needs_approval',
          blocked: verdict.code === 'desktop_blocked',
          reason: verdict.reason,
          code: verdict.code,
          running: true,
        };
      });
      recordActivity({
        tool: 'desktop_apps',
        ok: true,
        detail: `${rows.length} apps`,
      }, db || deps.db);
      return rows;
    } catch (cause) {
      recordActivity({
        tool: 'desktop_apps',
        ok: false,
        code: cause && cause.code ? cause.code : 'desktop_list_apps_failed',
        detail: cause && cause.message ? String(cause.message) : String(cause),
      }, db || deps.db);
      throw cause;
    }
  }

  async function listWindows(query = {}, db) {
    assertDesktopEnabled({ db: db || deps.db, preferences: preferences(db) });
    await assertDesktopPermissions('windows', permissionDeps);
    const adapter = getAdapter();
    const prefs = preferences(db);
    try {
      const running = await adapter.listRunningApps(observeDeps);
      const wantedName = String(query.appName || query.name || '').trim().toLowerCase();
      const wantedBundle = String(query.bundleId || '').trim().toLowerCase();

      const targets = running.filter((app) => {
        if (wantedBundle && String(app.bundleId || '').toLowerCase() === wantedBundle) return true;
        if (wantedName && String(app.name || '').toLowerCase() === wantedName) return true;
        if (!wantedName && !wantedBundle) return true;
        return false;
      });

      const windows = [];
      const skipped = [];
      const allowedTargets = [];
      for (const app of targets) {
        const verdict = decideDesktopAccess(app, { preferences: prefs, db: db || deps.db, sessionId: query.sessionId });
        if (verdict.decision !== 'allow') {
          skipped.push({
            name: app.name,
            bundleId: app.bundleId || '',
            decision: verdict.decision,
            needsApproval: verdict.decision === 'needs_approval',
            reason: verdict.reason,
            code: verdict.code,
          });
          continue;
        }
        allowedTargets.push(app);
      }
      const listed = await adapter.listWindowsForApps(allowedTargets, observeDeps);
      for (const win of listed) windows.push(win);
      recordActivity({
        tool: 'desktop_windows',
        ok: true,
        appName: query.appName || '',
        bundleId: query.bundleId || '',
        detail: `${windows.length} windows / ${skipped.length} skipped`,
      }, db || deps.db);
      return { windows, skipped };
    } catch (cause) {
      recordActivity({
        tool: 'desktop_windows',
        ok: false,
        appName: query.appName || '',
        bundleId: query.bundleId || '',
        code: cause && cause.code ? cause.code : 'desktop_list_windows_failed',
        detail: cause && cause.message ? String(cause.message) : String(cause),
      }, db || deps.db);
      throw cause;
    }
  }

  function resolveAppTarget(query = {}, running = []) {
    const wantedName = String(query.appName || query.name || '').trim();
    const wantedBundle = String(query.bundleId || '').trim();
    const wantedPath = String(query.path || '').trim();
    if (!wantedName && !wantedBundle && !wantedPath) {
      const error = new Error('请提供 appName、bundleId 或 path。');
      error.code = 'desktop_invalid_app';
      throw error;
    }
    const match = running.find((app) => {
      if (wantedBundle && String(app.bundleId || '').toLowerCase() === wantedBundle.toLowerCase()) return true;
      if (wantedPath && String(app.path || '').toLowerCase() === wantedPath.toLowerCase()) return true;
      if (wantedName && String(app.name || '').toLowerCase() === wantedName.toLowerCase()) return true;
      return false;
    });
    return match || {
      name: wantedName || wantedBundle || wantedPath,
      bundleId: wantedBundle,
      path: wantedPath,
    };
  }

  async function snapshot(query = {}, db) {
    assertDesktopEnabled({ db: db || deps.db, preferences: preferences(db) });
    await assertDesktopPermissions('snapshot', permissionDeps);
    const adapter = getAdapter();
    try {
      const running = await adapter.listRunningApps(observeDeps);
      const target = resolveAppTarget(query, running);
      await ensureAppAllowed(target, { sessionId: query.sessionId, db, actionLabel: '读取该应用窗口的无障碍结构。' });
      if (query.windowId != null) {
        await adapter.assertWindowOwnership(target, query.windowId, observeDeps);
      }
      const result = await adapter.captureSnapshot(target, {
        windowId: query.windowId,
        maxNodes: query.maxNodes,
        maxChars: query.maxChars,
      }, { ...observeDeps, sessionId: query.sessionId });
      recordActivity({
        tool: 'desktop_snapshot',
        ok: true,
        appName: result.appName || target.name || '',
        bundleId: result.bundleId || target.bundleId || '',
        windowId: result.windowId,
        title: result.title || '',
        detail: `${result.nodeCount || 0} nodes`,
      }, db || deps.db);
      return result;
    } catch (cause) {
      recordActivity({
        tool: 'desktop_snapshot',
        ok: false,
        appName: query.appName || '',
        bundleId: query.bundleId || '',
        windowId: query.windowId,
        code: cause && cause.code ? cause.code : 'desktop_snapshot_failed',
        detail: cause && cause.message ? String(cause.message) : String(cause),
      }, db || deps.db);
      throw cause;
    }
  }

  async function screenshot(query = {}, db) {
    assertDesktopEnabled({ db: db || deps.db, preferences: preferences(db) });
    await assertDesktopPermissions('screenshot', permissionDeps);
    const adapter = getAdapter();
    try {
      const running = await adapter.listRunningApps(observeDeps);
      const target = resolveAppTarget(query, running);
      await ensureAppAllowed(target, { sessionId: query.sessionId, db, actionLabel: '截取该应用窗口的画面。' });
      if (query.windowId == null) {
        const error = new Error('截图需要明确的 windowId，不会进行全屏截图。请先用 desktop_windows 获取窗口。');
        error.code = 'desktop_window_required';
        throw error;
      }
      const owned = await adapter.assertWindowOwnership(target, query.windowId, observeDeps);
      if (owned.minimized || (platform !== 'darwin' && owned.visible === false)) {
        const error = new Error(
          `窗口 ${query.windowId} 当前不可见或已最小化，无法截图。请先恢复窗口，或换一个可见窗口。`,
        );
        error.code = 'desktop_window_not_visible';
        throw error;
      }
      const result = await adapter.captureScreenshot(target, { windowId: query.windowId }, { ...observeDeps, ownedWindow: owned });
      recordActivity({
        tool: 'desktop_screenshot',
        ok: true,
        appName: result.appName || target.name || '',
        bundleId: result.bundleId || target.bundleId || '',
        windowId: result.windowId,
        title: owned.title || '',
        detail: result.scaled ? `png ${result.bytes || 0}B scaled` : `png ${result.bytes || 0}B`,
      }, db || deps.db);
      const payload = {
        ...result,
        bounds: result.bounds || owned.bounds || null,
      };
      rememberModelScreenshot(target, query.windowId, payload);
      publishPreview({
        sessionId: query.sessionId,
        appName: payload.appName || target.name || '',
        bundleId: payload.bundleId || target.bundleId || '',
        windowId: payload.windowId,
        title: owned.title || payload.title || '',
        action: '截取窗口',
        status: 'active',
        overlayCount: payload.overlayCount,
        bounds: payload.bounds,
        screenshot: payload,
        imageWidth: payload.imageWidth,
        imageHeight: payload.imageHeight,
      });
      return payload;
    } catch (cause) {
      recordActivity({
        tool: 'desktop_screenshot',
        ok: false,
        appName: query.appName || '',
        bundleId: query.bundleId || '',
        windowId: query.windowId,
        code: cause && cause.code ? cause.code : 'desktop_screenshot_failed',
        detail: cause && cause.message ? String(cause.message) : String(cause),
      }, db || deps.db);
      throw cause;
    }
  }

  async function click(query = {}, db) {
    assertDesktopEnabled({ db: db || deps.db, preferences: preferences(db) });
    await assertDesktopPermissions('click', permissionDeps);
    const adapter = getAdapter();
    try {
      const running = await adapter.listRunningApps(observeDeps);
      const target = resolveAppTarget(query, running);
      await ensureAppAllowed(target, { sessionId: query.sessionId, db, actionLabel: '在该应用窗口内执行点击。' });
      if (query.windowId == null) {
        const error = new Error('点击需要明确的 windowId。请先用 desktop_windows 获取窗口。');
        error.code = 'desktop_window_required';
        throw error;
      }
      const action = bindPopupClick({
        type: query.button === 'right' ? 'right_click' : (query.double ? 'double_click' : 'click'),
        popupWindowId: query.popupWindowId,
        ref: query.ref,
        elementPath: query.elementPath || query.nodePath || query.targetPath,
        x: query.x, y: query.y, rx: query.rx, ry: query.ry,
        normX: query.normX, normY: query.normY,
        imageWidth: query.imageWidth, imageHeight: query.imageHeight,
        button: query.button, double: query.double, clickCount: query.clickCount,
      }, lifecycle.current()?.popupObservation, target, query.windowId);
      if (platform === 'darwin' && typeof observeDeps.stageAct === 'function' && !action.ref && !action.elementPath) {
        try {
          const stageRes = await observeDeps.stageAct({
            windowId: Number(query.windowId),
            appName: target.name,
            bundleId: target.bundleId,
            appPath: target.path,
            actions: [action],
            captureAfter: false,
            restoreFocus: true,
          });
          if (stageRes.failedStep) {
            const err = new Error(stageRes.failedStep.error || '点击失败。');
            err.code = stageRes.failedStep.code || 'desktop_click_failed';
            throw err;
          }
          const step = (stageRes.steps && stageRes.steps[0]) || {};
          const result = {
            ok: true,
            staged: stageRes.staged === true,
            appName: String(target.name || ''),
            bundleId: String(target.bundleId || ''),
            windowId: Number(query.windowId),
            title: '',
            bounds: stageRes.bounds || null,
            x: step.x ?? null,
            y: step.y ?? null,
            button: query.button === 'right' ? 'right' : 'left',
            clickCount: query.double ? 2 : (Number(query.clickCount) || 1),
            ref: '',
            path: '',
            role: '',
            name: '',
            mode: stageRes.staged ? 'virtual_stage' : 'background',
            method: step.method || (stageRes.staged ? 'virtual_stage' : 'background'),
          };
          publishPreview({
            sessionId: query.sessionId,
            appName: result.appName,
            bundleId: result.bundleId,
            windowId: result.windowId,
            action: '点击',
            status: 'active',
            staged: stageRes.staged === true,
            bounds: result.bounds,
            cursor: normalizeCursorForBounds(result.x, result.y, result.bounds, 'click'),
          });
          recordActivity({
            tool: 'desktop_click',
            ok: true,
            appName: result.appName,
            bundleId: result.bundleId,
            windowId: result.windowId,
            detail: `click @${result.x},${result.y} ${result.mode}`,
          }, db || deps.db);
          return result;
        } catch (stageErr) {
          if (!isVirtualStageFallbackError(stageErr)) throw stageErr;
        }
      }
      if (action.popupWindowId != null && platform !== 'win32') throw popupChanged();
      const result = await adapter.click(target, {
        ...action,
        windowId: query.windowId,
        ref: query.ref,
        path: query.elementPath || query.nodePath || query.targetPath,
      }, { ...observeDeps, sessionId: query.sessionId });
      if (result.bounds && result.method !== 'AXPress') showControlBadge(result.bounds);
      publishPreview({
        sessionId: query.sessionId,
        appName: result.appName || target.name || '',
        bundleId: result.bundleId || target.bundleId || '',
        windowId: result.windowId,
        title: result.title || '',
        action: '点击',
        status: 'active',
        bounds: result.bounds || null,
        cursor: normalizeCursorForBounds(result.x, result.y, result.bounds, 'click'),
      });
      recordActivity({
        tool: 'desktop_click',
        ok: true,
        appName: result.appName || target.name || '',
        bundleId: result.bundleId || target.bundleId || '',
        windowId: result.windowId,
        title: result.title || '',
        detail: result.ref
          ? `click ${result.ref} @${result.x},${result.y}`
          : `click @${result.x},${result.y}`,
      }, db || deps.db);
      return result;
    } catch (cause) {
      recordActivity({
        tool: 'desktop_click',
        ok: false,
        appName: query.appName || '',
        bundleId: query.bundleId || '',
        windowId: query.windowId,
        code: cause && cause.code ? cause.code : 'desktop_click_failed',
        detail: cause && cause.message ? String(cause.message) : String(cause),
      }, db || deps.db);
      throw cause;
    }
  }

  async function type(query = {}, db) {
    assertDesktopEnabled({ db: db || deps.db, preferences: preferences(db) });
    await assertDesktopPermissions(canUseAccessibleField('type', query) ? 'snapshot' : 'type', permissionDeps);
    const adapter = getAdapter();
    const observeSearch = query.searchField === true && query.submit !== true;
    try {
      const running = await adapter.listRunningApps(observeDeps);
      const target = resolveAppTarget(query, running);
      await ensureAppAllowed(target, { sessionId: query.sessionId, db, actionLabel: '向该应用窗口输入文本。' });
      if (query.windowId == null) {
        const error = new Error('输入需要明确的 windowId。请先用 desktop_windows 获取窗口。');
        error.code = 'desktop_window_required';
        throw error;
      }
      if (platform === 'darwin'
        && typeof observeDeps.stageAct === 'function'
        && !query.ref && !query.elementPath && !query.nodePath && !query.targetPath) {
        try {
          const action = {
            type: 'type',
            text: query.text,
            x: query.x,
            y: query.y,
            rx: query.rx,
            ry: query.ry,
            normX: query.normX,
            normY: query.normY,
            imageWidth: query.imageWidth,
            imageHeight: query.imageHeight,
            clear: query.clear === true,
            submit: query.submit === true,
          };
          const stageRes = await observeDeps.stageAct({
            windowId: Number(query.windowId),
            appName: target.name,
            bundleId: target.bundleId,
            appPath: target.path,
            actions: [action],
            searchField: observeSearch,
            captureAfter: observeSearch,
            settleMs: 0,
            popupWaitMs: observeSearch ? SEARCH_POPUP_WAIT_MS : 0,
            restoreFocus: true,
          });
          if (stageRes.failedStep) {
            const err = new Error(stageRes.failedStep.error || '输入失败。');
            err.code = stageRes.failedStep.code || 'desktop_type_failed';
            throw err;
          }
          const step = (stageRes.steps && stageRes.steps[0]) || {};
          const result = {
            ok: true,
            staged: stageRes.staged === true,
            appName: String(target.name || ''),
            bundleId: String(target.bundleId || ''),
            windowId: Number(query.windowId),
            title: '',
            bounds: stageRes.bounds || null,
            chars: Number(step.chars || String(query.text || '').length),
            method: step.method || 'virtual_stage_unicode',
            submitted: Boolean(query.submit === true),
            valueVerified: false,
            ref: '',
            path: '',
            role: '',
            name: '',
            mode: stageRes.staged ? 'virtual_stage' : 'focused',
            ...stageCaptureResult(stageRes, target, Number(query.windowId), stageRes.bounds),
          };
          publishPreview({
            sessionId: query.sessionId,
            appName: result.appName,
            bundleId: result.bundleId,
            windowId: result.windowId,
            action: '输入',
            status: result.screenshotError ? 'error' : 'active',
            staged: result.staged,
            bounds: result.bounds,
            screenshot: result.screenshot,
            errorMessage: result.screenshotError?.message,
            overlayCount: result.screenshot?.overlayCount,
            imageWidth: result.screenshot?.imageWidth,
            imageHeight: result.screenshot?.imageHeight,
          });
          recordActivity({
            tool: 'desktop_type',
            ok: true,
            appName: result.appName,
            bundleId: result.bundleId,
            windowId: result.windowId,
            detail: `type ${result.chars || 0} chars ${result.mode}`,
          }, db || deps.db);
          return result;
        } catch (stageErr) {
          if (!isVirtualStageFallbackError(stageErr)) throw stageErr;
        }
      }
      const result = await runKeyboardAction('type', target, {
        windowId: query.windowId,
        text: query.text,
        ref: query.ref,
        elementPath: query.elementPath || query.nodePath || query.targetPath,
        path: query.elementPath || query.nodePath || query.targetPath,
        x: query.x,
        y: query.y,
        rx: query.rx,
        ry: query.ry,
        normX: query.normX,
        normY: query.normY,
        imageWidth: query.imageWidth,
        imageHeight: query.imageHeight,
        clear: query.clear === true,
        submit: query.submit === true,
      }, { ...observeDeps, sessionId: query.sessionId });
      const capture = observeSearch ? await captureActionResult(adapter, target, result.windowId, 0, SEARCH_POPUP_WAIT_MS) : {};
      if (result.bounds && result.method !== 'AXValue') showControlBadge(result.bounds);
      recordActivity({
        tool: 'desktop_type',
        ok: true,
        appName: result.appName || target.name || '',
        bundleId: result.bundleId || target.bundleId || '',
        windowId: result.windowId,
        title: result.title || '',
        // Never log the typed text—only length + targeting metadata.
        detail: result.ref
          ? `type ${result.chars || 0} chars → ${result.ref}`
          : `type ${result.chars || 0} chars`,
      }, db || deps.db);
      return { ...result, ...capture };
    } catch (cause) {
      recordActivity({
        tool: 'desktop_type',
        ok: false,
        appName: query.appName || '',
        bundleId: query.bundleId || '',
        windowId: query.windowId,
        code: cause && cause.code ? cause.code : 'desktop_type_failed',
        detail: cause && cause.message ? String(cause.message) : String(cause),
      }, db || deps.db);
      throw cause;
    }
  }

  async function scroll(query = {}, db) {
    assertDesktopEnabled({ db: db || deps.db, preferences: preferences(db) });
    await assertDesktopPermissions('scroll', permissionDeps);
    const adapter = getAdapter();
    try {
      const running = await adapter.listRunningApps(observeDeps);
      const target = resolveAppTarget(query, running);
      await ensureAppAllowed(target, { sessionId: query.sessionId, db, actionLabel: '在该应用窗口内滚动页面。' });
      if (query.windowId == null) {
        const error = new Error('滚动需要明确的 windowId。请先用 desktop_windows 获取窗口。');
        error.code = 'desktop_window_required';
        throw error;
      }
      const result = await adapter.scroll(target, {
        windowId: query.windowId,
        direction: query.direction,
        amount: query.amount,
        dx: query.dx,
        dy: query.dy,
        ref: query.ref,
        path: query.elementPath || query.nodePath || query.targetPath,
        elementPath: query.elementPath || query.nodePath || query.targetPath,
        x: query.x,
        y: query.y,
        rx: query.rx,
        ry: query.ry,
        normX: query.normX,
        normY: query.normY,
      }, { ...observeDeps, sessionId: query.sessionId });
      if (result.bounds) showControlBadge(result.bounds);
      recordActivity({
        tool: 'desktop_scroll',
        ok: true,
        appName: result.appName || target.name || '',
        bundleId: result.bundleId || target.bundleId || '',
        windowId: result.windowId,
        title: result.title || '',
        detail: result.ref
          ? `scroll ${result.direction || ''} ${result.amount || 0} → ${result.ref}`
          : `scroll ${result.direction || ''} ${result.amount || 0} @${result.x},${result.y}`,
      }, db || deps.db);
      return result;
    } catch (cause) {
      recordActivity({
        tool: 'desktop_scroll',
        ok: false,
        appName: query.appName || '',
        bundleId: query.bundleId || '',
        windowId: query.windowId,
        code: cause && cause.code ? cause.code : 'desktop_scroll_failed',
        detail: cause && cause.message ? String(cause.message) : String(cause),
      }, db || deps.db);
      throw cause;
    }
  }

  async function drag(query = {}, db) {
    assertDesktopEnabled({ db: db || deps.db, preferences: preferences(db) });
    await assertDesktopPermissions('drag', permissionDeps);
    const adapter = getAdapter();
    try {
      const running = await adapter.listRunningApps(observeDeps);
      const target = resolveAppTarget(query, running);
      await ensureAppAllowed(target, { sessionId: query.sessionId, db, actionLabel: '在该应用窗口内拖拽元素。' });
      if (query.windowId == null) {
        const error = new Error('拖拽需要明确的 windowId。请先用 desktop_windows 获取窗口。');
        error.code = 'desktop_window_required';
        throw error;
      }
      const result = await adapter.drag(target, {
        windowId: query.windowId,
        ref: query.ref || query.fromRef,
        elementPath: query.elementPath || query.fromElementPath || query.fromPath,
        path: query.elementPath || query.fromElementPath || query.fromPath,
        x: query.x != null ? query.x : query.fromX,
        y: query.y != null ? query.y : query.fromY,
        rx: query.rx != null ? query.rx : query.fromRx,
        ry: query.ry != null ? query.ry : query.fromRy,
        normX: query.normX != null ? query.normX : query.fromNormX,
        normY: query.normY != null ? query.normY : query.fromNormY,
        toRef: query.toRef || query.endRef,
        toElementPath: query.toElementPath || query.toPath || query.endElementPath || query.endPath,
        toPath: query.toElementPath || query.toPath || query.endElementPath || query.endPath,
        toX: query.toX != null ? query.toX : query.endX,
        toY: query.toY != null ? query.toY : query.endY,
        toRx: query.toRx != null ? query.toRx : query.endRx,
        toRy: query.toRy != null ? query.toRy : query.endRy,
        toNormX: query.toNormX != null ? query.toNormX : query.endNormX,
        toNormY: query.toNormY != null ? query.toNormY : query.endNormY,
        steps: query.steps,
      }, { ...observeDeps, sessionId: query.sessionId });
      if (result.bounds) showControlBadge(result.bounds);
      recordActivity({
        tool: 'desktop_drag',
        ok: true,
        appName: result.appName || target.name || '',
        bundleId: result.bundleId || target.bundleId || '',
        windowId: result.windowId,
        title: result.title || '',
        detail: result.fromRef || result.toRef
          ? `drag ${result.fromRef || 'pt'}→${result.toRef || 'pt'} ${result.dx},${result.dy}`
          : `drag @${result.fromX},${result.fromY}→${result.toX},${result.toY}`,
      }, db || deps.db);
      return result;
    } catch (cause) {
      recordActivity({
        tool: 'desktop_drag',
        ok: false,
        appName: query.appName || '',
        bundleId: query.bundleId || '',
        windowId: query.windowId,
        code: cause && cause.code ? cause.code : 'desktop_drag_failed',
        detail: cause && cause.message ? String(cause.message) : String(cause),
      }, db || deps.db);
      throw cause;
    }
  }

  async function hotkey(query = {}, db) {
    assertDesktopEnabled({ db: db || deps.db, preferences: preferences(db) });
    await assertDesktopPermissions('hotkey', permissionDeps);
    const adapter = getAdapter();
    try {
      const running = await adapter.listRunningApps(observeDeps);
      const target = resolveAppTarget(query, running);
      await ensureAppAllowed(target, { sessionId: query.sessionId, db, actionLabel: '向该应用窗口发送快捷键。' });
      if (query.windowId == null) {
        const error = new Error('快捷键需要明确的 windowId。请先用 desktop_windows 获取窗口。');
        error.code = 'desktop_window_required';
        throw error;
      }
      if (platform === 'darwin' && typeof observeDeps.stageAct === 'function') {
        try {
          const stageRes = await observeDeps.stageAct({
            windowId: Number(query.windowId),
            appName: target.name,
            bundleId: target.bundleId,
            appPath: target.path,
            actions: [{
              type: 'hotkey',
              key: query.key || query.keys,
              modifiers: query.modifiers || query.mods,
            }],
            captureAfter: false,
            restoreFocus: true,
          });
          if (stageRes.failedStep) {
            const err = new Error(stageRes.failedStep.error || '快捷键执行失败。');
            err.code = stageRes.failedStep.code || 'desktop_hotkey_failed';
            throw err;
          }
          const step = (stageRes.steps && stageRes.steps[0]) || {};
          const result = {
            ok: true,
            staged: true,
            appName: String(target.name || ''),
            bundleId: String(target.bundleId || ''),
            windowId: Number(query.windowId),
            title: '',
            bounds: stageRes.bounds || null,
            key: String(query.key || ''),
            chord: String(step.chord || query.key || ''),
            method: 'virtual_stage',
          };
          publishPreview({
            sessionId: query.sessionId,
            appName: result.appName,
            bundleId: result.bundleId,
            windowId: result.windowId,
            action: '快捷键',
            status: 'active',
            staged: true,
            bounds: result.bounds,
          });
          recordActivity({
            tool: 'desktop_hotkey',
            ok: true,
            appName: result.appName,
            bundleId: result.bundleId,
            windowId: result.windowId,
            detail: `hotkey ${result.chord || result.key || ''} staged`.trim(),
          }, db || deps.db);
          return result;
        } catch (stageErr) {
          if (!isVirtualStageFallbackError(stageErr)) throw stageErr;
        }
      }
      const result = await runKeyboardAction('hotkey', target, {
        windowId: query.windowId,
        key: query.key,
        keys: query.keys,
        modifiers: query.modifiers || query.mods,
        mods: query.mods || query.modifiers,
      });
      if (result.bounds) showControlBadge(result.bounds);
      recordActivity({
        tool: 'desktop_hotkey',
        ok: true,
        appName: result.appName || target.name || '',
        bundleId: result.bundleId || target.bundleId || '',
        windowId: result.windowId,
        title: result.title || '',
        detail: `hotkey ${result.chord || result.key || ''}`.trim(),
      }, db || deps.db);
      return result;
    } catch (cause) {
      recordActivity({
        tool: 'desktop_hotkey',
        ok: false,
        appName: query.appName || '',
        bundleId: query.bundleId || '',
        windowId: query.windowId,
        code: cause && cause.code ? cause.code : 'desktop_hotkey_failed',
        detail: cause && cause.message ? String(cause.message) : String(cause),
      }, db || deps.db);
      throw cause;
    }
  }

  async function captureActionResult(adapter, target, windowId, settleMs = 0, popupWaitMs = 0) {
    try {
      await assertDesktopPermissions('screenshot', permissionDeps);
      if (settleMs > 0) await new Promise((resolve) => setTimeout(resolve, settleMs));
      const screenshot = await adapter.captureScreenshot(target, { windowId, popupWaitMs }, observeDeps);
      if (!screenshot?.data) throw new Error('截图未返回图像。');
      rememberModelScreenshot(target, windowId, screenshot);
      return { screenshot };
    } catch (cause) {
      rememberModelScreenshot(target, windowId, null);
      return { screenshotError: { code: String(cause?.code || 'desktop_screenshot_failed'), message: String(cause?.message || '无法获取窗口画面。') } };
    }
  }

  async function launch(query = {}, db) {
    assertDesktopEnabled({ db: db || deps.db, preferences: preferences(db) });
    const adapter = getAdapter();
    const wantedName = String(query.appName || query.name || '').trim();
    const wantedBundle = String(query.bundleId || '').trim();
    const wantedPath = String(query.path || '').trim();
    const requestedWaitMs = Number(query.waitMs ?? 5000);
    const waitMs = Number.isFinite(requestedWaitMs) ? Math.min(Math.max(requestedWaitMs, 0), 15000) : 5000;
    if (!wantedName && !wantedBundle && !wantedPath) {
      const error = new Error('启动应用需要提供 appName、bundleId 或 path。');
      error.code = 'desktop_invalid_app';
      throw error;
    }

    try {
      const mappings = await readStaticMappings();
      const lowerName = wantedName.toLowerCase();
      const lowerBundle = wantedBundle.toLowerCase();
      const lowerPath = wantedPath.toLowerCase();
      const matched = mappings.find((m) => (
        (lowerBundle && m.bundleId.toLowerCase() === lowerBundle)
        || (lowerPath && m.path.toLowerCase() === lowerPath)
        || (lowerName && (
          m.displayName.toLowerCase() === lowerName
          || m.name.toLowerCase() === lowerName
          || m.executableName.toLowerCase() === lowerName
        ))
      ));
      const target = matched
        ? {
          name: matched.displayName || matched.name,
          displayName: matched.displayName || matched.name,
          englishName: matched.name,
          bundleId: matched.bundleId,
          path: matched.path,
        }
        : {
          name: wantedName || wantedBundle || wantedPath,
          displayName: wantedName || wantedBundle || wantedPath,
          englishName: wantedName || '',
          bundleId: wantedBundle,
          path: wantedPath,
        };

      if (!matched && !wantedPath && !wantedBundle) {
        const error = new Error(`在本机已安装应用中找不到「${wantedName}」。请先确认应用名称，或在设置 → 电脑操控 → 应用映射中核对名称。`);
        error.code = 'desktop_app_not_found';
        throw error;
      }

      // Enforce exact same allowlist & hard-block policy (with inline approval card in chat).
      await ensureAppAllowed(target, { sessionId: query.sessionId, db, actionLabel: `打开并观察「${target.name}」的窗口。` });

      let existingWindows = [];
      try {
        existingWindows = await adapter.listWindowsForApp(target, observeDeps);
      } catch {
        existingWindows = [];
      }
      const existingWindow = platform === 'darwin' ? chooseWindow(existingWindows, platform)
        : existingWindows.find(win => win.visible !== false && !win.minimized);
      const launchDeps = { ...observeDeps, bringToFront: query.bringToFront === true };
      if (existingWindow) {
        let staged = false;
        let resolvedBounds = existingWindow.bounds || null;
        if (platform === 'darwin' && launchDeps.bringToFront) {
          if (typeof observeDeps.stageRelease === 'function') {
            await observeDeps.stageRelease({
              windowId: existingWindow.windowId,
              focus: true,
              teardownIfEmpty: true,
            }).catch(() => {});
          }
          await adapter.launchApp(target, launchDeps);
        } else if (platform === 'darwin' && typeof observeDeps.stageWindow === 'function' && (existingWindow.visible === false || query.stage === true)) {
          try {
            const stageRes = await observeDeps.stageWindow({
              windowId: existingWindow.windowId,
              appName: target.name,
              bundleId: target.bundleId,
              appPath: target.path,
            });
            if (stageRes && stageRes.ok && stageRes.staged) {
              staged = true;
              if (stageRes.windowBounds) resolvedBounds = stageRes.windowBounds;
            }
          } catch {
            /* best effort: keep existing window as-is */
          }
        }
        const capture = query.screenshot === true
          ? await captureActionResult(adapter, target, existingWindow.windowId) : {};
        if (capture.screenshot?.bounds) resolvedBounds = capture.screenshot.bounds;
        recordActivity({
          tool: 'desktop_launch',
          ok: true,
          appName: target.name,
          bundleId: target.bundleId,
          windowId: existingWindow.windowId,
          title: existingWindow.title || '',
          code: capture.screenshotError?.code || '',
          detail: capture.screenshotError
            ? (staged ? 'already running · staged · 截图失败' : 'already running · 截图失败')
            : (staged ? 'already running · staged' : 'already running'),
        }, db || deps.db);
        if (capture.screenshot || existingWindow) {
          publishPreview({
            sessionId: query.sessionId,
            appName: target.name,
            bundleId: target.bundleId,
            windowId: existingWindow.windowId,
            title: existingWindow.title || '',
            action: launchDeps.bringToFront ? '切到前台' : (staged ? '后台舞台就绪' : '连接窗口'),
            status: capture.screenshotError ? 'error' : 'active',
            ...(staged ? { staged: true } : (launchDeps.bringToFront ? { staged: false } : {})),
            errorMessage: capture.screenshotError?.message,
            overlayCount: capture.screenshot?.overlayCount,
            bounds: resolvedBounds,
            screenshot: capture.screenshot,
            imageWidth: capture.screenshot?.imageWidth,
            imageHeight: capture.screenshot?.imageHeight,
          });
        }
        return {
          ok: true,
          alreadyRunning: true,
          ...(staged ? { staged: true } : {}),
          appName: target.name,
          displayName: target.displayName,
          bundleId: target.bundleId,
          path: target.path,
          windowId: existingWindow.windowId,
          bounds: resolvedBounds,
          windows: existingWindows,
          ...capture,
        };
      }

      await adapter.launchApp(target, launchDeps);

      let windows = [];
      const deadline = Date.now() + waitMs;
      while (Date.now() <= deadline) {
        try {
          windows = await adapter.listWindowsForApp(target, observeDeps);
          if (windows.some((win) => win.visible !== false && !win.minimized)) break;
        } catch {
          /* wait for process to finish launching */
        }
        if (Date.now() + 250 > deadline) break;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      const primary = chooseWindow(windows, platform);
      const capture = query.screenshot === true && primary && (platform === 'darwin' || primary.visible !== false) && !primary.minimized
        ? await captureActionResult(adapter, target, primary.windowId) : {};
      recordActivity({
        tool: 'desktop_launch',
        ok: true,
        appName: target.name,
        bundleId: target.bundleId,
        windowId: primary ? primary.windowId : null,
        title: primary ? primary.title || '' : '',
        code: capture.screenshotError?.code || '',
        detail: primary ? `launched #${primary.windowId}${capture.screenshotError ? ' · 截图失败' : ''}` : 'launched (no visible window yet)',
      }, db || deps.db);
      if (primary) {
        publishPreview({
          sessionId: query.sessionId,
          appName: target.name,
          bundleId: target.bundleId,
          windowId: primary.windowId,
          title: primary.title || '',
          action: '启动应用',
          status: capture.screenshotError ? 'error' : 'active',
          errorMessage: capture.screenshotError?.message,
          overlayCount: capture.screenshot?.overlayCount,
          bounds: capture.screenshot?.bounds || primary.bounds || null,
          screenshot: capture.screenshot,
          imageWidth: capture.screenshot?.imageWidth,
          imageHeight: capture.screenshot?.imageHeight,
        });
      }
      return {
        ok: true,
        alreadyRunning: false,
        appName: target.name,
        displayName: target.displayName,
        bundleId: target.bundleId,
        path: target.path,
        windowId: primary ? primary.windowId : null,
        bounds: primary ? (primary.bounds || null) : null,
        windows,
        ...capture,
      };
    } catch (cause) {
      recordActivity({
        tool: 'desktop_launch',
        ok: false,
        appName: wantedName,
        bundleId: wantedBundle,
        code: cause && cause.code ? cause.code : 'desktop_launch_failed',
        detail: cause && cause.message ? String(cause.message) : String(cause),
      }, db || deps.db);
      throw cause;
    }
  }

  /**
   * Codex-style batched Computer Use executor:
   * runs a short sequence of micro-actions (launch / click / double_click / type /
   * hotkey / scroll / drag / wait) in one turn, keeps the target-window control
   * badge visible, halts cleanly on mid-batch errors, and automatically returns
   * a fresh shadowless window screenshot so the model never wastes turns on
   * manual screenshot calls.
   */
  async function act(query = {}, db) {
    assertDesktopEnabled({ db: db || deps.db, preferences: preferences(db) });
    await assertDesktopPermissions('click', permissionDeps);
    const adapter = getAdapter();
    const rawActions = Array.isArray(query.actions) ? query.actions : [];
    if (rawActions.length > 16) {
      const error = new Error('单次批处理动作最多 16 步。');
      error.code = 'desktop_act_too_many';
      throw error;
    }

    if (permissionDeps.keyboardMonitor?.status === 'denied' && rawActions.some((item) => {
      const kind = String(item?.type || item?.action || '').trim().toLowerCase();
      return kind === 'hotkey' || (kind === 'type' && !canUseAccessibleField(kind, { ...item, elementPath: item.elementPath || item.path }));
    })) {
      permissionDeps.keyboardMonitor.assertAllowed();
    }
    const wantScreenshot = query.screenshot !== false;
    const lastAction = rawActions.at(-1);
    const endsWithWait = String(lastAction?.type || lastAction?.action || '').trim().toLowerCase() === 'wait';
    const popupWaitMs = wantScreenshot && query.searchField === true && query.settleMs == null && !endsWithWait ? SEARCH_POPUP_WAIT_MS : 0;
    const requestedSettleMs = Number(query.settleMs ?? (popupWaitMs || endsWithWait ? 0 : 260));
    const settleMs = Number.isFinite(requestedSettleMs) ? Math.min(Math.max(requestedSettleMs, 0), 3000) : 260;
    const sessionId = String(query.sessionId || '');
    const actionDeps = { ...observeDeps, sessionId };

    let target = null;
    let windowId = query.windowId != null ? Number(query.windowId) : null;
    let currentBounds = null;
    const steps = [];
    let failedStep = null;

    try {
      const running = await adapter.listRunningApps(observeDeps);
      const wantedName = String(query.appName || query.name || '').trim();
      const wantedBundle = String(query.bundleId || '').trim();
      const wantedPath = String(query.path || '').trim();
      if (!wantedName && !wantedBundle && !wantedPath) {
        const error = new Error('desktop_act 需要提供 appName、bundleId 或 path。');
        error.code = 'desktop_invalid_app';
        throw error;
      }

      // Match running app first; if not running, resolve from static mappings so launch can open it cleanly.
      const runningMatch = running.find((app) => (
        (wantedBundle && String(app.bundleId || '').toLowerCase() === wantedBundle.toLowerCase())
        || (wantedPath && String(app.path || '').toLowerCase() === wantedPath.toLowerCase())
        || (wantedName && String(app.name || '').toLowerCase() === wantedName.toLowerCase())
      ));
      if (runningMatch) {
        target = runningMatch;
      } else {
        let mappings = [];
        try { mappings = await readStaticMappings(); } catch { mappings = []; }
        const matched = mappings.find((m) => (
          (wantedBundle && m.bundleId.toLowerCase() === wantedBundle.toLowerCase())
          || (wantedPath && m.path.toLowerCase() === wantedPath.toLowerCase())
          || (wantedName && (
            m.displayName.toLowerCase() === wantedName.toLowerCase()
            || m.name.toLowerCase() === wantedName.toLowerCase()
            || m.executableName.toLowerCase() === wantedName.toLowerCase()
          ))
        ));
        target = matched
          ? {
            name: matched.displayName || matched.name,
            displayName: matched.displayName || matched.name,
            bundleId: matched.bundleId,
            path: matched.path,
          }
          : {
            name: wantedName || wantedBundle || wantedPath,
            bundleId: wantedBundle,
            path: wantedPath,
          };
      }

      // Single approval check for the whole batch (shows inline Codex-style card if needed).
      await ensureAppAllowed(target, {
        sessionId,
        db,
        actionLabel: `允许智能体在当前对话中操作「${target.name}」窗口。`,
      });

      const hasExplicitLaunch = rawActions.some((a) => String(a?.type || '').toLowerCase() === 'launch');
      if (windowId == null) {
        const wins = await adapter.listWindowsForApp(target, observeDeps).catch(() => []);
        const visible = chooseWindow(wins, platform);
        if (visible) {
          windowId = visible.windowId;
          currentBounds = visible.bounds || null;
        } else if (!hasExplicitLaunch && query.autoLaunch !== false) {
          const launched = await launch({
            appName: target.name,
            bundleId: target.bundleId,
            path: target.path,
            sessionId,
            waitMs: 5000,
          }, db);
          windowId = launched.windowId;
          currentBounds = launched.bounds || null;
          steps.push({ index: 0, type: 'launch', ok: true, windowId, auto: true });
        }
      } else {
        const owned = await adapter.assertWindowOwnership(target, windowId, observeDeps);
        currentBounds = owned.bounds || null;
      }

      const boundActions = rawActions.map(action => bindPopupClick(action, lifecycle.current()?.popupObservation, target, windowId));
      const hasPopupClick = boundActions.some(action => action?.popupWindowId != null);
      if (hasPopupClick && boundActions.length !== 1) {
        throw Object.assign(new Error('请单独点击截图中的弹窗，然后读取新的窗口画面。'), { code: 'desktop_act_invalid' });
      }
      if (platform === 'darwin'
        && windowId != null
        && typeof observeDeps.stageAct === 'function'
        && rawActions.some(item => String(item?.type || item?.action || '').trim().toLowerCase() !== 'wait')
        && canUseVirtualStageActions(rawActions)) {
        try {
          const stageRes = await observeDeps.stageAct({
            windowId,
            appName: target.name,
            bundleId: target.bundleId,
            appPath: target.path,
            actions: boundActions,
            searchField: query.searchField === true,
            captureAfter: wantScreenshot,
            settleMs,
            popupWaitMs,
            includePopups: true,
            maxEdge: 1440,
            restoreFocus: true,
          });
          const stageSteps = Array.isArray(stageRes.steps) ? stageRes.steps : [];
          const stageFailed = stageRes.failedStep || null;
          const stageBounds = stageRes.bounds || currentBounds;
          const stageCapture = stageCaptureResult(stageRes, target, windowId, stageBounds);
          const stageOk = !stageFailed && stageRes.ok !== false;
          const stageLastPoint = [...stageSteps].reverse().find((step) => step.ok && step.x != null && step.y != null);
          const stageLast = [...stageSteps].reverse().find((step) => step.ok) || stageSteps[stageSteps.length - 1];
          const stageStepLabels = {
            launch: '启动应用',
            click: '点击',
            double_click: '双击',
            right_click: '右键',
            type: '输入',
            hotkey: '快捷键',
            scroll: '滚动',
            drag: '拖拽',
            wait: '等待',
          };
          publishPreview({
            sessionId,
            appName: target.name || '',
            bundleId: target.bundleId || '',
            windowId,
            title: '',
            action: stageStepLabels[stageLast?.type] || '后台操作',
            status: stageFailed ? 'error' : 'active',
            staged: stageRes.staged === true,
            errorMessage: stageFailed?.error || stageCapture.screenshotError?.message,
            overlayCount: stageCapture.screenshot?.overlayCount,
            bounds: stageBounds,
            cursor: stageLastPoint
              ? normalizeCursorForBounds(stageLastPoint.x, stageLastPoint.y, stageBounds, stageLastPoint.type === 'scroll' ? 'scroll' : 'click')
              : null,
            screenshot: stageCapture.screenshot,
            imageWidth: stageCapture.screenshot?.imageWidth,
            imageHeight: stageCapture.screenshot?.imageHeight,
          });
          const detailParts = [`${stageSteps.filter((s) => s.ok).length}/${rawActions.length} steps`, stageRes.staged ? 'staged' : 'background'];
          if (stageCapture.screenshot) detailParts.push('+shot');
          if (stageCapture.screenshotError) detailParts.push('截图失败');
          recordActivity({
            tool: 'desktop_act',
            ok: stageOk,
            appName: target.name || '',
            bundleId: target.bundleId || '',
            windowId,
            code: stageFailed?.code || stageCapture.screenshotError?.code || '',
            detail: detailParts.join(' '),
          }, db || deps.db);
          return {
            ok: stageOk,
            staged: stageRes.staged === true,
            appName: target.name || '',
            bundleId: target.bundleId || '',
            windowId,
            bounds: stageBounds,
            steps: [...steps, ...stageSteps],
            ...(stageFailed ? { failedStep: stageFailed } : {}),
            ...stageCapture,
          };
        } catch (stageErr) {
          if (!isVirtualStageFallbackError(stageErr)) throw stageErr;
          // Virtual stage unavailable or refused by this window: fall through cleanly to standard path.
        }
      }

      if (hasPopupClick && platform !== 'win32') throw popupChanged();

      for (let i = 0; i < rawActions.length; i += 1) {
        const item = boundActions[i] && typeof boundActions[i] === 'object' ? boundActions[i] : {};
        const kind = String(item.type || item.action || '').trim().toLowerCase();
        try {
          if (kind === 'launch') {
            if (query.windowId != null) {
              // A launch step cannot replace an explicitly bound window with a sibling.
              await adapter.assertWindowOwnership(target, windowId, observeDeps);
              steps.push({ index: i + 1, type: 'launch', ok: true, windowId, alreadyRunning: true });
              continue;
            }
            const launched = await launch({
              appName: target.name,
              bundleId: target.bundleId,
              path: target.path,
              sessionId,
              waitMs: item.waitMs != null ? item.waitMs : 5000,
            }, db);
            windowId = launched.windowId;
            currentBounds = launched.bounds || currentBounds;
            steps.push({ index: i + 1, type: 'launch', ok: true, windowId, alreadyRunning: launched.alreadyRunning });
          } else if (kind === 'wait') {
            const ms = Math.min(Math.max(Number(item.ms) || 300, 30), 5000);
            await new Promise((resolve) => setTimeout(resolve, ms));
            steps.push({ index: i + 1, type: 'wait', ok: true, ms });
          } else {
            if (windowId == null) {
              const error = new Error(`应用「${target.name}」当前没有可见窗口，无法执行 ${kind || '操作'}。`);
              error.code = 'desktop_window_required';
              throw error;
            }
            if (kind === 'click' || kind === 'double_click' || kind === 'right_click') {
              const res = await adapter.click(target, {
                windowId,
                popupWindowId: item.popupWindowId,
                popupBounds: item.popupBounds,
                ref: item.ref,
                path: item.elementPath || item.path,
                x: item.x,
                y: item.y,
                rx: item.rx,
                ry: item.ry,
                normX: item.normX,
                normY: item.normY,
                imageWidth: item.imageWidth,
                imageHeight: item.imageHeight,
                button: kind === 'right_click' ? 'right' : item.button,
                double: kind === 'double_click' || item.double === true,
                clickCount: item.clickCount,
              }, actionDeps);
              if (res.bounds) currentBounds = res.bounds;
              steps.push({ index: i + 1, type: kind, ok: true, x: res.x, y: res.y, ref: res.ref || '', ...(res.method ? { method: res.method } : {}) });
            } else if (kind === 'type') {
              const res = await runKeyboardAction('type', target, {
                windowId,
                text: item.text,
                ref: item.ref,
                elementPath: item.elementPath || item.path,
                path: item.elementPath || item.path,
                x: item.x,
                y: item.y,
                rx: item.rx,
                ry: item.ry,
                normX: item.normX,
                normY: item.normY,
                imageWidth: item.imageWidth,
                imageHeight: item.imageHeight,
                clear: item.clear === true,
                submit: item.submit === true,
              }, actionDeps);
              if (res.bounds) currentBounds = res.bounds;
              steps.push({
                index: i + 1, type: 'type', ok: true, chars: res.chars || 0, submitted: Boolean(res.submitted),
                ...(res.method ? { method: res.method } : {}),
                ...(typeof res.valueVerified === 'boolean' ? { valueVerified: res.valueVerified } : {}),
              });
            } else if (kind === 'hotkey') {
              const res = await runKeyboardAction('hotkey', target, {
                windowId,
                key: item.key,
                keys: item.keys,
                modifiers: item.modifiers || item.mods,
                mods: item.mods || item.modifiers,
              });
              if (res.bounds) currentBounds = res.bounds;
              steps.push({ index: i + 1, type: 'hotkey', ok: true, chord: res.chord || res.key || '' });
            } else if (kind === 'scroll') {
              const res = await adapter.scroll(target, {
                windowId,
                direction: item.direction,
                amount: item.amount,
                dx: item.dx,
                dy: item.dy,
                ref: item.ref,
                path: item.elementPath || item.path,
                elementPath: item.elementPath || item.path,
                x: item.x,
                y: item.y,
                rx: item.rx,
                ry: item.ry,
                normX: item.normX,
                normY: item.normY,
              }, actionDeps);
              if (res.bounds) currentBounds = res.bounds;
              steps.push({ index: i + 1, type: 'scroll', ok: true, direction: res.direction || '', amount: res.amount || 0 });
            } else if (kind === 'drag') {
              const res = await adapter.drag(target, {
                windowId,
                ref: item.ref || item.fromRef,
                elementPath: item.elementPath || item.fromPath,
                path: item.elementPath || item.fromPath,
                x: item.x != null ? item.x : item.fromX,
                y: item.y != null ? item.y : item.fromY,
                rx: item.rx != null ? item.rx : item.fromRx,
                ry: item.ry != null ? item.ry : item.fromRy,
                normX: item.normX != null ? item.normX : item.fromNormX,
                normY: item.normY != null ? item.normY : item.fromNormY,
                toRef: item.toRef,
                toElementPath: item.toElementPath || item.toPath,
                toPath: item.toElementPath || item.toPath,
                toX: item.toX,
                toY: item.toY,
                toRx: item.toRx,
                toRy: item.toRy,
                toNormX: item.toNormX,
                toNormY: item.toNormY,
                steps: item.steps,
              }, actionDeps);
              if (res.bounds) currentBounds = res.bounds;
              steps.push({ index: i + 1, type: 'drag', ok: true, fromX: res.fromX, fromY: res.fromY, toX: res.toX, toY: res.toY });
            } else {
              const error = new Error(`不支持的动作类型：${kind || '(empty)'}`);
              error.code = 'desktop_act_invalid';
              throw error;
            }
          }
          if (currentBounds && !['launch', 'wait'].includes(kind) && !['AXPress', 'AXValue'].includes(steps.at(-1)?.method)) showControlBadge(currentBounds);
          // Natural micro-pacing between chained UI actions so animations/focus settle.
          if (i < rawActions.length - 1 && kind !== 'wait' && kind !== 'launch') {
            await new Promise((resolve) => setTimeout(resolve, 90));
          }
        } catch (stepErr) {
          failedStep = {
            index: i + 1,
            type: kind,
            code: stepErr?.cause?.code === 'desktop_action_outcome_unknown'
              ? stepErr.cause.code : String(stepErr?.code || 'desktop_act_step_failed'),
            error: stepErr && stepErr.message ? String(stepErr.message) : String(stepErr),
          };
          steps.push({ index: i + 1, type: kind, ok: false, code: failedStep.code, error: failedStep.error });
          break;
        }
      }

      const capture = wantScreenshot && windowId != null
        ? await captureActionResult(adapter, target, windowId, rawActions.length > 0 && !failedStep ? settleMs : 0, failedStep ? 0 : popupWaitMs)
        : {};
      if (capture.screenshot?.bounds) {
        currentBounds = capture.screenshot.bounds;
      }

      const ok = !failedStep;
      const lastPointStep = [...steps].reverse().find((step) => step.ok && step.x != null && step.y != null);
      const lastStep = [...steps].reverse().find((step) => step.ok) || steps[steps.length - 1];
      const stepLabels = {
        launch: '启动应用',
        click: '点击',
        double_click: '双击',
        right_click: '右键',
        type: '输入',
        hotkey: '快捷键',
        scroll: '滚动',
        drag: '拖拽',
        wait: '等待',
      };
      if (windowId != null) {
        publishPreview({
          sessionId,
          appName: target.name || '',
          bundleId: target.bundleId || '',
          windowId,
          title: capture.screenshot?.title || '',
          action: stepLabels[lastStep?.type] || '执行操作',
          status: failedStep ? 'error' : 'active',
          errorMessage: failedStep?.error || capture.screenshotError?.message,
          overlayCount: capture.screenshot?.overlayCount,
          bounds: currentBounds,
          cursor: lastPointStep
            ? normalizeCursorForBounds(lastPointStep.x, lastPointStep.y, currentBounds, lastPointStep.type === 'scroll' ? 'scroll' : 'click')
            : null,
          screenshot: capture.screenshot,
          imageWidth: capture.screenshot?.imageWidth,
          imageHeight: capture.screenshot?.imageHeight,
        });
      }
      const activityDetail = [`${steps.filter((step) => step.ok).length}/${rawActions.length || steps.length} steps`];
      if (capture.screenshot) activityDetail.push('+shot');
      if (capture.screenshotError) activityDetail.push('截图失败');
      recordActivity({
        tool: 'desktop_act',
        ok,
        appName: target.name || '',
        bundleId: target.bundleId || '',
        windowId,
        code: failedStep?.code || capture.screenshotError?.code || '',
        detail: activityDetail.join(' '),
      }, db || deps.db);

      return {
        ok,
        appName: target.name || '',
        bundleId: target.bundleId || '',
        windowId,
        bounds: currentBounds,
        steps,
        ...(failedStep ? { failedStep } : {}),
        ...capture,
      };
    } catch (cause) {
      recordActivity({
        tool: 'desktop_act',
        ok: false,
        appName: query.appName || '',
        bundleId: query.bundleId || '',
        windowId,
        code: cause && cause.code ? cause.code : 'desktop_act_failed',
        detail: cause && cause.message ? String(cause.message) : String(cause),
      }, db || deps.db);
      throw cause;
    }
  }

  /**
   * Lightweight live preview frame for the in-chat PiP thumbnail.
   * Never prompts for approval or writes to the activity log; only captures
   * windows of apps already approved in this session or Always Allow.
   */
  async function previewCapture(query = {}, db) {
    assertDesktopEnabled({ db: db || deps.db, preferences: preferences(db) });
    await assertDesktopPermissions('screenshot', permissionDeps);
    const adapter = getAdapter();
    const running = await adapter.listRunningApps(observeDeps);
    const target = resolveAppTarget(query, running);
    const decision = decideDesktopAccess(target, {
      sessionId: query.sessionId,
      preferences: preferences(db),
    });
    if (decision.decision !== 'allow') {
      const error = new Error(decision.reason || '该应用未在当前会话授权列表中。');
      error.code = 'desktop_app_not_allowed';
      throw error;
    }
    const windowId = Number(query.windowId || 0);
    if (!windowId) {
      const error = new Error('缺少 windowId。');
      error.code = 'desktop_window_required';
      throw error;
    }
    const owned = await adapter.assertWindowOwnership(target, windowId, observeDeps);
    if (owned.minimized) {
      const error = new Error(`窗口 ${windowId} 已最小化。`);
      error.code = 'desktop_window_not_visible';
      throw error;
    }
    const shot = await adapter.captureScreenshot(target, {
      windowId,
      maxEdge: Number(query.maxEdge) || 640,
      format: 'jpeg',
      quality: 0.72,
      includePopups: true,
    }, { ...observeDeps, ownedWindow: owned });
    return {
      ok: true,
      sessionId: String(query.sessionId || ''),
      appName: shot.appName || target.name || '',
      bundleId: shot.bundleId || target.bundleId || '',
      windowId: shot.windowId,
      title: owned.title || shot.title || '',
      bounds: shot.bounds || owned.bounds || null,
      overlayCount: shot.overlayCount || 0,
      panels: previewPanels(shot),
      imageDataUrl: `data:${shot.mimeType || 'image/jpeg'};base64,${shot.data}`,
      imageWidth: shot.imageWidth || null,
      imageHeight: shot.imageHeight || null,
      updatedAt: Date.now(),
    };
  }

  /**
   * Bring an already-allowed desktop app to front from the in-chat PiP preview card.
   * If the window is currently staged on the macOS Virtual Stage, releases it back to its
   * original physical display coordinates before focusing.
   */
  async function focusWindow(query = {}, db) {
    assertDesktopEnabled({ db: db || deps.db, preferences: preferences(db) });
    const adapter = getAdapter();
    const running = await adapter.listRunningApps(observeDeps);
    const target = resolveAppTarget(query, running);
    const decision = decideDesktopAccess(target, {
      sessionId: query.sessionId,
      preferences: preferences(db),
    });
    if (decision.decision !== 'allow') {
      const error = new Error(decision.reason || '该应用未在当前会话授权列表中。');
      error.code = 'desktop_app_not_allowed';
      throw error;
    }
    let released = false;
    const windowId = Number(query.windowId || 0);
    if (platform === 'darwin' && windowId > 0 && typeof observeDeps.stageRelease === 'function') {
      try {
        const rel = await observeDeps.stageRelease({
          windowId,
          focus: query.focus !== false,
          teardownIfEmpty: true,
        });
        released = Boolean(rel && rel.released);
      } catch {
        /* fall through to standard focus */
      }
    }
    if (query.focus !== false) {
      await adapter.launchApp(target, { ...observeDeps, bringToFront: true });
    }
    if (windowId > 0) {
      publishPreview({
        sessionId: query.sessionId,
        appName: target.name || '',
        bundleId: target.bundleId || '',
        windowId,
        action: released ? '已移回主屏' : '已切到前台',
        status: 'idle',
        staged: false,
      });
    }
    return { ok: true, released, appName: target.name || '', bundleId: target.bundleId || '' };
  }

  return {
    withRun: lifecycle.withRun,
    status,
    preferences,
    setPreferences: (patch, db) => setDesktopControlPreferences(patch, db || deps.db),
    addAlwaysAllow: (input, db) => addAlwaysAllowApp(enrichAllowInput(input), db || deps.db),
    removeAlwaysAllow: (input, db) => removeAlwaysAllowApp(input, db || deps.db),
    permissionStatus,
    openPermissionSettings: (kind) => openDesktopPermissionSettings(kind, permissionDeps),
    stopHelper: () => {
      destroyWindowControlBadge();
      if (platform === 'win32') {
        if (deps.win32Bridge && typeof deps.win32Bridge.stop === 'function') return deps.win32Bridge.stop();
        return win32Adapter.stopHelper();
      }
      return helperClient && typeof helperClient.stop === 'function' ? helperClient.stop() : Promise.resolve();
    },
    hideOverlay: () => hideWindowControlBadge(),
    clearSessionAllow: (sessionId) => clearSessionAllowApps(sessionId),
    listActivity: (limit, db) => listDesktopActivity(limit, db || deps.db),
    clearActivity: (db) => clearDesktopActivity(db || deps.db),
    listAppMappings,
    listInstalledApps,
    listApps,
    listWindows,
    launch,
    act,
    snapshot,
    screenshot,
    click,
    type,
    scroll,
    drag,
    hotkey,
    previewCapture,
    focusWindow,
  };
}

const defaultService = createDesktopControlService();

module.exports = {
  createDesktopControlService,
  withDesktopControlRun: (...args) => defaultService.withRun(...args),
  DESKTOP_CONTROL_TOOLS,
  DESKTOP_CONTROL_ACTIONS,
  getDesktopControlStatus: (...args) => defaultService.status(...args),
  getDesktopControlPreferences: (...args) => defaultService.preferences(...args),
  setDesktopControlPreferences: (...args) => defaultService.setPreferences(...args),
  addDesktopAlwaysAllowApp: (...args) => defaultService.addAlwaysAllow(...args),
  removeDesktopAlwaysAllowApp: (...args) => defaultService.removeAlwaysAllow(...args),
  clearDesktopSessionAllow: (...args) => defaultService.clearSessionAllow(...args),
  getDesktopPermissionStatus: (...args) => defaultService.permissionStatus(...args),
  openDesktopPermissionSettings: (...args) => defaultService.openPermissionSettings(...args),
  stopDesktopControlHelper: () => defaultService.stopHelper(),
  hideDesktopControlOverlay: () => defaultService.hideOverlay(),
  listDesktopActivity: (...args) => defaultService.listActivity(...args),
  clearDesktopActivity: (...args) => defaultService.clearActivity(...args),
  listDesktopAppMappings: (...args) => defaultService.listAppMappings(...args),
  listDesktopInstalledApps: (...args) => defaultService.listInstalledApps(...args),
  listDesktopApps: (...args) => defaultService.listApps(...args),
  listDesktopWindows: (...args) => defaultService.listWindows(...args),
  launchAllowedDesktopApp: (...args) => defaultService.launch(...args),
  actAllowedDesktop: (...args) => defaultService.act(...args),
  captureAllowedDesktopSnapshot: (...args) => defaultService.snapshot(...args),
  captureAllowedDesktopScreenshot: (...args) => defaultService.screenshot(...args),
  clickAllowedDesktop: (...args) => defaultService.click(...args),
  typeAllowedDesktop: (...args) => defaultService.type(...args),
  scrollAllowedDesktop: (...args) => defaultService.scroll(...args),
  dragAllowedDesktop: (...args) => defaultService.drag(...args),
  hotkeyAllowedDesktop: (...args) => defaultService.hotkey(...args),
  captureDesktopPreviewFrame: (...args) => defaultService.previewCapture(...args),
  focusAllowedDesktopWindow: (...args) => defaultService.focusWindow(...args),
};
