const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');
const vm = require('node:vm');
const {
  JXA_DESKTOP_HELPERS, captureDesktopScreenshot, captureDesktopSnapshot, listDesktopWindowsForApp,
} = require('../../electron/main/services/desktop-control/observe.cjs');

const target = { name: 'Fixture', bundleId: 'test.observation' };
const frame = { x: 80, y: 90, width: 300, height: 200 };

function fixture({ offscreen = false, minimized = false, alpha = 1, axId = 51, axMain, mainWindowId } = {}) {
  const attributes = values => ({ byName: name => ({ value: () => values[name] }) });
  const ax = {
    name: () => 'Fixture window',
    position: () => [frame.x, frame.y],
    size: () => [frame.width, frame.height],
    attributes: attributes({ AXWindowNumber: axId, AXMinimized: minimized, AXMain: axMain }),
  };
  const proc = {
    windows: () => [ax],
    attributes: attributes({ AXMainWindow: { attributes: attributes({ AXWindowNumber: mainWindowId }) } }),
  };
  const rows = [51, 52].map((id) => ({
    kCGWindowOwnerPID: 3, kCGWindowLayer: 0, kCGWindowNumber: id, kCGWindowAlpha: id === 51 ? alpha : 1,
    kCGWindowIsOnscreen: id === 51 ? !offscreen : true,
    kCGWindowBounds: { X: frame.x, Y: frame.y, Width: frame.width, Height: frame.height },
  }));
  const env = {
    ObjC: { import() {}, unwrap: value => value, deepUnwrap: value => value, castRefToObject: value => value },
    $: {
      NSWorkspace: { sharedWorkspace: { runningApplications: [{ bundleIdentifier: target.bundleId,
        localizedName: target.name, processIdentifier: 3 }] } },
      CGWindowListCopyWindowInfo: () => rows,
    },
    Application: () => ({ processes: { whose: () => () => [proc] } }),
  };
  return async (_cmd, [, , , script, ...argv]) => ({
    stdout: vm.runInNewContext(script + '\nrun(argv)', { ...env, argv }),
  });
}

test('an offscreen untitled CG window keeps its ID and only AX can confirm minimization', async () => {
  for (const minimized of [false, true]) {
    const rows = await listDesktopWindowsForApp(target, { platform: 'darwin', runner: fixture({ offscreen: true, minimized }) });
    const pinned = rows.find(row => row.windowId === 51);
    assert.equal(pinned.visible, false);
    assert.equal(pinned.minimized, minimized);
    assert.equal(pinned.title, 'Fixture window');
    assert.equal(rows.find(row => row.windowId === 52).title, '');
  }
  const transitioning = await listDesktopWindowsForApp(target, { platform: 'darwin', runner: fixture({ alpha: 0 }) });
  const pinned = transitioning.find(row => row.windowId === 51);
  assert.equal(pinned.visible, false);
  assert.equal(pinned.minimized, false);
});

test('AX windows with explicit IDs must agree, and geometric fallback requires unique frames on both sides', () => {
  const { matchAxWindow } = vm.runInNewContext(JXA_DESKTOP_HELPERS + '\n({matchAxWindow})');
  const cg = { ...frame, windowId: 10, title: 'Document' };
  const duplicate = { ...cg, windowId: 11 };
  const unknown = { ...frame, title: 'Document', windowId: 0 };
  const other = { ...unknown, windowId: 11 };
  assert.equal(matchAxWindow([unknown], cg, [cg]), unknown);
  assert.equal(matchAxWindow([unknown], cg, [cg, duplicate]), null);
  assert.equal(matchAxWindow([unknown, { ...unknown }], cg, [cg]), null);
  assert.equal(matchAxWindow([other], cg, [cg]), null);
  assert.equal(matchAxWindow([{ ...unknown, x: 180 }], cg, [cg]), null);
  const known = { ...unknown, windowId: 10 };
  assert.equal(matchAxWindow([other, known], cg, [cg, duplicate]), known);
});

test('overlapping identical frames receive a main-window marker only on unambiguous AX evidence', async () => {
  for (const [axState, expected] of [
    [{ mainWindowId: 52 }, [52]],
    [{ axMain: true }, [51]],
    [{ axMain: true, mainWindowId: 52 }, []],
    [{ axMain: true, axId: 0 }, []],
  ]) {
    const rows = await listDesktopWindowsForApp(target, { platform: 'darwin', runner: fixture(axState) });
    assert.deepEqual(rows.filter(row => row.main).map(row => row.windowId), expected);
  }
});

test('an offscreen screenshot captures only its requested window or reports an unavailable frame', async () => {
  const options = { windowId: 51 };
  const deps = { platform: 'darwin', listWindows: async () => [{ windowId: 51, visible: false, minimized: false }] };
  const ids = [];
  deps.runner = async (cmd, args) => {
    assert.equal(cmd, '/usr/sbin/screencapture');
    ids.push(args[args.indexOf('-l') + 1]);
    if (ids.length === 1) fs.writeFileSync(args.at(-1), Buffer.from('fixture'));
    else throw new Error('No window image available');
  };
  assert.equal((await captureDesktopScreenshot(target, options, deps)).windowId, 51);
  await assert.rejects(captureDesktopScreenshot(target, options, deps), { code: 'desktop_window_offscreen' });
  assert.deepEqual(ids, ['51', '51']);
});

test('a disappearing or ambiguous AX window cannot return a sibling tree', async () => {
  const listWindows = async () => [{ windowId: 52 }];
  const runner = fixture();
  const options = { windowId: 52 };
  await assert.rejects(captureDesktopSnapshot(target, options, { platform: 'darwin', listWindows, runner }),
    { code: 'desktop_ax_window_unresolved' });
  await assert.rejects(captureDesktopSnapshot(target, { windowId: 'invalid' }, { platform: 'darwin', listWindows, runner }),
    { code: 'desktop_window_required' });
});

test('captureDesktopScreenshot prefers native ScreenCaptureKit composite capture and falls back cleanly', async () => {
  const calls = [];
  const sckResult = await captureDesktopScreenshot(target, { windowId: 51 }, {
    platform: 'darwin',
    listWindows: async () => [{ windowId: 51, title: 'Chat', visible: true, minimized: false, bounds: frame }],
    captureWindow: async (opts) => {
      calls.push(opts);
      return {
        ok: true,
        mimeType: 'image/png',
        data: Buffer.from('sck-composite').toString('base64'),
        imageWidth: 600,
        imageHeight: 400,
        bytes: 13,
        scaled: false,
        overlayCount: 2,
        captureMode: 'sck_display_composite',
        bounds: frame,
      };
    },
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].windowId, 51);
  assert.equal(calls[0].includePopups, true);
  assert.equal(sckResult.overlayCount, 2);
  assert.equal(sckResult.captureMode, 'sck_display_composite');

  let fellBackToScreencapture = false;
  const fallbackResult = await captureDesktopScreenshot(target, { windowId: 51 }, {
    platform: 'darwin',
    listWindows: async () => [{ windowId: 51, title: 'Chat', visible: true, minimized: false, bounds: frame }],
    captureWindow: async () => { throw new Error('sc_unsupported_os'); },
    runner: async (cmd, args) => {
      if (cmd === '/usr/sbin/screencapture') {
        fellBackToScreencapture = true;
        fs.writeFileSync(args.at(-1), Buffer.from('fallback-png'));
      }
      return { stdout: '', stderr: '' };
    },
  });
  assert.equal(fellBackToScreencapture, true);
  assert.equal(fallbackResult.windowId, 51);
});
