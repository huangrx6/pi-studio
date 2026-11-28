const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-studio-desktop-v2-'));
process.env.PI_STUDIO_DB = path.join(temporary, 'studio.sqlite');

const { closeStudioDatabase } = require('../../electron/main/core/studio-db.cjs');
const {
  setDesktopControlPreferences,
  getDesktopControlPreferences,
  clearSessionAllowApps,
} = require('../../electron/main/services/desktop-control/policy.cjs');
const { createDesktopControlService } = require('../../electron/main/services/desktop-control/index.cjs');
const { computeBadgeRect } = require('../../electron/main/services/desktop-control/overlay.cjs');
const { typeDesktop } = require('../../electron/main/services/desktop-control/act.cjs');
const { captureDesktopScreenshot } = require('../../electron/main/services/desktop-control/observe.cjs');

// Minimal valid 24-byte PNG header (1280x720) for IHDR dimension parsing tests.
function fakePngBuffer(width = 1280, height = 720) {
  const buf = Buffer.alloc(32);
  buf[0] = 0x89; buf[1] = 0x50; buf[2] = 0x4e; buf[3] = 0x47;
  buf[4] = 0x0d; buf[5] = 0x0a; buf[6] = 0x1a; buf[7] = 0x0a;
  buf.writeUInt32BE(13, 8);
  buf.write('IHDR', 12, 'ascii');
  buf.writeUInt32BE(width, 16);
  buf.writeUInt32BE(height, 20);
  return buf;
}

test.after(() => {
  clearSessionAllowApps();
  closeStudioDatabase();
  fs.rmSync(temporary, { recursive: true, force: true });
});

test('macOS desktop_type uses atomic NSPasteboard paste for Chinese/Unicode instead of keystroke', async () => {
  const executed = [];
  const res = await typeDesktop(
    { name: '示例应用', bundleId: 'studio.fixture.localized' },
    { windowId: 341, text: '我爱你', clear: true, submit: true },
    {
      platform: 'darwin',
      listWindows: async () => [{
        windowId: 341,
        title: '示例应用',
        minimized: false,
        visible: true,
        bounds: { x: 1920, y: 200, width: 1440, height: 870 },
      }],
      getWindowFrame: async () => ({
        windowId: 341,
        title: '示例应用',
        minimized: false,
        visible: true,
        bounds: { x: 1920, y: 200, width: 1440, height: 870 },
      }),
      getFocusedNode: async () => ({ role: 'AXTextArea', name: '', secure: false }),
      runner: async (cmd, args) => {
        executed.push({ cmd, args });
        return { stdout: 'ok', stderr: '' };
      },
    },
  );
  assert.equal(res.ok, true);
  assert.equal(res.method, 'paste');
  assert.equal(res.submitted, true);
  assert.equal(res.chars, 3);
  assert.equal(executed.length, 1);
  assert.match(executed[0].args[3], /NSPasteboard/);
  assert.equal(executed[0].args[5], '我爱你');
  assert.equal(executed[0].args[6], '1'); // clear
  assert.equal(executed[0].args[7], '1'); // submit
});

test('macOS shadowless screenshot uses -o flag and returns image dimensions + window bounds', async () => {
  const capturedArgs = [];
  const res = await captureDesktopScreenshot(
    { name: '示例应用', bundleId: 'studio.fixture.localized' },
    { windowId: 341 },
    {
      platform: 'darwin',
      listWindows: async () => [{
        windowId: 341,
        title: '示例应用',
        minimized: false,
        visible: true,
        bounds: { x: 1920, y: 200, width: 1440, height: 870 },
      }],
      runner: async (cmd, args) => {
        capturedArgs.push({ cmd, args });
        const outFile = args[args.length - 1];
        fs.writeFileSync(outFile, fakePngBuffer(1440, 870));
        return { stdout: '', stderr: '' };
      },
    },
  );
  assert.equal(capturedArgs[0].cmd, '/usr/sbin/screencapture');
  assert.ok(capturedArgs[0].args.includes('-o'), 'expected -o shadowless flag');
  assert.equal(res.imageWidth, 1440);
  assert.equal(res.imageHeight, 870);
  assert.deepEqual(res.bounds, { x: 1920, y: 200, width: 1440, height: 870 });
  assert.equal(res.captureMode, 'single_window_fallback');
});

test('desktop_act runs multi-step batch with normalized coords, Chinese submit, overlay, and auto-screenshot', async () => {
  setDesktopControlPreferences({
    enabled: true,
    allowAnyApp: false,
    alwaysAllow: [{ name: '示例应用', bundleId: 'studio.fixture.localized', path: '/Applications/SampleApp.app' }],
  });

  const clicks = [];
  const types = [];
  const overlays = [];
  const service = createDesktopControlService({
    platform: 'darwin',
    helperClient: { getPermissions: async () => ({ screenRecording: 'granted', accessibility: true }) },
    showOverlay: (info) => overlays.push(info),
    listRunningApps: async () => ([
      { name: '示例应用', bundleId: 'studio.fixture.localized', path: '/Applications/SampleApp.app' },
    ]),
    listWindows: async () => ([
      {
        id: '341',
        windowId: 341,
        title: '示例应用',
        appName: '示例应用',
        minimized: false,
        visible: true,
        bounds: { x: 1920, y: 200, width: 1440, height: 870 },
      },
    ]),
    getWindowFrame: async () => ({
      windowId: 341,
      title: '示例应用',
      minimized: false,
      visible: true,
      bounds: { x: 1920, y: 200, width: 1440, height: 870 },
    }),
    getFocusedNode: async () => ({ role: 'AXTextArea', name: '', secure: false }),
    click: async (_app, payload) => {
      clicks.push(payload);
      return { ok: true, windowId: payload.windowId, x: payload.x, y: payload.y, bounds: { x: 1920, y: 200, width: 1440, height: 870 } };
    },
    type: async (_app, payload) => {
      types.push(payload);
      return { ok: true, windowId: payload.windowId, chars: payload.text.length, valueVerified: true, submitted: true, bounds: { x: 1920, y: 200, width: 1440, height: 870 } };
    },
    captureScreenshot: async () => ({
      mimeType: 'image/png',
      data: fakePngBuffer(1440, 870).toString('base64'),
      windowId: 341,
      appName: '示例应用',
      bundleId: 'studio.fixture.localized',
      bounds: { x: 1920, y: 200, width: 1440, height: 870 },
      imageWidth: 1440,
      imageHeight: 870,
      bytes: 32,
      scaled: false,
    }),
  });

  const result = await service.act({
    appName: '示例应用',
    settleMs: 0,
    actions: [
      { type: 'click', normX: 150, normY: 120 },
      { type: 'click', normX: 500, normY: 850 },
      { type: 'type', text: '我爱你', submit: true },
    ],
  });

  assert.equal(result.ok, true);
  assert.equal(result.windowId, 341);
  assert.equal(result.steps.length, 3);
  assert.equal(clicks.length, 2);
  // 1920 + 0.15 * 1440 = 2136; 200 + 0.12 * 870 = 304
  assert.equal(clicks[0].x, 2136);
  assert.equal(clicks[0].y, 304);
  assert.equal(types.length, 1);
  assert.equal(types[0].text, '我爱你');
  assert.equal(result.steps.at(-1).valueVerified, true);
  assert.ok(result.screenshot && result.screenshot.data, 'expected automatic post-action screenshot');
  assert.ok(overlays.length > 0, 'expected target-window control badge overlay to trigger');
});

test('a requested screenshot failure preserves the window and completed input without replaying it', async () => {
  const app = { name: 'Fixture', bundleId: 'test.desktop.fixture', path: '/Fixture.app' };
  const window = { windowId: 42, visible: true, minimized: false, bounds: { x: 0, y: 0, width: 240, height: 240 } };
  setDesktopControlPreferences({ enabled: true, allowAnyApp: false, alwaysAllow: [app] });
  let pastes = 0;
  const service = createDesktopControlService({
    platform: 'darwin',
    helperClient: { getPermissions: async () => ({ screenRecording: 'granted', accessibility: true }) },
    listInstalledApps: () => [app],
    listRunningApps: async () => [app],
    listWindows: async () => [window],
    getWindowFrame: async () => window,
    showOverlay: () => {},
    type: async () => {
      pastes++;
      return { ok: true, chars: 2, submitted: false, valueVerified: false };
    },
    captureScreenshot: async () => { throw Object.assign(new Error('fixture capture failed'), { code: 'desktop_screenshot_failed' }); },
  });
  const target = { bundleId: app.bundleId, screenshot: true };
  const launched = await service.launch(target);
  assert.equal(launched.windowId, 42);
  assert.equal(launched.screenshotError.code, 'desktop_screenshot_failed');
  const result = await service.act({ ...target, settleMs: 0, actions: [{ type: 'type', text: 'wx' }] });
  assert.equal(pastes, 1);
  assert.equal(result.steps[0].ok, true);
  assert.equal(result.steps[0].valueVerified, false);
  assert.equal(result.steps[0].submitted, false);
  assert.equal(result.screenshotError.message, launched.screenshotError.message);
});

test('in-chat Computer Use approval supports session allow, permanent always-allow, deny, and never prompts for blocked apps', async () => {
  clearSessionAllowApps();
  setDesktopControlPreferences({
    enabled: true,
    allowAnyApp: false,
    alwaysAllow: [],
  });

  const prompts = [];
  let nextDecision = { accepted: true, remember: 'session' };

  const service = createDesktopControlService({
    platform: 'darwin',
    helperClient: { getPermissions: async () => ({ screenRecording: 'granted', accessibility: true }) },
    requestApproval: async (req) => {
      prompts.push(req);
      return nextDecision;
    },
    listRunningApps: async () => ([
      { name: '示例应用', bundleId: 'studio.fixture.localized', path: '/Applications/SampleApp.app' },
      { name: 'Safari', bundleId: 'com.apple.Safari', path: '/Applications/Safari.app' },
      { name: 'Terminal', bundleId: 'com.apple.Terminal', path: '/System/Applications/Utilities/Terminal.app' },
    ]),
    listWindows: async (app) => ([
      { id: '10', windowId: 10, title: app.name, appName: app.name, minimized: false, visible: true, bounds: { x: 0, y: 0, width: 1000, height: 700 } },
    ]),
    captureScreenshot: async (app) => ({
      mimeType: 'image/png',
      data: fakePngBuffer(1000, 700).toString('base64'),
      windowId: 10,
      appName: app.name,
      bundleId: app.bundleId,
      bounds: { x: 0, y: 0, width: 1000, height: 700 },
      imageWidth: 1000,
      imageHeight: 700,
      bytes: 32,
    }),
  });

  // 1. Session approval ("允许此对话") prompts once and is remembered for that session only.
  await service.screenshot({ appName: '示例应用', windowId: 10, sessionId: 'conv-1' });
  await service.screenshot({ appName: '示例应用', windowId: 10, sessionId: 'conv-1' });
  assert.equal(prompts.length, 1);
  assert.equal(prompts[0].tool, 'desktop_control_app');
  assert.equal(getDesktopControlPreferences().alwaysAllow.length, 0);

  // 2. Permanent approval ("始终允许") persists into alwaysAllow.
  nextDecision = { accepted: true, remember: 'always' };
  await service.screenshot({ appName: 'Safari', windowId: 10, sessionId: 'conv-1' });
  assert.equal(prompts.length, 2);
  assert.ok(getDesktopControlPreferences().alwaysAllow.some((a) => a.bundleId === 'com.apple.Safari'));

  // 3. Denial throws desktop_approval_denied.
  nextDecision = { accepted: false };
  await assert.rejects(
    () => service.screenshot({ appName: '示例应用', windowId: 10, sessionId: 'conv-2' }),
    (err) => err && err.code === 'desktop_approval_denied',
  );

  // 4. Hard-blocked app NEVER prompts.
  const promptCountBefore = prompts.length;
  await assert.rejects(
    () => service.screenshot({ appName: 'Terminal', windowId: 10, sessionId: 'conv-1' }),
    (err) => err && err.code === 'desktop_blocked',
  );
  assert.equal(prompts.length, promptCountBefore);
});

test('overlay badge rect anchors cleanly over macOS traffic lights and Windows titlebar', () => {
  const macRect = computeBadgeRect({ x: 1920, y: 200, width: 1440, height: 870 }, 'darwin');
  assert.deepEqual(macRect, { x: 1926, y: 203, width: 74, height: 30 });

  const winRect = computeBadgeRect({ x: 100, y: 80, width: 1200, height: 800 }, 'win32');
  assert.deepEqual(winRect, { x: 108, y: 84, width: 74, height: 30 });

  assert.equal(computeBadgeRect({ x: 0, y: 0, width: 40, height: 20 }, 'darwin'), null);
});

test('macOS keeps a selected background window across launch steps and refuses ambiguous siblings', async () => {
  const app = { name: 'Chat Fixture', bundleId: 'test.background.chat', path: '/Chat Fixture.app' };
  setDesktopControlPreferences({ enabled: true, alwaysAllow: [app] });
  let windows = [{ windowId: 7, visible: false, minimized: false }];
  let opens = 0;
  const captured = [];
  const service = createDesktopControlService({
    platform: 'darwin',
    helperClient: { getPermissions: async () => ({ screenRecording: 'granted', accessibility: true }) },
    listInstalledApps: () => [app], listRunningApps: async () => [app],
    listWindows: async () => windows,
    launchApp: async () => { opens++; },
    captureScreenshot: async (_app, { windowId }) => {
      captured.push(windowId);
      return { data: 'png', mimeType: 'image/png', windowId };
    },
  });
  const target = { bundleId: app.bundleId, screenshot: true };
  assert.equal((await service.launch(target)).windowId, 7);
  assert.equal((await service.screenshot({ ...target, windowId: 7 })).windowId, 7);
  windows = [{ windowId: 8, visible: true }, { windowId: 7, visible: true, main: true }];
  assert.equal((await service.launch(target)).windowId, 7);
  const result = await service.act({ ...target, windowId: 8, settleMs: 0, actions: [{ type: 'launch' }] });
  assert.equal(result.steps[0].windowId, 8);
  assert.deepEqual(captured, [7, 7, 7, 8]);
  windows[1].main = false;
  await assert.rejects(service.act({ ...target, actions: [] }), { code: 'desktop_window_ambiguous' });
  assert.equal(opens, 0);
});

test('macOS prefers dominant titled primary window over small helper panels and routes actions through Virtual Stage', async () => {
  const app = { name: '示例应用', bundleId: 'studio.fixture.localized', path: '/Applications/SampleApp.app' };
  setDesktopControlPreferences({ enabled: true, alwaysAllow: [app] });
  const sampleappWindows = [
    { windowId: 21732, title: '示例应用', visible: false, minimized: false, bounds: { x: 231, y: 122, width: 1441, height: 871 } },
    { windowId: 21728, title: '', visible: false, minimized: false, bounds: { x: 0, y: 580, width: 500, height: 500 } },
    { windowId: 21719, title: '示例应用', visible: false, minimized: false, bounds: { x: 794, y: 335, width: 280, height: 380 } },
  ];

  const mainBounds = { x: 3376, y: 1230, width: 1408, height: 852 };
  const popupBounds = { x: 3500, y: 1300, width: 320, height: 400 };
  const separateBounds = { x: 4650, y: 1250, width: 200, height: 320 };
  let popupGone = false;
  let fallbackClicks = 0;
  const stageCalls = [];
  const releaseCalls = [];
  const service = createDesktopControlService({
    platform: 'darwin',
    helperClient: { getPermissions: async () => ({ screenRecording: 'granted', accessibility: true }) },
    listInstalledApps: () => [app],
    listRunningApps: async () => [app],
    listWindows: async () => sampleappWindows,
    launchApp: async () => {},
    click: async () => { fallbackClicks++; },
    captureScreenshot: async (_app, { windowId }) => ({
      data: Buffer.from('png').toString('base64'),
      mimeType: 'image/png',
      windowId,
      bounds: { x: 3376, y: 1230, width: 1408, height: 852 },
    }),
    stageWindow: async (opts) => {
      stageCalls.push({ op: 'stageWindow', ...opts });
      return {
        ok: true,
        staged: true,
        windowId: opts.windowId,
        windowBounds: { x: 3376, y: 1230, width: 1408, height: 852 },
      };
    },
    stageAct: async (opts) => {
      stageCalls.push({ op: 'stageAct', ...opts });
      if (opts.actions[0].popupWindowId) {
        if (popupGone) throw Object.assign(new Error('窗口已消失'), { code: 'stage_move_failed' });
        return { ok: true, staged: false, bounds: mainBounds, steps: [{ index: 1, type: 'click', ok: true, method: 'background_popup' }] };
      }
      return {
        ok: true,
        staged: true,
        windowId: opts.windowId,
        bounds: { x: 3376, y: 1230, width: 1408, height: 852 },
        steps: [
          { index: 1, type: 'click', ok: true, x: 3500, y: 1300, method: 'virtual_stage' },
          { index: 2, type: 'type', ok: true, chars: 4, submitted: false, method: 'virtual_stage_unicode' },
        ],
        screenshot: {
          ok: true,
          mimeType: 'image/png',
          data: Buffer.from('composite').toString('base64'),
          imageWidth: 1408,
          imageHeight: 852,
          bytes: 9,
          scaled: false,
          overlayCount: 1,
          popupRegions: [{ windowId: 21771, bounds: popupBounds }],
          panels: [{ windowId: 21770, bounds: separateBounds, mimeType: 'image/png', data: 'cGFuZWw=', imageWidth: 200, imageHeight: 320 }],
          captureMode: 'sck_display_composite',
          bounds: { x: 3376, y: 1230, width: 1408, height: 852 },
        },
      };
    },
    stageRelease: async (opts) => {
      releaseCalls.push(opts);
      return { ok: true, released: true, windowId: opts.windowId };
    },
  });

  const launched = await service.launch({ appName: '示例应用', screenshot: true });
  assert.equal(launched.windowId, 21732);
  assert.equal(launched.staged, true);
  assert.equal(stageCalls[0].op, 'stageWindow');
  assert.equal(stageCalls[0].windowId, 21732);

  const observe = async () => ({ value: { run: { first: 1 } }, detach() {} });
  const run = (work) => service.withRun('fixture-run', observe, work);
  const acted = await run(() => service.act({
    appName: '示例应用',
    windowId: 21732,
    actions: [
      { type: 'click', normX: 120, normY: 55 },
      { type: 'type', text: '亿万富豪', clear: true },
    ],
  }));
  assert.equal(acted.ok, true);
  assert.equal(acted.staged, true);
  assert.equal(acted.steps.length, 2);
  assert.equal(acted.screenshot.overlayCount, 1);
  assert.equal(acted.screenshot.captureMode, 'sck_display_composite');
  assert.equal(acted.screenshot.panels[0].windowId, 21770);
  const popupClick = { type: 'click', popupWindowId: 21770, normX: 250, normY: 740 };
  const target = { appName: '示例应用', windowId: 21732 };
  await run(() => service.previewCapture(target)); // PiP sees no popup; the model still sees the previous frame.
  const clicked = await run(() => service.act({ ...target, actions: [popupClick] }));
  assert.deepEqual(stageCalls.at(-1).actions, [{ ...popupClick, popupBounds: separateBounds }]);
  assert.equal(clicked.staged, false);

  const inside = { type: 'click', rx: 100, ry: 75, imageWidth: 704, imageHeight: 426 };
  await run(() => service.act({ ...target, actions: [inside] }));
  assert.deepEqual(stageCalls.at(-1).actions, [{ type: 'click', rx: 76, ry: 80, popupWindowId: 21771, popupBounds }]);
  await run(() => service.act({ ...target, actions: [{ type: 'click', popupWindowId: 21771, normX: 250, normY: 250 }] }));
  assert.deepEqual(stageCalls.at(-1).actions, [{ type: 'click', rx: 228, ry: 143, popupWindowId: 21771, popupBounds }]);
  const clickedDirect = await run(() => service.click({ ...target, x: 3576, y: 1380 }));
  assert.equal(clickedDirect.staged, false);
  assert.equal(stageCalls.at(-1).actions[0].popupWindowId, 21771);
  assert.equal(stageCalls.at(-1).actions[0].rx, 76);
  assert.deepEqual(stageCalls.at(-1).actions[0].popupBounds, popupBounds);

  await assert.rejects(run(() => service.act({ ...target, actions: [inside, { type: 'hotkey', key: 'enter' }] })),
    { code: 'desktop_act_invalid' });
  await assert.rejects(run(() => service.act({ ...target, actions: [{ ...popupClick, type: 'type', text: 'x' }] })),
    { code: 'desktop_act_invalid' });

  popupGone = true;
  await assert.rejects(run(() => service.click({ ...target, ...inside })), { code: 'desktop_popup_changed' });
  await assert.rejects(run(() => service.act({ ...target, actions: [inside] })), { code: 'desktop_popup_changed' });
  assert.equal(fallbackClicks, 0);
  await assert.rejects(service.withRun('other-run', observe, () => service.act({ ...target, actions: [popupClick] })),
    { code: 'desktop_popup_changed' });
  await run(() => service.screenshot(target));
  await assert.rejects(run(() => service.act({ ...target, actions: [popupClick] })), { code: 'desktop_popup_changed' });

  const focused = await service.focusWindow({ appName: '示例应用', windowId: 21732 });
  assert.equal(focused.ok, true);
  assert.equal(focused.released, true);
  assert.equal(releaseCalls.length, 1);
  assert.equal(releaseCalls[0].windowId, 21732);
});

test('screenshot and search typing tools return popup images, coordinate labels and visible search options', async t => {
  const durable = await import('@earendil-works/pi-durable');
  const service = require('../../electron/main/services/desktop-control/index.cjs');
  const region = { windowId: 22, bounds: { x: 400, y: 300, width: 220, height: 160 } };
  const shot = {
    windowId: 11, appName: 'Fixture', data: 'bWFpbg==', mimeType: 'image/png', popupRegions: [region],
    panels: [{ windowId: 33, data: 'cGFuZWw=', mimeType: 'image/png', bounds: region.bounds }],
    accessibilityOptions: ['Orbit'],
  };
  t.mock.method(service, 'captureAllowedDesktopScreenshot', async () => shot);
  t.mock.method(service, 'typeAllowedDesktop', async args => {
    assert.equal(args.searchField, true);
    return { ...args, ok: true, chars: 2, screenshot: shot };
  });
  const { createDesktopControlTools } = require('../../electron/main/capabilities/desktop-control/index.cjs');
  const tools = createDesktopControlTools(durable).tools;
  const api = { conversationId: 1, commit: async () => null };
  const shotResult = await tools.find(t => t.name === 'desktop_screenshot').execute({ windowId: 11 }, api, {});
  const typed = await tools.find(t => t.name === 'desktop_type').execute({ appName: 'Fixture', windowId: 11, text: 'or', searchField: true }, api, {});
  for (const result of [shotResult, typed]) {
    assert.deepEqual(result.output.map(block => block.type), ['text', 'image', 'text', 'image']);
    assert.match(result.output[0].text, /主图内的弹窗 #22.*主图坐标/);
    assert.match(result.output[0].text, /Orbit/);
    assert.match(result.output[2].text, /同应用弹窗 #33.*popupWindowId=33/);
  }
  assert.deepEqual(shotResult.details.popupRegions, [region]);
  assert.equal(typed.details.screenshot.panels[0].windowId, 33);
  assert.equal(typed.details.chars, 2);
});

test('search typing observes the focused field in one call and a later wait never stages the window', async () => {
  const app = { name: 'Search Fixture', bundleId: 'test.search' };
  const target = { appName: app.name, windowId: 11 };
  const bounds = { x: 120, y: 80, width: 480, height: 320 };
  const image = { windowId: 11, bounds, data: 'bWFpbg==', mimeType: 'image/png', accessibilityOptions: ['Orbit'] };
  const calls = [];
  let captureFails = false;
  setDesktopControlPreferences({ enabled: true, alwaysAllow: [app] });
  const service = createDesktopControlService({
    platform: 'darwin',
    helperClient: { getPermissions: async () => ({ screenRecording: 'granted', accessibility: true }) },
    listRunningApps: async () => [app], listWindows: async () => [{ ...target, bounds, visible: true }],
    stageAct: async opts => {
      calls.push(['input', opts]);
      return { ok: true, staged: false, bounds, steps: [{ index: 1, type: 'type', ok: true, chars: 2 }],
        ...(captureFails ? { screenshotError: { code: 'sc_capture_failed', message: 'capture failed' } } : { screenshot: image }) };
    },
    captureScreenshot: async (_target, opts) => { calls.push(['capture', opts]); return image; },
  });
  const typed = await service.type({ ...target, text: 'or', searchField: true });
  assert.equal(typed.staged, false);
  assert.deepEqual(typed.screenshot.accessibilityOptions, ['Orbit']);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][1].actions[0].text, 'or');
  assert.equal(calls[0][1].captureAfter, true);
  assert.equal(calls[0][1].searchField, true);
  assert.ok(calls[0][1].popupWaitMs > 0);
  await service.act({ ...target, searchField: true, actions: [{ type: 'wait', ms: 30 }] });
  assert.deepEqual(calls.map(([kind]) => kind), ['input', 'capture']);
  assert.equal(calls.at(-1)[1].popupWaitMs, 0);
  await service.act({ ...target, searchField: true, settleMs: 20, actions: [{ type: 'type', text: 'or' }] });
  assert.equal(calls.at(-1)[1].popupWaitMs, 0);
  assert.equal(calls.at(-1)[1].settleMs, 20);
  captureFails = true;
  const afterError = await service.type({ ...target, text: 'it', searchField: true });
  assert.equal(afterError.chars, 2);
  assert.equal(afterError.screenshotError.code, 'sc_capture_failed');
  assert.deepEqual(calls.map(([kind]) => kind), ['input', 'capture', 'input', 'input']);
});
