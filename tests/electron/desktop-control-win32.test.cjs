const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-studio-desktop-win32-'));
process.env.PI_STUDIO_DB = path.join(temporary, 'studio.sqlite');

const { closeStudioDatabase } = require('../../electron/main/core/studio-db.cjs');
const {
  SUPPORTED_PLATFORMS,
  isSupportedDesktopPlatform,
  getDesktopPlatformAdapter,
  assertSupportedDesktopPlatform,
  win32Adapter,
} = require('../../electron/main/services/desktop-control/platform/index.cjs');
const {
  setDesktopControlPreferences,
  isBlockedApp,
  normalizeAllowEntry,
} = require('../../electron/main/services/desktop-control/policy.cjs');
const { createDesktopControlService } = require('../../electron/main/services/desktop-control/index.cjs');

test.after(() => {
  closeStudioDatabase();
  fs.rmSync(temporary, { recursive: true, force: true });
});

function createMockWin32Bridge(overrides = {}) {
  const calls = [];
  let launched = false;
  const state = {
    selfElevated: false,
    focusedSecure: false,
    ...overrides,
  };

  const bridge = {
    calls,
    state,
    async request(action, params = {}) {
      calls.push({ action, params });
      if (action === 'ping') {
        if (state.pingError) throw new Error(state.pingError);
        return { pong: true, pid: 4321, elevated: state.selfElevated };
      }
      if (action === 'installed_mappings') {
        return [
          {
            name: 'Notepad',
            displayName: '记事本',
            bundleId: 'notepad.exe',
            executableName: 'notepad.exe',
            path: 'C:\\Windows\\System32\\notepad.exe',
          },
          {
            name: 'SampleApp',
            displayName: '示例应用',
            bundleId: 'sampleapp.exe',
            executableName: 'sampleapp.exe',
            path: 'C:\\Program Files\\Fixtures\\SampleApp\\SampleApp.exe',
          },
          {
            name: 'Windows Terminal',
            displayName: 'Windows 终端',
            bundleId: 'Microsoft.WindowsTerminal_8wekyb3d8bbwe!App',
            executableName: 'WindowsTerminal.exe',
            path: 'shell:AppsFolder\\Microsoft.WindowsTerminal_8wekyb3d8bbwe!App',
          },
          {
            name: 'Windows PowerShell',
            displayName: 'Windows PowerShell',
            bundleId: 'powershell.exe',
            executableName: 'powershell.exe',
            path: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
          },
        ];
      }
      if (action === 'list_windows') {
        const list = [
          {
            windowId: 1001,
            pid: 900,
            title: '示例应用 - 主窗口',
            processName: 'SampleApp',
            exeName: 'SampleApp.exe',
            displayName: '示例应用',
            path: 'C:\\Program Files\\Fixtures\\SampleApp\\SampleApp.exe',
            minimized: false,
            visible: true,
            elevated: false,
            bounds: { x: 1920, y: 120, width: 1200, height: 800 },
          },
          {
            windowId: 1002,
            pid: 901,
            title: 'Admin Tool',
            processName: 'AdminApp',
            exeName: 'AdminApp.exe',
            displayName: 'AdminApp',
            path: 'C:\\Tools\\AdminApp.exe',
            minimized: false,
            visible: true,
            elevated: true,
            bounds: { x: 100, y: 100, width: 800, height: 600 },
          },
          {
            windowId: 1003,
            pid: 902,
            title: 'PowerShell',
            processName: 'powershell',
            exeName: 'powershell.exe',
            displayName: 'Windows PowerShell',
            path: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
            minimized: false,
            visible: true,
            elevated: false,
            bounds: { x: 0, y: 0, width: 900, height: 600 },
          },
          {
            windowId: 1004,
            pid: 903,
            title: '最小化示例应用窗口',
            processName: 'SampleApp',
            exeName: 'SampleApp.exe',
            displayName: '示例应用',
            path: 'C:\\Program Files\\Fixtures\\SampleApp\\SampleApp.exe',
            minimized: true,
            visible: false,
            elevated: false,
            bounds: { x: 0, y: 0, width: 0, height: 0 },
          },
        ];
        if (launched) {
          list.push({
            windowId: 2001,
            pid: 950,
            title: '无标题 - 记事本',
            processName: 'notepad',
            exeName: 'notepad.exe',
            displayName: '记事本',
            path: 'C:\\Windows\\System32\\notepad.exe',
            minimized: false,
            visible: true,
            elevated: false,
            bounds: { x: 200, y: 160, width: 700, height: 500 },
          });
        }
        return list;
      }
      if (action === 'launch') {
        launched = true;
        return { ok: true, launched: params.path || params.bundleId || params.name };
      }
      if (action === 'snapshot') {
        return {
          title: '示例应用 - 主窗口',
          nodes: [
            {
              ref: 'n1',
              role: 'Edit',
              name: '搜索',
              value: 'hello',
              description: '',
              depth: 1,
              path: '0/1',
              bounds: { x: 1960, y: 160, width: 200, height: 32 },
              secure: false,
            },
            {
              ref: 'n2',
              role: 'Edit',
              name: '密码',
              value: 'should-never-leak',
              description: '',
              depth: 1,
              path: '0/2',
              bounds: { x: 1960, y: 220, width: 200, height: 32 },
              secure: true,
            },
            {
              ref: 'n3',
              role: 'Button',
              name: '发送',
              value: '',
              description: '',
              depth: 1,
              path: '0/3',
              bounds: { x: 2900, y: 820, width: 80, height: 32 },
              secure: false,
            },
          ],
          truncated: false,
        };
      }
      if (action === 'screenshot') {
        const png = Buffer.from('win32-png-bytes');
        return { data: png.toString('base64'), bytes: png.length, scaled: false };
      }
      if (action === 'focused') {
        return { secure: state.focusedSecure };
      }
      if (action === 'click' || action === 'type' || action === 'scroll' || action === 'drag' || action === 'hotkey') {
        return { ok: true };
      }
      throw new Error(`unexpected action: ${action}`);
    },
    async stop() {
      calls.push({ action: 'stop', params: {} });
    },
  };
  return bridge;
}

test('platform router supports darwin and win32 and rejects unsupported platforms', () => {
  assert.deepEqual(SUPPORTED_PLATFORMS, ['darwin', 'win32']);
  assert.equal(isSupportedDesktopPlatform('darwin'), true);
  assert.equal(isSupportedDesktopPlatform('win32'), true);
  assert.equal(isSupportedDesktopPlatform('linux'), false);
  assert.equal(getDesktopPlatformAdapter('darwin')?.platform, 'darwin');
  assert.equal(getDesktopPlatformAdapter('win32')?.platform, 'win32');
  assert.equal(getDesktopPlatformAdapter('linux'), null);
  assert.throws(
    () => assertSupportedDesktopPlatform('linux'),
    (err) => err && err.code === 'desktop_unsupported_platform',
  );
});

test('Windows security hard-blocks terminals, UAC, settings, and password managers', () => {
  const self = { name: 'Pi Studio', bundleId: 'pi studio.exe', path: 'C:\\Program Files\\Pi Studio\\Pi Studio.exe' };
  const blockedTargets = [
    { name: 'Windows PowerShell', bundleId: 'powershell.exe' },
    { name: 'PowerShell', bundleId: 'PowerShell.EXE' },
    { name: '命令提示符', bundleId: 'cmd.exe' },
    { name: 'Windows Terminal', bundleId: 'Microsoft.WindowsTerminal_8wekyb3d8bbwe!App' },
    { name: 'User Account Control', bundleId: 'Consent.exe' },
    { name: 'Credential UI', bundleId: 'CredentialUIBroker.exe' },
    { name: 'Lock Screen', bundleId: 'LockApp.exe' },
    { name: 'Task Manager', bundleId: 'taskmgr.exe' },
    { name: 'System Settings', bundleId: 'SystemSettings.exe' },
    { name: 'KeePassXC', bundleId: 'KeePassXC.exe' },
    { name: 'Unknown Wrapper', path: 'C:\\Windows\\System32\\cmd.exe' },
    self,
  ];
  for (const target of blockedTargets) {
    assert.equal(isBlockedApp(target, self), true, `expected blocked: ${JSON.stringify(target)}`);
  }

  assert.equal(
    isBlockedApp({ name: '记事本', bundleId: 'notepad.exe', path: 'C:\\Windows\\System32\\notepad.exe' }, self),
    false,
  );

  const normalizedWinEntry = normalizeAllowEntry({ path: 'C:\\Program Files\\Fixtures\\SampleApp\\SampleApp.exe' });
  assert.equal(normalizedWinEntry?.name, 'SampleApp');
});

test('Windows hotkey normalization maps aliases and blocks dangerous system chords', () => {
  const ctrlS = win32Adapter.normalizeWin32Hotkey({ key: 'cmd+s' });
  assert.equal(ctrlS.key, 's');
  assert.deepEqual(ctrlS.modifiers, ['control']);
  assert.equal(ctrlS.chord, 'control+s');
  assert.equal(ctrlS.keyVk, 0x53);

  const blockedChords = [
    { key: 'alt+f4' },
    { key: 'alt+tab' },
    { key: 'ctrl+alt+delete' },
    { key: 'ctrl+alt+del' },
    { key: 'win+l' },
    { key: 'win+r' },
    { key: 'ctrl+shift+escape' },
    { key: 'ctrl+shift+esc' },
  ];
  for (const chord of blockedChords) {
    assert.throws(
      () => win32Adapter.normalizeWin32Hotkey(chord),
      (err) => err && err.code === 'desktop_hotkey_blocked',
      `expected blocked hotkey: ${JSON.stringify(chord)}`,
    );
  }
});

test('Windows end-to-end service: status, mappings, observe, screenshot, act, launch, and UIPI guard', async () => {
  setDesktopControlPreferences({
    enabled: true,
    allowAnyApp: false,
    alwaysAllow: [
      { name: '示例应用', bundleId: 'sampleapp.exe', path: 'C:\\Program Files\\Fixtures\\SampleApp\\SampleApp.exe' },
      { name: '记事本', bundleId: 'notepad.exe', path: 'C:\\Windows\\System32\\notepad.exe' },
      { name: 'AdminApp', bundleId: 'adminapp.exe', path: 'C:\\Tools\\AdminApp.exe' },
    ],
  });

  const bridge = createMockWin32Bridge();
  const service = createDesktopControlService({
    platform: 'win32',
    win32Bridge: bridge,
  });

  // 1. Status & Permissions
  const status = await service.status();
  assert.equal(status.platform, 'win32');
  assert.equal(status.supported, true);
  assert.equal(status.ready, true);
  assert.equal(status.permission.screenRecording, 'granted');
  assert.equal(status.permission.accessibility, true);

  // 2. Static app mappings (Start Menu / UWP)
  const mappings = await service.listAppMappings({ refresh: true });
  const notepadMap = mappings.find((m) => m.bundleId === 'notepad.exe');
  const terminalMap = mappings.find((m) => m.bundleId.includes('WindowsTerminal'));
  assert.equal(notepadMap?.allowed, true);
  assert.equal(notepadMap?.blocked, false);
  assert.equal(terminalMap?.blocked, true);

  // 3. Running apps & windows
  const apps = await service.listApps();
  assert.equal(apps.find((a) => a.bundleId === 'sampleapp.exe')?.allowed, true);
  assert.equal(apps.find((a) => a.bundleId === 'powershell.exe')?.blocked, true);

  const winRes = await service.listWindows({ appName: '示例应用' });
  assert.equal(winRes.windows.length, 2);
  assert.equal(winRes.windows[0].windowId, 1001);
  assert.equal(winRes.windows[0].bounds.x, 1920); // multi-monitor virtual desktop coordinate preserved

  // 4. Snapshot redacts password field
  const snap = await service.snapshot({ appName: '示例应用', windowId: 1001 });
  assert.equal(snap.nodeCount, 3);
  assert.equal(snap.nodes.find((n) => n.ref === 'n1')?.value, 'hello');
  assert.equal(snap.nodes.find((n) => n.ref === 'n2')?.secure, true);
  assert.equal(snap.nodes.find((n) => n.ref === 'n2')?.value, '');

  // 5. Screenshot succeeds on visible window and refuses minimized window
  const shot = await service.screenshot({ appName: '示例应用', windowId: 1001 });
  assert.equal(shot.mimeType, 'image/png');
  assert.equal(Buffer.from(shot.data, 'base64').toString(), 'win32-png-bytes');

  await assert.rejects(
    () => service.screenshot({ appName: '示例应用', windowId: 1004 }),
    (err) => err && err.code === 'desktop_window_not_visible',
  );

  // 6. Click / Type / Scroll / Drag / Hotkey
  const clickRes = await service.click({ appName: '示例应用', windowId: 1001, ref: 'n3' });
  assert.equal(clickRes.ok, true);
  assert.equal(clickRes.x, 2940);
  assert.equal(clickRes.y, 836);

  await assert.rejects(
    () => service.click({ appName: '示例应用', windowId: 1001, ref: 'n2' }),
    (err) => err && err.code === 'desktop_secure_target',
  );

  const typeRes = await service.type({ appName: '示例应用', windowId: 1001, ref: 'n1', text: '测试 Windows 输入' });
  assert.equal(typeRes.ok, true);
  assert.equal(typeRes.chars, 13);

  bridge.state.focusedSecure = true;
  await assert.rejects(
    () => service.type({ appName: '示例应用', windowId: 1001, text: 'secret' }),
    (err) => err && err.code === 'desktop_secure_target',
  );
  bridge.state.focusedSecure = false;

  const scrollRes = await service.scroll({ appName: '示例应用', windowId: 1001, direction: 'down', amount: 5 });
  assert.equal(scrollRes.ok, true);
  assert.equal(scrollRes.direction, 'down');
  assert.equal(scrollRes.deltaY, -5);

  const dragRes = await service.drag({
    appName: '示例应用',
    windowId: 1001,
    x: 2000,
    y: 200,
    toX: 2300,
    toY: 400,
    steps: 6,
  });
  assert.equal(dragRes.ok, true);
  assert.equal(dragRes.dx, 300);
  assert.equal(dragRes.dy, 200);

  const hotkeyRes = await service.hotkey({ appName: '示例应用', windowId: 1001, key: 'ctrl+f' });
  assert.equal(hotkeyRes.ok, true);
  assert.equal(hotkeyRes.chord, 'control+f');

  // 7. UIPI guard blocks actions against elevated window when Pi Studio is non-elevated
  await assert.rejects(
    () => service.click({ appName: 'AdminApp', windowId: 1002, x: 200, y: 200 }),
    (err) => err && err.code === 'desktop_uipi_elevated',
  );
  bridge.state.selfElevated = true;
  const elevatedClick = await service.click({ appName: 'AdminApp', windowId: 1002, x: 200, y: 200 });
  assert.equal(elevatedClick.ok, true);
  bridge.state.selfElevated = false;

  // 8. Controlled desktop_launch on Windows
  const launched = await service.launch({ appName: '记事本', waitMs: 1000 });
  assert.equal(launched.ok, true);
  assert.equal(launched.alreadyRunning, false);
  assert.equal(launched.windowId, 2001);

  const already = await service.launch({ appName: '记事本', waitMs: 500 });
  assert.equal(already.alreadyRunning, true);
  assert.equal(already.windowId, 2001);

  await assert.rejects(
    () => service.launch({ appName: 'Windows PowerShell' }),
    (err) => err && err.code === 'desktop_blocked',
  );

  // 9. Clean shutdown
  await service.stopHelper();
  assert.equal(bridge.calls.some((c) => c.action === 'stop'), true);
});

test('Windows helper failure surfaces cleanly in permission status', async () => {
  const bridge = createMockWin32Bridge({ pingError: 'powershell unavailable' });
  const service = createDesktopControlService({
    platform: 'win32',
    win32Bridge: bridge,
  });
  const perm = await service.permissionStatus();
  assert.equal(perm.platform, 'win32');
  assert.equal(perm.supported, true);
  assert.equal(perm.ready, false);
  assert.equal(perm.helper?.available, false);
  assert.match(perm.message, /powershell unavailable/);
});

test('Windows PowerShell can compile and start the native UIA and capture helper', { skip: process.platform !== 'win32' }, async () => {
  const helper = win32Adapter.createWin32HelperClient();
  try {
    assert.equal((await helper.request('ping', {})).ok, true);
  } finally {
    await helper.stop();
  }
});

test('Windows search returns the owned popup with the input result and binds its click to that frame', async () => {
  const app = { name: '示例应用', bundleId: 'sampleapp.exe', path: 'C:\\Program Files\\Fixtures\\SampleApp\\SampleApp.exe' };
  const target = { appName: app.name, windowId: 1001 };
  const panel = { windowId: 1234, mimeType: 'image/png', data: 'cGFuZWw=',
    bounds: { x: 2100, y: 175, width: 240, height: 110 }, imageWidth: 240, imageHeight: 110 };
  setDesktopControlPreferences({ enabled: true, alwaysAllow: [app] });
  const bridge = createMockWin32Bridge();
  const request = bridge.request.bind(bridge);
  let panelOpen = true;
  bridge.request = async (action, params) => {
    if (action === 'click' && params.popupWindowId && !panelOpen) {
      throw Object.assign(new Error('popup closed'), { code: 'desktop_popup_changed' });
    }
    const result = await request(action, params);
    if (action !== 'screenshot') return result;
    assert.equal(params.pid, 900);
    assert.equal(params.includePopups, true);
    return { ...result, panels: panelOpen ? [panel] : [] };
  };
  const service = createDesktopControlService({ platform: 'win32', win32Bridge: bridge });
  const run = work => service.withRun('search', async () => ({ value: { run: { first: 1 } }, detach() {} }), work);
  const typed = await run(() => service.type({ ...target, text: 'or', searchField: true }));
  assert.deepEqual(typed.screenshot.panels, [panel]);
  assert.ok(bridge.calls.find(call => call.action === 'screenshot').params.popupWaitMs > 0);
  assert.equal(bridge.calls.filter(call => call.action === 'type').length, 1);
  const click = { popupWindowId: panel.windowId, normX: 500, normY: 500 };
  await run(() => service.click({ ...target, ...click }));
  const sent = bridge.calls.filter(call => call.action === 'click').at(-1).params;
  assert.deepEqual(sent, { windowId: 1001, pid: 900, popupWindowId: 1234, popupBounds: panel.bounds,
    x: 2220, y: 230, button: 'left' });
  panelOpen = false;
  const result = await run(() => service.act({ ...target, actions: [{ type: 'click', ...click }] }));
  assert.equal(result.failedStep.code, 'desktop_popup_changed');
  await assert.rejects(run(() => service.click({ ...target, ...click })), { code: 'desktop_popup_changed' });
  assert.equal(bridge.calls.filter(call => call.action === 'click').length, 1);
});

test('Windows helper timeout terminates that worker and its late exit cannot cancel the next explicitly requested observation', async () => {
  const { spawn } = require('node:child_process');
  const workers = [];
  const helper = win32Adapter.createWin32HelperClient({ spawn() {
    const child = spawn(process.execPath, ['-e', `
      process.stdout.write(JSON.stringify({ready:true})+'\\n');
      require('node:readline').createInterface({input:process.stdin}).on('line', line => {
        const req = JSON.parse(line);
        if(req.action === 'ping') setTimeout(() => {
          process.stdout.write(JSON.stringify({id:req.id,ok:true,result:{ok:true}})+'\\n');
        }, 30);
      });
    `], { stdio: ['pipe', 'pipe', 'pipe'] });
    workers.push(child);
    return child;
  } });
  try {
    await assert.rejects(helper.request('snapshot', {}, 30), { code: 'desktop_helper_timeout' });
    assert.equal(workers.length, 1);
    assert.equal(workers[0].killed, true);
    assert.deepEqual(await helper.request('ping'), { ok: true });
    assert.equal(workers.length, 2);
  } finally {
    await helper.stop();
  }
});
