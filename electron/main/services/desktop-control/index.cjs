/**
 * Public desktop-control service API for capabilities and IPC.
 */
const { applications, applicationIcon } = require('../mac-apps.cjs');
const {
  getDesktopControlPreferences,
  setDesktopControlPreferences,
  addAlwaysAllowApp,
  removeAlwaysAllowApp,
  decideDesktopAccess,
  assertDesktopEnabled,
  assertDesktopAppAllowed,
  selfIdentity,
  isBlockedApp,
  normalizeAllowEntry,
} = require('./policy.cjs');
const {
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
  listRunningDesktopApps,
  listDesktopWindowsForApp,
  listDesktopWindowsForApps,
  assertWindowBelongsToApp,
  captureDesktopSnapshot,
  captureDesktopScreenshot,
} = require('./observe.cjs');
const { clickDesktop, typeDesktop, scrollDesktop, dragDesktop, hotkeyDesktop } = require('./act.cjs');

/** Public tool names exposed by the desktop-control capability (for status/agent UX). */
const DESKTOP_CONTROL_TOOLS = Object.freeze([
  'desktop_status',
  'desktop_apps',
  'desktop_windows',
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
  'click',
  'type',
  'scroll',
  'drag',
  'hotkey',
]);

function recordActivity(input, db) {
  try {
    appendDesktopActivity(input, db);
  } catch {
    /* activity log must never break observation */
  }
}

function createDesktopControlService(deps = {}) {
  const observeDeps = {
    runner: deps.runner,
    platform: deps.platform,
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
  };
  const permissionDeps = {
    systemPreferences: deps.systemPreferences,
    shell: deps.shell,
    platform: deps.platform,
    desktopCapturer: deps.desktopCapturer,
    skipScreenProbe: deps.skipScreenProbe === true,
  };

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
          icon = typeof deps.applicationIcon === 'function'
            ? deps.applicationIcon(entry.path)
            : applicationIcon(entry.path);
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

  async function listInstalledApps() {
    if ((deps.platform || process.platform) !== 'darwin') {
      const error = new Error('电脑操控目前仅支持 macOS。');
      error.code = 'desktop_unsupported_platform';
      throw error;
    }
    try {
      const apps = typeof deps.listInstalledApps === 'function'
        ? deps.listInstalledApps()
        : applications();
      let running = [];
      try {
        running = await listRunningDesktopApps(observeDeps);
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
        const entry = normalizeAllowEntry({
          name: app.name,
          path: app.path,
          bundleId: app.bundleId || '',
        });
        let icon;
        try {
          icon = typeof deps.applicationIcon === 'function'
            ? deps.applicationIcon(app.path)
            : applicationIcon(app.path);
        } catch {
          icon = undefined;
        }
        const bundle = String(entry?.bundleId || '').toLowerCase();
        const name = String(entry?.name || '').toLowerCase();
        const appPath = String(entry?.path || '').toLowerCase();
        const runningNow = Boolean(
          (bundle && runningKeys.has(`bundle:${bundle}`))
          || (appPath && runningKeys.has(`path:${appPath}`))
          || (!bundle && name && runningKeys.has(`name:${name}`)),
        );
        return {
          ...entry,
          blocked: isBlockedApp(entry),
          icon: icon || undefined,
          running: runningNow,
        };
      }).filter(Boolean);

      mapped.sort((a, b) => {
        if (Boolean(a.running) !== Boolean(b.running)) return a.running ? -1 : 1;
        return String(a.name || '').localeCompare(String(b.name || ''), 'zh-Hans');
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
    // Running-app inventory uses NSWorkspace and does not need Accessibility.
    // Keep Screen Recording optional here so users can discover what to allow first.
    const prefs = preferences(db);
    try {
      const running = await listRunningDesktopApps(observeDeps);
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
    const prefs = preferences(db);
    try {
      const running = await listRunningDesktopApps(observeDeps);
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
        const verdict = decideDesktopAccess(app, { preferences: prefs, db: db || deps.db });
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
      const listed = await listDesktopWindowsForApps(allowedTargets, observeDeps);
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
      if (wantedBundle && String(app.bundleId || '') === wantedBundle) return true;
      if (wantedPath && String(app.path || '') === wantedPath) return true;
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
    try {
      const running = await listRunningDesktopApps(observeDeps);
      const target = resolveAppTarget(query, running);
      assertDesktopAppAllowed(target, { db: db || deps.db, preferences: preferences(db) });
      if (query.windowId != null) {
        await assertWindowBelongsToApp(target, query.windowId, observeDeps);
      }
      const result = await captureDesktopSnapshot(target, {
        windowId: query.windowId,
        maxNodes: query.maxNodes,
        maxChars: query.maxChars,
      }, observeDeps);
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
    try {
      const running = await listRunningDesktopApps(observeDeps);
      const target = resolveAppTarget(query, running);
      assertDesktopAppAllowed(target, { db: db || deps.db, preferences: preferences(db) });
      if (query.windowId == null) {
        const error = new Error('截图需要明确的 windowId，不会进行全屏截图。请先用 desktop_windows 获取窗口。');
        error.code = 'desktop_window_required';
        throw error;
      }
      const owned = await assertWindowBelongsToApp(target, query.windowId, observeDeps);
      if (owned.minimized || owned.visible === false) {
        const error = new Error(
          `窗口 ${query.windowId} 当前不可见或已最小化，无法截图。请先恢复窗口，或换一个可见窗口。`,
        );
        error.code = 'desktop_window_not_visible';
        throw error;
      }
      const result = await captureDesktopScreenshot(target, { windowId: query.windowId }, observeDeps);
      recordActivity({
        tool: 'desktop_screenshot',
        ok: true,
        appName: result.appName || target.name || '',
        bundleId: result.bundleId || target.bundleId || '',
        windowId: result.windowId,
        title: owned.title || '',
        detail: result.scaled ? `png ${result.bytes || 0}B scaled` : `png ${result.bytes || 0}B`,
      }, db || deps.db);
      return result;
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
    try {
      const running = await listRunningDesktopApps(observeDeps);
      const target = resolveAppTarget(query, running);
      assertDesktopAppAllowed(target, { db: db || deps.db, preferences: preferences(db) });
      if (query.windowId == null) {
        const error = new Error('点击需要明确的 windowId。请先用 desktop_windows 获取窗口。');
        error.code = 'desktop_window_required';
        throw error;
      }
      const result = await clickDesktop(target, {
        windowId: query.windowId,
        ref: query.ref,
        path: query.elementPath || query.nodePath || query.targetPath,
        x: query.x,
        y: query.y,
        button: query.button,
      }, observeDeps);
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
    await assertDesktopPermissions('type', permissionDeps);
    try {
      const running = await listRunningDesktopApps(observeDeps);
      const target = resolveAppTarget(query, running);
      assertDesktopAppAllowed(target, { db: db || deps.db, preferences: preferences(db) });
      if (query.windowId == null) {
        const error = new Error('输入需要明确的 windowId。请先用 desktop_windows 获取窗口。');
        error.code = 'desktop_window_required';
        throw error;
      }
      const result = await typeDesktop(target, {
        windowId: query.windowId,
        text: query.text,
        ref: query.ref,
        elementPath: query.elementPath || query.nodePath || query.targetPath,
        path: query.elementPath || query.nodePath || query.targetPath,
      }, observeDeps);
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
      return result;
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
    try {
      const running = await listRunningDesktopApps(observeDeps);
      const target = resolveAppTarget(query, running);
      assertDesktopAppAllowed(target, { db: db || deps.db, preferences: preferences(db) });
      if (query.windowId == null) {
        const error = new Error('滚动需要明确的 windowId。请先用 desktop_windows 获取窗口。');
        error.code = 'desktop_window_required';
        throw error;
      }
      const result = await scrollDesktop(target, {
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
      }, observeDeps);
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
    try {
      const running = await listRunningDesktopApps(observeDeps);
      const target = resolveAppTarget(query, running);
      assertDesktopAppAllowed(target, { db: db || deps.db, preferences: preferences(db) });
      if (query.windowId == null) {
        const error = new Error('拖拽需要明确的 windowId。请先用 desktop_windows 获取窗口。');
        error.code = 'desktop_window_required';
        throw error;
      }
      const result = await dragDesktop(target, {
        windowId: query.windowId,
        ref: query.ref || query.fromRef,
        elementPath: query.elementPath || query.fromElementPath || query.fromPath,
        path: query.elementPath || query.fromElementPath || query.fromPath,
        x: query.x != null ? query.x : query.fromX,
        y: query.y != null ? query.y : query.fromY,
        toRef: query.toRef || query.endRef,
        toElementPath: query.toElementPath || query.toPath || query.endElementPath || query.endPath,
        toPath: query.toElementPath || query.toPath || query.endElementPath || query.endPath,
        toX: query.toX != null ? query.toX : query.endX,
        toY: query.toY != null ? query.toY : query.endY,
        steps: query.steps,
      }, observeDeps);
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
    try {
      const running = await listRunningDesktopApps(observeDeps);
      const target = resolveAppTarget(query, running);
      assertDesktopAppAllowed(target, { db: db || deps.db, preferences: preferences(db) });
      if (query.windowId == null) {
        const error = new Error('快捷键需要明确的 windowId。请先用 desktop_windows 获取窗口。');
        error.code = 'desktop_window_required';
        throw error;
      }
      const result = await hotkeyDesktop(target, {
        windowId: query.windowId,
        key: query.key,
        keys: query.keys,
        modifiers: query.modifiers || query.mods,
        mods: query.mods || query.modifiers,
      }, observeDeps);
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

  return {
    status,
    preferences,
    setPreferences: (patch, db) => setDesktopControlPreferences(patch, db || deps.db),
    addAlwaysAllow: (input, db) => addAlwaysAllowApp(input, db || deps.db),
    removeAlwaysAllow: (input, db) => removeAlwaysAllowApp(input, db || deps.db),
    permissionStatus: () => getDesktopPermissionStatus(permissionDeps),
    openPermissionSettings: (kind) => openDesktopPermissionSettings(kind, permissionDeps),
    listActivity: (limit, db) => listDesktopActivity(limit, db || deps.db),
    clearActivity: (db) => clearDesktopActivity(db || deps.db),
    listInstalledApps,
    listApps,
    listWindows,
    snapshot,
    screenshot,
    click,
    type,
    scroll,
    drag,
    hotkey,
  };
}

const defaultService = createDesktopControlService();

module.exports = {
  createDesktopControlService,
  DESKTOP_CONTROL_TOOLS,
  DESKTOP_CONTROL_ACTIONS,
  getDesktopControlStatus: (...args) => defaultService.status(...args),
  getDesktopControlPreferences: (...args) => defaultService.preferences(...args),
  setDesktopControlPreferences: (...args) => defaultService.setPreferences(...args),
  addDesktopAlwaysAllowApp: (...args) => defaultService.addAlwaysAllow(...args),
  removeDesktopAlwaysAllowApp: (...args) => defaultService.removeAlwaysAllow(...args),
  getDesktopPermissionStatus: (...args) => defaultService.permissionStatus(...args),
  openDesktopPermissionSettings: (...args) => defaultService.openPermissionSettings(...args),
  listDesktopActivity: (...args) => defaultService.listActivity(...args),
  clearDesktopActivity: (...args) => defaultService.clearActivity(...args),
  listDesktopInstalledApps: (...args) => defaultService.listInstalledApps(...args),
  listDesktopApps: (...args) => defaultService.listApps(...args),
  listDesktopWindows: (...args) => defaultService.listWindows(...args),
  captureAllowedDesktopSnapshot: (...args) => defaultService.snapshot(...args),
  captureAllowedDesktopScreenshot: (...args) => defaultService.screenshot(...args),
  clickAllowedDesktop: (...args) => defaultService.click(...args),
  typeAllowedDesktop: (...args) => defaultService.type(...args),
  scrollAllowedDesktop: (...args) => defaultService.scroll(...args),
  dragAllowedDesktop: (...args) => defaultService.drag(...args),
  hotkeyAllowedDesktop: (...args) => defaultService.hotkey(...args),
};
