const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-studio-desktop-control-'));
process.env.PI_STUDIO_DB = path.join(temporary, 'studio.sqlite');

const { closeStudioDatabase } = require('../../electron/main/core/studio-db.cjs');
const {
  getDesktopControlPreferences,
  setDesktopControlPreferences,
  decideDesktopAccess,
  assertDesktopEnabled,
  assertDesktopAppAllowed,
  addAlwaysAllowApp,
  removeAlwaysAllowApp,
  isBlockedApp,
  normalizePreferences,
  matchesEntry,
} = require('../../electron/main/services/desktop-control/policy.cjs');
const {
  getDesktopPermissionStatus,
  assertDesktopPermissions,
} = require('../../electron/main/services/desktop-control/permissions.cjs');
const { createDesktopControlService } = require('../../electron/main/services/desktop-control/index.cjs');

test.after(() => {
  closeStudioDatabase();
  fs.rmSync(temporary, { recursive: true, force: true });
});

test('desktop control defaults stay off', () => {
  const preferences = getDesktopControlPreferences();
  assert.equal(preferences.enabled, false);
  assert.equal(preferences.allowAnyApp, false);
  assert.deepEqual(preferences.alwaysAllow, []);
  assert.throws(
    () => assertDesktopEnabled(),
    (error) => error && error.code === 'desktop_disabled',
  );
});

test('normalize recovers bad payloads', () => {
  const preferences = normalizePreferences({
    enabled: 'true',
    allowAnyApp: 0,
    alwaysAllow: [
      { name: 'Notes', path: '/Applications/Notes.app', bundleId: 'com.apple.Notes' },
      { name: 'Notes', path: '/Applications/Notes.app', bundleId: 'com.apple.Notes' },
      null,
      { foo: 'bar' },
    ],
  });
  assert.equal(preferences.enabled, true);
  assert.equal(preferences.allowAnyApp, false);
  assert.equal(preferences.alwaysAllow.length, 1);
  assert.equal(preferences.alwaysAllow[0].bundleId, 'com.apple.Notes');
});

test('blocked apps never allow even with allowAnyApp', () => {
  setDesktopControlPreferences({ enabled: true, allowAnyApp: true, alwaysAllow: [] });
  const self = { name: 'Pi Studio', bundleId: 'com.example.pi-studio', path: '/Apps/Pi Studio.app' };
  assert.equal(isBlockedApp({ name: 'Terminal' }, self), true);
  assert.equal(isBlockedApp({ name: 'iTerm2', bundleId: 'com.googlecode.iterm2' }, self), true);
  assert.equal(isBlockedApp({ name: 'SecurityAgent', bundleId: 'com.apple.SecurityAgent' }, self), true);
  assert.equal(isBlockedApp(self, self), true);

  const denied = decideDesktopAccess({ name: 'Terminal' }, { self });
  assert.equal(denied.decision, 'deny');
  assert.equal(denied.code, 'desktop_blocked');

  const notes = decideDesktopAccess(
    { name: 'Notes', bundleId: 'com.apple.Notes', path: '/Applications/Notes.app' },
    { self },
  );
  assert.equal(notes.decision, 'allow');
});

test('always allow list is required unless allowAnyApp is on', () => {
  setDesktopControlPreferences({ enabled: true, allowAnyApp: false, alwaysAllow: [] });
  const target = { name: 'Notes', bundleId: 'com.apple.Notes', path: '/Applications/Notes.app' };
  const needs = decideDesktopAccess(target);
  assert.equal(needs.decision, 'needs_approval');
  assert.equal(needs.code, 'desktop_needs_approval');
  assert.throws(
    () => assertDesktopAppAllowed(target),
    (error) => error && error.code === 'desktop_needs_approval',
  );

  addAlwaysAllowApp(target);
  assert.doesNotThrow(() => assertDesktopAppAllowed(target));
  const allowed = getDesktopControlPreferences().alwaysAllow;
  assert.equal(allowed.length, 1);
  removeAlwaysAllowApp(allowed[0].id);
  assert.equal(getDesktopControlPreferences().alwaysAllow.length, 0);
});

test('bundle id mismatch does not match by display name', () => {
  const notes = { name: 'Notes', bundleId: 'com.apple.Notes', path: '/Applications/Notes.app' };
  const impostor = { name: 'Notes', bundleId: 'com.example.FakeNotes', path: '/Applications/FakeNotes.app' };
  assert.equal(matchesEntry(impostor, notes), false);
  assert.equal(matchesEntry(notes, notes), true);

  // Name-only fallback when both lack bundle id.
  assert.equal(
    matchesEntry({ name: 'Notes' }, { name: 'Notes', path: '' }),
    true,
  );
});

test('password and system settings apps stay blocked', () => {
  setDesktopControlPreferences({ enabled: true, allowAnyApp: true, alwaysAllow: [] });
  assert.equal(isBlockedApp({ name: '1Password', bundleId: 'com.1password.1password' }), true);
  assert.equal(isBlockedApp({ name: 'Passwords', bundleId: 'com.apple.Passwords' }), true);
  assert.equal(isBlockedApp({ name: 'System Settings', bundleId: 'com.apple.systempreferences' }), true);
  const denied = decideDesktopAccess({ name: 'Bitwarden', bundleId: 'com.bitwarden.desktop' });
  assert.equal(denied.decision, 'deny');
  assert.equal(denied.code, 'desktop_blocked');
});

test('permission checks use the native helper’s screen and accessibility status', async () => {
  const missing = await getDesktopPermissionStatus({
    platform: 'darwin',
    helperClient: { getPermissions: async () => ({ screenRecording: 'denied', accessibility: false }) },
  });
  assert.equal(missing.ready, false);
  assert.equal(missing.screenRecording, 'denied');
  assert.equal(missing.accessibility, false);

  const ready = await getDesktopPermissionStatus({
    platform: 'darwin',
    helperClient: { getPermissions: async () => ({ screenRecording: 'granted', accessibility: true }) },
  });
  assert.equal(ready.ready, true);
  assert.equal(ready.screenRecording, 'granted');

  await assert.doesNotReject(() => assertDesktopPermissions('snapshot', {
    platform: 'darwin',
    helperClient: { getPermissions: async () => ({ screenRecording: 'granted', accessibility: true }) },
  }));

  await assert.rejects(
    () => assertDesktopPermissions('screenshot', {
      platform: 'darwin',
      helperClient: { getPermissions: async () => ({ screenRecording: 'denied', accessibility: true }) },
    }),
    (error) => error && error.code === 'desktop_screen_permission',
  );
});

test('service gates apps and refuses screenshot without window id', async () => {
  setDesktopControlPreferences({
    enabled: true,
    allowAnyApp: false,
    alwaysAllow: [{ name: 'Notes', bundleId: 'com.apple.Notes', path: '/Applications/Notes.app' }],
  });

  const service = createDesktopControlService({
    platform: 'darwin',
    helperClient: { getPermissions: async () => ({ screenRecording: 'granted', accessibility: true }) },
    listRunningApps: async () => ([
      { name: 'Notes', bundleId: 'com.apple.Notes', path: '/Applications/Notes.app' },
      { name: 'Terminal', bundleId: 'com.apple.Terminal', path: '/System/Applications/Utilities/Terminal.app' },
      { name: 'Safari', bundleId: 'com.apple.Safari', path: '/Applications/Safari.app' },
    ]),
    listWindows: async (app) => {
      if (app.name !== 'Notes') return [];
      return [{ id: '42', windowId: 42, title: 'Shopping', index: 1, appName: 'Notes' }];
    },
    captureSnapshot: async () => ({
      appName: 'Notes',
      windowId: 42,
      title: 'Shopping',
      nodes: [{ ref: 'n1', role: 'AXStaticText', name: 'Milk', value: '', description: '', depth: 1 }],
      truncated: false,
      nodeCount: 1,
    }),
    captureScreenshot: async () => ({
      mimeType: 'image/png',
      data: Buffer.from('png').toString('base64'),
      windowId: 42,
      appName: 'Notes',
      bytes: 3,
    }),
  });

  const apps = await service.listApps();
  const notes = apps.find((row) => row.name === 'Notes');
  const terminal = apps.find((row) => row.name === 'Terminal');
  const safari = apps.find((row) => row.name === 'Safari');
  assert.equal(notes.allowed, true);
  assert.equal(terminal.blocked, true);
  assert.equal(safari.needsApproval, true);

  const windows = await service.listWindows();
  assert.equal(windows.windows.length, 1);
  assert.equal(windows.windows[0].windowId, 42);
  assert.ok(windows.skipped.some((row) => row.name === 'Safari'));

  const snapshot = await service.snapshot({ appName: 'Notes', windowId: 42 });
  assert.equal(snapshot.nodeCount, 1);

  await assert.rejects(
    () => service.screenshot({ appName: 'Notes' }),
    (error) => error && error.code === 'desktop_window_required',
  );

  const shot = await service.screenshot({ appName: 'Notes', windowId: 42 });
  assert.equal(shot.windowId, 42);
  assert.equal(shot.mimeType, 'image/png');
});

test('screenshot refuses window ids that do not belong to the allowed app', async () => {
  setDesktopControlPreferences({
    enabled: true,
    allowAnyApp: false,
    alwaysAllow: [{ name: 'Notes', bundleId: 'com.apple.Notes', path: '/Applications/Notes.app' }],
  });

  const service = createDesktopControlService({
    platform: 'darwin',
    helperClient: { getPermissions: async () => ({ screenRecording: 'granted', accessibility: true }) },
    listRunningApps: async () => ([
      { name: 'Notes', bundleId: 'com.apple.Notes', path: '/Applications/Notes.app' },
      { name: 'Terminal', bundleId: 'com.apple.Terminal', path: '/System/Applications/Utilities/Terminal.app' },
    ]),
    listWindows: async (app) => {
      if (app.name === 'Notes') {
        return [{ id: '42', windowId: 42, title: 'Shopping', index: 1, appName: 'Notes' }];
      }
      return [{ id: '99', windowId: 99, title: 'Shell', index: 1, appName: 'Terminal' }];
    },
    captureScreenshot: async () => {
      throw new Error('should not capture mismatched window');
    },
  });

  await assert.rejects(
    () => service.screenshot({ appName: 'Notes', windowId: 99 }),
    (error) => error && error.code === 'desktop_window_mismatch',
  );

  await assert.rejects(
    () => service.snapshot({ appName: 'Notes', windowId: 99 }),
    (error) => error && error.code === 'desktop_window_mismatch',
  );
});

test('listApps works without accessibility; listWindows batches allowed apps', async () => {
  setDesktopControlPreferences({
    enabled: true,
    allowAnyApp: false,
    alwaysAllow: [
      { name: 'Notes', bundleId: 'com.apple.Notes', path: '/Applications/Notes.app' },
      { name: 'Safari', bundleId: 'com.apple.Safari', path: '/Applications/Safari.app' },
    ],
  });

  let listWindowsCalls = 0;
  const service = createDesktopControlService({
    platform: 'darwin',
    helperClient: { getPermissions: async () => ({ screenRecording: 'granted', accessibility: false }) },
    listRunningApps: async () => ([
      { name: 'Notes', bundleId: 'com.apple.Notes', path: '/Applications/Notes.app' },
      { name: 'Safari', bundleId: 'com.apple.Safari', path: '/Applications/Safari.app' },
      { name: 'Mail', bundleId: 'com.apple.mail', path: '/System/Applications/Mail.app' },
    ]),
    listWindows: async (app) => {
      listWindowsCalls += 1;
      if (app.name === 'Notes') return [{ id: '1', windowId: 1, title: 'N', index: 1, appName: 'Notes' }];
      if (app.name === 'Safari') return [{ id: '2', windowId: 2, title: 'S', index: 1, appName: 'Safari' }];
      return [{ id: '3', windowId: 3, title: 'M', index: 1, appName: 'Mail' }];
    },
    listInstalledApps: () => ([
      { name: 'Mail', path: '/System/Applications/Mail.app', bundleId: 'com.apple.mail' },
      { name: 'Notes', path: '/Applications/Notes.app', bundleId: 'com.apple.Notes' },
      { name: 'Calculator', path: '/System/Applications/Calculator.app', bundleId: 'com.apple.calculator' },
    ]),
    applicationIcon: () => 'data:image/png;base64,aaa',
  });

  const apps = await service.listApps();
  assert.equal(apps.length, 3);
  assert.equal(apps.find((row) => row.name === 'Notes')?.allowed, true);
  assert.equal(apps.find((row) => row.name === 'Mail')?.needsApproval, true);

  // With injected listWindows, batch still walks allowed apps only.
  const withAx = createDesktopControlService({
    platform: 'darwin',
    helperClient: { getPermissions: async () => ({ screenRecording: 'granted', accessibility: true }) },
    listRunningApps: async () => ([
      { name: 'Notes', bundleId: 'com.apple.Notes', path: '/Applications/Notes.app' },
      { name: 'Safari', bundleId: 'com.apple.Safari', path: '/Applications/Safari.app' },
      { name: 'Mail', bundleId: 'com.apple.mail', path: '/System/Applications/Mail.app' },
    ]),
    listWindows: async (app) => {
      listWindowsCalls += 1;
      if (app.name === 'Notes') return [{ id: '1', windowId: 1, title: 'N', index: 1, appName: 'Notes' }];
      if (app.name === 'Safari') return [{ id: '2', windowId: 2, title: 'S', index: 1, appName: 'Safari' }];
      return [{ id: '3', windowId: 3, title: 'M', index: 1, appName: 'Mail' }];
    },
  });

  listWindowsCalls = 0;
  const windows = await withAx.listWindows();
  assert.equal(windows.windows.length, 2);
  assert.ok(windows.windows.every((row) => row.appName === 'Notes' || row.appName === 'Safari'));
  assert.ok(windows.skipped.some((row) => row.name === 'Mail'));
  assert.equal(listWindowsCalls, 2);

  const installed = await service.listInstalledApps();
  const firstNonRunning = installed.findIndex((row) => !row.running);
  assert.ok(firstNonRunning > 0, 'running apps should sort before idle apps');
  assert.ok(installed.slice(0, firstNonRunning).every((row) => row.running));
  assert.ok(installed.some((row) => row.name === 'Notes' && row.running));
  assert.ok(installed.some((row) => row.name === 'Calculator' && !row.running));
  assert.ok(installed.find((row) => row.name === 'Notes')?.icon);
});

test('activity log records metadata and screenshot rejects minimized windows', async () => {
  setDesktopControlPreferences({
    enabled: true,
    allowAnyApp: false,
    alwaysAllow: [{ name: 'Notes', bundleId: 'com.apple.Notes', path: '/Applications/Notes.app' }],
  });

  const service = createDesktopControlService({
    platform: 'darwin',
    helperClient: { getPermissions: async () => ({ screenRecording: 'granted', accessibility: true }) },
    listRunningApps: async () => ([
      { name: 'Notes', bundleId: 'com.apple.Notes', path: '/Applications/Notes.app' },
    ]),
    listWindows: async () => ([
      { id: '7', windowId: 7, title: 'Hidden note', index: 1, appName: 'Notes', minimized: true, visible: false },
      { id: '8', windowId: 8, title: 'Open note', index: 2, appName: 'Notes', minimized: false, visible: true },
    ]),
    captureScreenshot: async (_app, options) => ({
      mimeType: 'image/png',
      data: Buffer.from('png').toString('base64'),
      windowId: options.windowId,
      appName: 'Notes',
      bytes: 3,
    }),
  });

  service.clearActivity();

  await assert.rejects(
    () => service.screenshot({ appName: 'Notes', windowId: 7 }),
    (error) => error && error.code === 'desktop_window_not_visible',
  );

  const shot = await service.screenshot({ appName: 'Notes', windowId: 8 });
  assert.equal(shot.windowId, 8);

  const activity = service.listActivity();
  assert.ok(activity.length >= 2);
  assert.equal(activity[0].tool, 'desktop_screenshot');
  assert.equal(activity[0].ok, true);
  assert.equal(activity[0].windowId, 8);
  assert.ok(!('data' in activity[0]));
  assert.ok(activity.some((row) => row.ok === false && row.code === 'desktop_window_not_visible'));

  const status = await service.status();
  assert.ok(Array.isArray(status.activity));
  assert.ok(status.activity.length >= 1);

  service.clearActivity();
  assert.equal(service.listActivity().length, 0);
});

test('macOS records actual keyboard denial, stops later keyboard batches, and rechecks after refresh', async () => {
  const target = { name: 'Notes', bundleId: 'com.apple.Notes', path: '/Applications/Notes.app' };
  setDesktopControlPreferences({ enabled: true, allowAnyApp: false, alwaysAllow: [target] });
  const window = { windowId: 7, visible: true, bounds: { x: 0, y: 0, width: 800, height: 600 } };
  let attempts = 0;
  let clicks = 0;
  let allowKey = false;
  const service = createDesktopControlService({
    platform: 'darwin',
    helperClient: { getPermissions: async () => ({ screenRecording: 'granted', accessibility: true }) },
    listRunningApps: async () => [target],
    listWindows: async () => [window],
    getWindowFrame: async () => window,
    getFocusedNode: async () => ({ role: 'AXTextField' }),
    click: async () => { clicks++; return { ok: true }; },
    showOverlay: () => {},
    hotkey: async () => {
      attempts++;
      if (!allowKey) throw new Error('“osascript”不允许发送按键。 (1002)');
      return { ok: true, chord: 'command+f' };
    },
  });
  const query = { appName: 'Notes', windowId: 7 };
  assert.equal((await service.permissionStatus()).keyboardInput, 'unverified');
  const batch = await service.act({ ...query, actions: [{ type: 'hotkey', key: 'f', modifiers: ['cmd'] }], screenshot: false });
  assert.equal(batch.failedStep.code, 'desktop_keyboard_permission');
  const denied = await service.permissionStatus();
  assert.equal(denied.keyboardInput, 'denied');
  assert.equal(denied.ready, false);
  assert.match(denied.message, /System Events.*1002/);
  assert.equal(denied.accessibility, true);
  await assert.doesNotReject(() => service.listWindows({ appName: 'Notes' }));
  await assert.rejects(() => service.type({ ...query, text: 'wx' }), { code: 'desktop_keyboard_permission' });
  await assert.rejects(() => service.act({
    ...query, actions: [{ type: 'click', rx: 20, ry: 20 }, { type: 'type', text: 'wx' }], screenshot: false,
  }), { code: 'desktop_keyboard_permission' });
  assert.equal(clicks, 0);
  assert.equal(attempts, 1);
  allowKey = true;
  assert.equal((await service.permissionStatus({ refresh: true })).keyboardInput, 'unverified');
  await service.hotkey({ ...query, key: 'f', modifiers: ['cmd'] });
  assert.equal((await service.permissionStatus()).keyboardInput, 'available');
  assert.equal(attempts, 2);
});

test('macOS launches and scales locally while the helper captures only the target window', async () => {
  const target = { name: 'Notes', bundleId: 'com.apple.Notes', path: '/Applications/Notes.app' };
  setDesktopControlPreferences({ enabled: true, allowAnyApp: false, alwaysAllow: [target] });
  let running = false;
  const localCommands = [];
  const helperCommands = [];
  const service = createDesktopControlService({
    platform: 'darwin',
    helperClient: {
      getPermissions: async () => ({ screenRecording: 'granted', accessibility: true }),
      exec: async (cmd, args) => {
        helperCommands.push(cmd);
        assert.equal(cmd, '/usr/sbin/screencapture');
        assert.deepEqual(args.slice(0, -1), ['-x', '-o', '-l', '7']);
        fs.writeFileSync(args.at(-1), Buffer.alloc(1024 * 1024));
      },
    },
    localRunner: async (cmd, args) => {
      localCommands.push(cmd);
      if (cmd === '/usr/bin/open') {
        assert.deepEqual(args, ['-g', '-a', target.path]);
        running = true;
      } else {
        assert.equal(cmd, '/usr/bin/sips');
        fs.writeFileSync(args.at(-1), Buffer.from('resized fixture'));
      }
    },
    listInstalledApps: () => [target],
    listWindows: async () => running ? [{ windowId: 7, visible: true }] : [],
  });
  const result = await service.launch({ appName: 'Notes', screenshot: true });
  assert.equal(result.windowId, 7);
  assert.equal(result.screenshot.scaled, true);
  assert.deepEqual(localCommands, ['/usr/bin/open', '/usr/bin/sips']);
  assert.deepEqual(helperCommands, ['/usr/sbin/screencapture']);
});

test('desktop_act only waits to settle for a requested screenshot with a positive delay', async (t) => {
  const target = { name: 'Notes', bundleId: 'com.apple.Notes', path: '/Applications/Notes.app' };
  const window = { windowId: 7, visible: true };
  setDesktopControlPreferences({ enabled: true, allowAnyApp: false, alwaysAllow: [target] });
  const service = createDesktopControlService({
    platform: 'darwin',
    helperClient: { getPermissions: async () => ({ screenRecording: 'granted', accessibility: true }) },
    listRunningApps: async () => [target],
    listWindows: async () => [window],
    getWindowFrame: async () => window,
    hotkey: async () => ({ ok: true }),
    captureScreenshot: async () => ({ windowId: 7, data: Buffer.from('image').toString('base64') }),
  });
  const delays = [];
  t.mock.method(globalThis, 'setTimeout', (callback, ms) => {
    delays.push(ms);
    return setImmediate(callback);
  });
  const batch = { appName: 'Notes', windowId: 7, actions: [{ type: 'hotkey', key: 'f', modifiers: ['cmd'] }] };
  assert.equal((await service.act({ ...batch, screenshot: false })).ok, true);
  assert.equal((await service.act({ ...batch, screenshot: true, settleMs: 0 })).screenshot.windowId, 7);
  assert.deepEqual(delays, []);
  assert.equal((await service.act({ ...batch, screenshot: true })).screenshot.windowId, 7);
  assert.deepEqual(delays, [260]);
});

test('status exposes setup todos via activity-aware payload shape', async () => {
  setDesktopControlPreferences({
    enabled: false,
    allowAnyApp: false,
    alwaysAllow: [],
  });
  const service = createDesktopControlService({
    platform: 'darwin',
    helperClient: { getPermissions: async () => ({ screenRecording: 'denied', accessibility: false }) },
  });
  const status = await service.status();
  assert.equal(status.enabled, false);
  assert.equal(status.ready, false);
  assert.ok(Array.isArray(status.activity));
  assert.ok(Array.isArray(status.actions));
  assert.ok(status.actions.includes('click'));
  assert.ok(status.actions.includes('hotkey'));
  assert.ok(Array.isArray(status.tools));
  assert.ok(status.tools.includes('desktop_hotkey'));
  assert.ok(status.tools.includes('desktop_snapshot'));

  // Mimic tool formatter expectations used by desktop_status.
  const missing = [];
  if (!status.enabled) missing.push('enable master switch');
  if (!status.permission.accessibility) missing.push('grant Accessibility');
  if (status.permission.screenRecording !== 'granted') missing.push('grant Screen Recording');
  if (!status.allowAnyApp && !(status.alwaysAllowCount > 0)) missing.push('add always-allow app (or enable allowAnyApp)');
  assert.ok(missing.includes('enable master switch'));
  assert.ok(missing.includes('grant Accessibility'));
  assert.ok(missing.includes('grant Screen Recording'));
  assert.ok(missing.includes('add always-allow app (or enable allowAnyApp)'));
});

test('click requires window ownership and stays inside window bounds', async () => {
  setDesktopControlPreferences({
    enabled: true,
    allowAnyApp: false,
    alwaysAllow: [{ name: 'Notes', bundleId: 'com.apple.Notes', path: '/Applications/Notes.app' }],
  });

  const clicks = [];
  const service = createDesktopControlService({
    platform: 'darwin',
    helperClient: { getPermissions: async () => ({ screenRecording: 'granted', accessibility: true }) },
    listRunningApps: async () => ([
      { name: 'Notes', bundleId: 'com.apple.Notes', path: '/Applications/Notes.app' },
    ]),
    listWindows: async () => ([
      { id: '10', windowId: 10, title: 'Note', index: 1, appName: 'Notes', minimized: false, visible: true },
    ]),
    getWindowFrame: async () => ({ x: 100, y: 100, width: 400, height: 300 }),
    resolveNode: async () => ({
      ref: 'n3',
      path: '1/2/1',
      role: 'AXButton',
      name: 'Save',
      secure: false,
      bounds: { x: 140, y: 160, width: 80, height: 24 },
    }),
    click: async (app, options) => {
      clicks.push({ app, options });
      return {
        ok: true,
        appName: app.name,
        bundleId: app.bundleId,
        windowId: options.windowId,
        title: 'Note',
        x: 180,
        y: 172,
        button: 'left',
        ref: options.ref || '',
        path: options.path || '',
        role: 'AXButton',
        name: 'Save',
        mode: options.ref ? 'ref' : 'point',
      };
    },
  });

  service.clearActivity();

  const byRef = await service.click({ appName: 'Notes', windowId: 10, ref: 'n3' });
  assert.equal(byRef.ok, true);
  assert.equal(byRef.ref, 'n3');
  assert.equal(clicks.length, 1);

  await assert.rejects(
    () => service.click({ appName: 'Notes', windowId: 10, x: 10, y: 10 }),
    (error) => error && error.code === 'desktop_point_outside_window',
  );

  const serviceCoords = createDesktopControlService({
    platform: 'darwin',
    helperClient: { getPermissions: async () => ({ screenRecording: 'granted', accessibility: true }) },
    listRunningApps: async () => ([
      { name: 'Notes', bundleId: 'com.apple.Notes', path: '/Applications/Notes.app' },
    ]),
    listWindows: async () => ([
      { id: '10', windowId: 10, title: 'Note', index: 1, appName: 'Notes', minimized: false, visible: true },
    ]),
    getWindowFrame: async () => ({ x: 100, y: 100, width: 400, height: 300 }),
    click: async (app, options) => ({
      ok: true,
      appName: app.name,
      bundleId: app.bundleId,
      windowId: options.windowId,
      title: 'Note',
      x: options.x,
      y: options.y,
      button: 'left',
      ref: '',
      path: '',
      role: '',
      name: '',
      mode: 'point',
    }),
  });

  await assert.rejects(
    () => serviceCoords.click({ appName: 'Notes', windowId: 10, x: 10, y: 10 }),
    (error) => error && error.code === 'desktop_point_outside_window',
  );

  const inside = await serviceCoords.click({
    appName: 'Notes',
    windowId: 10,
    x: 150,
    y: 150,
  });
  assert.equal(inside.ok, true);
  assert.equal(inside.x, 150);
  assert.equal(inside.y, 150);

  const activity = service.listActivity();
  assert.ok(activity.some((row) => row.tool === 'desktop_click' && row.ok === true));
});

test('desktop_type validates text and never logs body', async () => {
  const { normalizeTypeText, DEFAULT_MAX_TYPE_CHARS } = require('../../electron/main/services/desktop-control/act.cjs');

  assert.equal(normalizeTypeText('hello'), 'hello');
  assert.throws(
    () => normalizeTypeText(''),
    (error) => error && error.code === 'desktop_type_empty',
  );
  assert.throws(
    () => normalizeTypeText('a'.repeat(DEFAULT_MAX_TYPE_CHARS + 1)),
    (error) => error && error.code === 'desktop_type_too_long',
  );
  assert.throws(
    () => normalizeTypeText('bad\u0000text'),
    (error) => error && error.code === 'desktop_type_invalid',
  );

  setDesktopControlPreferences({
    enabled: true,
    allowAnyApp: false,
    alwaysAllow: [{ name: 'Notes', bundleId: 'com.apple.Notes', path: '/Applications/Notes.app' }],
  });

  const typed = [];
  const service = createDesktopControlService({
    platform: 'darwin',
    helperClient: { getPermissions: async () => ({ screenRecording: 'granted', accessibility: true }) },
    listRunningApps: async () => ([
      { name: 'Notes', bundleId: 'com.apple.Notes', path: '/Applications/Notes.app' },
    ]),
    listWindows: async () => ([
      { id: '10', windowId: 10, title: 'Note', index: 1, appName: 'Notes', minimized: false, visible: true },
    ]),
    getWindowFrame: async () => ({ x: 100, y: 100, width: 400, height: 300, title: 'Note' }),
    getFocusedNode: async () => ({
      ref: 'n7',
      path: '1/1',
      role: 'AXTextField',
      name: 'Title',
      secure: false,
    }),
    type: async (app, options) => {
      typed.push({ app, options });
      return {
        ok: true,
        appName: app.name,
        bundleId: app.bundleId,
        windowId: options.windowId,
        title: 'Note',
        chars: String(options.text || '').length,
        ref: options.focused?.ref || '',
        path: options.focused?.path || '',
        role: options.focused?.role || '',
        name: options.focused?.name || '',
        mode: 'focused',
      };
    },
  });

  service.clearActivity();

  await assert.rejects(
    () => service.type({ appName: 'Notes', windowId: 10, text: '' }),
    (error) => error && error.code === 'desktop_type_empty',
  );

  const secretService = createDesktopControlService({
    platform: 'darwin',
    helperClient: { getPermissions: async () => ({ screenRecording: 'granted', accessibility: true }) },
    listRunningApps: async () => ([
      { name: 'Notes', bundleId: 'com.apple.Notes', path: '/Applications/Notes.app' },
    ]),
    listWindows: async () => ([
      { id: '10', windowId: 10, title: 'Login', index: 1, appName: 'Notes', minimized: false, visible: true },
    ]),
    getWindowFrame: async () => ({ x: 100, y: 100, width: 400, height: 300, title: 'Login' }),
    getFocusedNode: async () => ({
      ref: 'n9',
      path: '1/2',
      role: 'AXTextField',
      name: 'Password',
      secure: true,
    }),
    type: async () => {
      throw new Error('should not type into secure field');
    },
  });

  await assert.rejects(
    () => secretService.type({ appName: 'Notes', windowId: 10, text: 'hunter2' }),
    (error) => error && error.code === 'desktop_secure_target',
  );

  const result = await service.type({
    appName: 'Notes',
    windowId: 10,
    text: 'hello world',
  });
  assert.equal(result.ok, true);
  assert.equal(result.chars, 11);
  assert.equal(result.ref, 'n7');
  assert.equal(typed.length, 1);
  assert.equal(typed[0].options.text, 'hello world');

  const activity = service.listActivity();
  const typeRows = activity.filter((row) => row.tool === 'desktop_type');
  assert.ok(typeRows.some((row) => row.ok === true));
  assert.ok(typeRows.every((row) => !String(row.detail || '').includes('hello world')));
  assert.ok(typeRows.every((row) => !String(JSON.stringify(row)).includes('hello world')));
  assert.ok(typeRows.some((row) => String(row.detail || '').includes('11 chars')));
});

test('desktop_scroll validates delta and stays inside window', async () => {
  const {
    normalizeScrollDelta,
    MAX_SCROLL_AMOUNT,
  } = require('../../electron/main/services/desktop-control/act.cjs');

  assert.deepEqual(normalizeScrollDelta({ direction: 'down' }), {
    dx: 0,
    dy: -3,
    direction: 'down',
    amount: 3,
  });
  assert.equal(normalizeScrollDelta({ direction: 'up', amount: 5 }).dy, 5);
  assert.equal(normalizeScrollDelta({ dx: 2, dy: -1 }).dx, 2);
  assert.throws(
    () => normalizeScrollDelta({ direction: 'sideways' }),
    (error) => error && error.code === 'desktop_scroll_invalid',
  );
  assert.throws(
    () => normalizeScrollDelta({ amount: MAX_SCROLL_AMOUNT + 1 }),
    (error) => error && error.code === 'desktop_scroll_too_large',
  );
  assert.throws(
    () => normalizeScrollDelta({ dx: 0, dy: 0 }),
    (error) => error && error.code === 'desktop_scroll_invalid',
  );

  setDesktopControlPreferences({
    enabled: true,
    allowAnyApp: false,
    alwaysAllow: [{ name: 'Notes', bundleId: 'com.apple.Notes', path: '/Applications/Notes.app' }],
  });

  const scrolls = [];
  const service = createDesktopControlService({
    platform: 'darwin',
    helperClient: { getPermissions: async () => ({ screenRecording: 'granted', accessibility: true }) },
    listRunningApps: async () => ([
      { name: 'Notes', bundleId: 'com.apple.Notes', path: '/Applications/Notes.app' },
    ]),
    listWindows: async () => ([
      { id: '10', windowId: 10, title: 'Note', index: 1, appName: 'Notes', minimized: false, visible: true },
    ]),
    getWindowFrame: async () => ({ x: 100, y: 100, width: 400, height: 300, title: 'Note' }),
    resolveNode: async () => ({
      ref: 'n4',
      path: '1/3',
      role: 'AXScrollArea',
      name: 'Body',
      secure: false,
      bounds: { x: 120, y: 140, width: 200, height: 180 },
    }),
    scroll: async (app, options) => {
      scrolls.push({ app, options });
      return {
        ok: true,
        appName: app.name,
        bundleId: app.bundleId,
        windowId: options.windowId,
        title: 'Note',
        x: options.x,
        y: options.y,
        dx: options.dx,
        dy: options.dy,
        direction: options.direction,
        amount: options.amount,
        ref: options.ref || '',
        path: options.path || '',
        role: '',
        name: '',
        mode: options.ref ? 'ref' : 'window',
      };
    },
  });

  service.clearActivity();

  await assert.rejects(
    () => service.scroll({ appName: 'Notes', windowId: 10, x: 10, y: 10, direction: 'down' }),
    (error) => error && error.code === 'desktop_point_outside_window',
  );

  const byWindow = await service.scroll({
    appName: 'Notes',
    windowId: 10,
    direction: 'down',
    amount: 4,
  });
  assert.equal(byWindow.ok, true);
  assert.equal(byWindow.direction, 'down');
  assert.equal(byWindow.amount, 4);
  assert.equal(byWindow.dy, -4);
  // Window center of 100,100,400x300 => 300,250
  assert.equal(byWindow.x, 300);
  assert.equal(byWindow.y, 250);

  const byRef = await service.scroll({
    appName: 'Notes',
    windowId: 10,
    ref: 'n4',
    direction: 'up',
    amount: 2,
  });
  assert.equal(byRef.ok, true);
  assert.equal(byRef.ref, 'n4');
  assert.equal(scrolls.length >= 2, true);

  const activity = service.listActivity();
  assert.ok(activity.some((row) => row.tool === 'desktop_scroll' && row.ok === true));
  assert.ok(activity.some((row) => String(row.detail || '').includes('scroll')));
});

test('desktop_drag requires in-window endpoints and records metadata only', async () => {
  const {
    normalizeDragSteps,
    MAX_DRAG_STEPS,
  } = require('../../electron/main/services/desktop-control/act.cjs');

  assert.equal(normalizeDragSteps(undefined), 12);
  assert.throws(
    () => normalizeDragSteps(0),
    (error) => error && error.code === 'desktop_drag_invalid',
  );
  assert.throws(
    () => normalizeDragSteps(MAX_DRAG_STEPS + 1),
    (error) => error && error.code === 'desktop_drag_invalid',
  );

  setDesktopControlPreferences({
    enabled: true,
    allowAnyApp: false,
    alwaysAllow: [{ name: 'Notes', bundleId: 'com.apple.Notes', path: '/Applications/Notes.app' }],
  });

  const drags = [];
  const service = createDesktopControlService({
    platform: 'darwin',
    helperClient: { getPermissions: async () => ({ screenRecording: 'granted', accessibility: true }) },
    listRunningApps: async () => ([
      { name: 'Notes', bundleId: 'com.apple.Notes', path: '/Applications/Notes.app' },
    ]),
    listWindows: async () => ([
      { id: '10', windowId: 10, title: 'Note', index: 1, appName: 'Notes', minimized: false, visible: true },
    ]),
    getWindowFrame: async () => ({ x: 100, y: 100, width: 400, height: 300, title: 'Note' }),
    resolveNode: async (_app, options) => {
      if (options.ref === 'n1') {
        return {
          ref: 'n1',
          path: '1/1',
          role: 'AXButton',
          name: 'Item',
          secure: false,
          bounds: { x: 120, y: 140, width: 40, height: 20 },
        };
      }
      if (options.ref === 'n2') {
        return {
          ref: 'n2',
          path: '1/2',
          role: 'AXGroup',
          name: 'Drop',
          secure: false,
          bounds: { x: 300, y: 220, width: 60, height: 40 },
        };
      }
      if (options.ref === 'sec') {
        return {
          ref: 'sec',
          path: '1/9',
          role: 'AXTextField',
          name: 'Password',
          secure: true,
          bounds: { x: 150, y: 160, width: 80, height: 24 },
        };
      }
      return null;
    },
    drag: async (app, options) => {
      drags.push({ app, options });
      return {
        ok: true,
        appName: app.name,
        bundleId: app.bundleId,
        windowId: options.windowId,
        title: 'Note',
        fromX: options.fromX,
        fromY: options.fromY,
        toX: options.toX,
        toY: options.toY,
        dx: options.toX - options.fromX,
        dy: options.toY - options.fromY,
        distance: Math.round(Math.hypot(options.toX - options.fromX, options.toY - options.fromY)),
        steps: options.steps,
        fromRef: options.start?.ref || '',
        toRef: options.end?.ref || '',
        mode: 'point->point',
      };
    },
  });

  service.clearActivity();

  await assert.rejects(
    () => service.drag({
      appName: 'Notes',
      windowId: 10,
      x: 10,
      y: 10,
      toX: 150,
      toY: 150,
    }),
    (error) => error && error.code === 'desktop_point_outside_window',
  );

  await assert.rejects(
    () => service.drag({
      appName: 'Notes',
      windowId: 10,
      x: 150,
      y: 150,
      toX: 150,
      toY: 150,
    }),
    (error) => error && error.code === 'desktop_drag_too_short',
  );

  await assert.rejects(
    () => service.drag({
      appName: 'Notes',
      windowId: 10,
      ref: 'sec',
      toX: 200,
      toY: 200,
    }),
    (error) => error && error.code === 'desktop_secure_target',
  );

  const byCoords = await service.drag({
    appName: 'Notes',
    windowId: 10,
    x: 150,
    y: 150,
    toX: 250,
    toY: 220,
    steps: 8,
  });
  assert.equal(byCoords.ok, true);
  assert.equal(byCoords.fromX, 150);
  assert.equal(byCoords.toX, 250);
  assert.equal(byCoords.steps, 8);
  assert.equal(drags.length, 1);

  const byRef = await service.drag({
    appName: 'Notes',
    windowId: 10,
    ref: 'n1',
    toRef: 'n2',
  });
  assert.equal(byRef.ok, true);
  assert.equal(byRef.fromRef, 'n1');
  assert.equal(byRef.toRef, 'n2');

  const activity = service.listActivity();
  assert.ok(activity.some((row) => row.tool === 'desktop_drag' && row.ok === true));
  assert.ok(activity.every((row) => row.tool !== 'desktop_drag' || !String(row.detail || '').includes('Password')));
});

test('desktop_hotkey normalizes chords and blocks dangerous system shortcuts', async () => {
  const {
    normalizeHotkey,
  } = require('../../electron/main/services/desktop-control/act.cjs');

  assert.deepEqual(normalizeHotkey({ key: 's', modifiers: ['cmd'] }), {
    key: 's',
    modifiers: ['command'],
    kind: 'char',
    keyCode: null,
    keystroke: 's',
    chord: 'command+s',
  });
  assert.equal(normalizeHotkey({ key: 'cmd+s' }).chord, 'command+s');
  assert.equal(normalizeHotkey({ key: 'enter' }).kind, 'code');
  assert.equal(normalizeHotkey({ key: 'escape' }).keyCode, 53);

  assert.throws(
    () => normalizeHotkey({ key: '' }),
    (error) => error && error.code === 'desktop_hotkey_empty',
  );
  assert.throws(
    () => normalizeHotkey({ key: 'q', modifiers: ['command'] }),
    (error) => error && error.code === 'desktop_hotkey_blocked',
  );
  assert.throws(
    () => normalizeHotkey({ key: 'cmd+q' }),
    (error) => error && error.code === 'desktop_hotkey_blocked',
  );
  assert.throws(
    () => normalizeHotkey({ key: 'tab', modifiers: ['command'] }),
    (error) => error && error.code === 'desktop_hotkey_blocked',
  );
  assert.throws(
    () => normalizeHotkey({ key: 'space', modifiers: ['command'] }),
    (error) => error && error.code === 'desktop_hotkey_blocked',
  );
  assert.throws(
    () => normalizeHotkey({ key: 'escape', modifiers: ['command', 'option'] }),
    (error) => error && error.code === 'desktop_hotkey_blocked',
  );
  // Emoji picker ⌃⌘Space is allowed.
  assert.equal(
    normalizeHotkey({ key: 'space', modifiers: ['control', 'command'] }).chord,
    'control+command+space',
  );

  setDesktopControlPreferences({
    enabled: true,
    allowAnyApp: false,
    alwaysAllow: [{ name: 'Notes', bundleId: 'com.apple.Notes', path: '/Applications/Notes.app' }],
  });

  const pressed = [];
  const service = createDesktopControlService({
    platform: 'darwin',
    helperClient: { getPermissions: async () => ({ screenRecording: 'granted', accessibility: true }) },
    listRunningApps: async () => ([
      { name: 'Notes', bundleId: 'com.apple.Notes', path: '/Applications/Notes.app' },
    ]),
    listWindows: async () => ([
      { id: '10', windowId: 10, title: 'Note', index: 1, appName: 'Notes', minimized: false, visible: true },
    ]),
    getWindowFrame: async () => ({ x: 100, y: 100, width: 400, height: 300, title: 'Note' }),
    hotkey: async (app, options) => {
      pressed.push({ app, options });
      return {
        ok: true,
        appName: app.name,
        bundleId: app.bundleId,
        windowId: options.windowId,
        title: 'Note',
        key: options.key,
        modifiers: options.modifiers,
        chord: options.chord,
      };
    },
  });

  service.clearActivity();

  await assert.rejects(
    () => service.hotkey({ appName: 'Notes', windowId: 10, key: 'cmd+q' }),
    (error) => error && error.code === 'desktop_hotkey_blocked',
  );

  const result = await service.hotkey({
    appName: 'Notes',
    windowId: 10,
    key: 's',
    modifiers: ['command'],
  });
  assert.equal(result.ok, true);
  assert.equal(result.chord, 'command+s');
  assert.equal(pressed.length, 1);

  const activity = service.listActivity();
  assert.ok(activity.some((row) => row.tool === 'desktop_hotkey' && row.ok === true));
  assert.ok(activity.some((row) => String(row.detail || '').includes('command+s')));
});

test('listAppMappings and desktop_launch enforce allowlist, hard-blocks, and localized name matching', async () => {
  setDesktopControlPreferences({
    enabled: true,
    allowAnyApp: false,
    alwaysAllow: [{ name: 'Calculator', bundleId: 'com.apple.calculator', path: '/System/Applications/Calculator.app' }],
  });

  let launched = false;
  const service = createDesktopControlService({
    platform: 'darwin',

    listInstalledApps: () => [
      { name: 'Calculator', displayName: '计算器', bundleId: 'com.apple.calculator', executableName: 'Calculator', path: '/System/Applications/Calculator.app' },
      { name: 'Notes', displayName: '备忘录', bundleId: 'com.apple.Notes', executableName: 'Notes', path: '/System/Applications/Notes.app' },
      { name: 'Terminal', displayName: '终端', bundleId: 'com.apple.Terminal', executableName: 'Terminal', path: '/System/Applications/Utilities/Terminal.app' },
    ],
    listWindows: async (app) => (
      launched && app.bundleId === 'com.apple.calculator'
        ? [{ id: '88', windowId: 88, title: '计算器', appName: '计算器', minimized: false, visible: true }]
        : []
    ),
    launchApp: async () => { launched = true; },
  });

  const mappings = await service.listAppMappings();
  assert.equal(mappings.length, 3);
  assert.equal(mappings.find((m) => m.bundleId === 'com.apple.calculator')?.allowed, true);
  assert.equal(mappings.find((m) => m.bundleId === 'com.apple.Terminal')?.blocked, true);

  // Blocked app refuses even when targeted by Chinese display name.
  await assert.rejects(
    () => service.launch({ appName: '终端' }),
    (error) => error && error.code === 'desktop_blocked',
  );
  // Unallowed app refuses under strict allowlist.
  await assert.rejects(
    () => service.launch({ appName: '备忘录' }),
    (error) => error && error.code === 'desktop_needs_approval',
  );
  // Allowed app launches by Chinese displayName and returns its new windowId.
  const res = await service.launch({ appName: '计算器', waitMs: 500 });
  assert.equal(res.ok, true);
  assert.equal(res.alreadyRunning, false);
  assert.equal(res.bundleId, 'com.apple.calculator');
  assert.equal(res.windowId, 88);
  assert.ok(service.listActivity().some((row) => row.tool === 'desktop_launch' && row.ok === true));
});
