const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { clickDesktop, hotkeyDesktop, scrollDesktop, dragDesktop } = require('../../electron/main/services/desktop-control/act.cjs');

const app = { name: 'Chat', bundleId: 'example.chat' };
const click = { windowId: 41, x: -150, y: -100 };
const enter = { windowId: 41, key: 'enter' };

function macDesktop({ foreground = 7, overview, canPost = true, hits = [41], frontWindow = 41, extraWindows = [] } = {}) {
  let activations = 0;
  let appKitConnected = false;
  const events = [];
  const testedPoints = [];
  const point = (x, y) => ({ x, y });
  const target = {
    localizedName: app.name, bundleIdentifier: app.bundleId, processIdentifier: 7,
    activateWithOptions() { activations++; },
  };
  const workspace = {
    runningApplications: [target],
    get frontmostApplication() { return { processIdentifier: foreground }; },
  };
  const $ = Object.assign(value => value, {
    NSRunningApplication: { runningApplicationsWithBundleIdentifier(bundleId) {
      return { firstObject: bundleId === overview?.owner ? { processIdentifier: 12, isNil: () => false } : null };
    } },
    AXUIElementCreateApplication: () => ({ root: true }),
    AXUIElementSetMessagingTimeout() {},
    AXUIElementCopyAttributeValue(el, attribute, ref) {
      if (el.root && attribute === 'AXChildren') ref[0] = { count: 1, objectAtIndex: () => ({}) };
      else if (attribute === 'AXIdentifier') ref[0] = overview.id;
      else return -1;
      return 0;
    },
    NSApplication: { get sharedApplication() { appKitConnected = true; return {}; } },
    NSWorkspace: { sharedWorkspace: workspace },
    NSRunLoop: { currentRunLoop: { runUntilDate() {} } },
    NSDate: { dateWithTimeIntervalSinceNow: n => n },
    NSScreen: { screens: { objectAtIndex: () => ({ frame: { size: { height: 900 } } }) } },
    NSWindow: { windowNumberAtPointBelowWindowWithWindowNumber(p, below) {
      assert.equal(below, 0);
      if (!appKitConnected) return 0;
      testedPoints.push(p);
      return hits[Math.min(testedPoints.length - 1, hits.length - 1)];
    } },
    NSMakePoint: point,
    CGPointMake: point,
    CGPreflightPostEventAccess: () => canPost,
    CGWindowListCopyWindowInfo: () => [
      { kCGWindowOwnerPID: 7, kCGWindowLayer: 0, kCGWindowAlpha: 1, kCGWindowNumber: frontWindow, kCGWindowBounds: { X: -350, Y: -300, Width: 900, Height: 700 } },
      ...extraWindows,
    ],
    kCGEventLeftMouseDown: 1, kCGEventLeftMouseUp: 2,
    CGEventCreateMouseEvent: (_src, type, at) => ({ type, at }),
    CGEventSetIntegerValueField() {},
    CGEventCreateScrollWheelEvent: () => ({ type: 'scroll' }),
    CGEventSetLocation() {},
    CGEventPost: (_tap, event) => events.push(event),
  });
  const deps = {
    platform: 'darwin',
    listWindows: async () => [{ windowId: 41, bounds: { x: -350, y: -300, width: 900, height: 700 } }],
    runner: async (_executable, [, , , script, ...args]) => {
      const ObjC = { import() {}, bindFunction() {}, unwrap: x => x, deepUnwrap: x => x, castRefToObject: x => x };
      const Application = name => name === app.bundleId
        ? { activate() { activations++; } }
        : { keyCode(code) { events.push(code); } };
      return vm.runInNewContext(script + '\nrun(args)', { $, args, ObjC, Application, Ref: () => [], delay() {} });
    },
  };
  return { deps, events, testedPoints, get activations() { return activations; } };
}

async function checkPhysicalActionsPause(fixture, code) {
  const { deps } = fixture;
  const drag = { windowId: click.windowId, fromX: click.x, fromY: click.y, toX: 70, toY: 100 };
  await assert.rejects(clickDesktop(app, click, deps), { code });
  await assert.rejects(hotkeyDesktop(app, enter, deps), { code });
  await assert.rejects(scrollDesktop(app, { ...click, direction: 'down' }, deps), { code });
  await assert.rejects(dragDesktop(app, drag, deps), { code });
  assert.deepEqual(fixture.events, []);
  assert.equal(fixture.activations, 0);
}

test('switching applications pauses physical actions without taking back focus', async () => {
  await checkPhysicalActionsPause(macDesktop({ foreground: 9 }), 'desktop_foreground_required');
});

test('Mission Control in Dock or WindowManager blocks physical input while the original app is still reported frontmost', async () => {
  for (const overview of [{ owner: 'com.apple.dock', id: 'mc' }, { owner: 'com.apple.WindowManager', id: 'mc.display' }]) {
    await checkPhysicalActionsPause(macDesktop({ overview }), 'desktop_mission_control_active');
  }
});

test('a process without permission to post mouse events reports a permission failure before clicking', async () => {
  const { deps, events } = macDesktop({ canPost: false });
  await assert.rejects(clickDesktop(app, click, deps), { code: 'desktop_accessibility_permission' });
  assert.deepEqual(events, []);
});

test('click hit-tests the exact window in AppKit coordinates, including displays above or left of primary', async () => {
  const covered = macDesktop({ hits: [72] });
  await assert.rejects(clickDesktop(app, click, covered.deps), /遮挡/);
  assert.deepEqual(covered.events, []);
  const clear = macDesktop();
  await clickDesktop(app, click, clear.deps);
  assert.deepEqual(clear.testedPoints, [{ x: -150, y: 1000 }]);
  assert.deepEqual(clear.events, [
    { type: 1, at: { x: -150, y: -100 } }, { type: 2, at: { x: -150, y: -100 } },
  ]);
});

test('if a double click changes windows midway it reports a partial outcome', async () => {
  const { deps, events } = macDesktop({ hits: [41, 72] });
  await assert.rejects(clickDesktop(app, { ...click, double: true }, deps), { code: 'desktop_action_outcome_unknown' });
  assert.equal(events.length, 2);
});

test('Enter checks the active window within the target application before dispatch', async () => {
  const other = macDesktop({ frontWindow: 53 });
  await assert.rejects(hotkeyDesktop(app, enter, other.deps), /目标窗口未在前台/);
  assert.deepEqual(other.events, []);
  const active = macDesktop();
  await hotkeyDesktop(app, enter, active.deps);
  assert.deepEqual(active.events, [36]);
});

test('click allows same-app overlay popups and borderless child dropdowns above the target window', async () => {
  const popup = macDesktop({
    hits: [99],
    extraWindows: [{ kCGWindowOwnerPID: 7, kCGWindowLayer: 101, kCGWindowAlpha: 1, kCGWindowNumber: 99 }],
  });
  await clickDesktop(app, click, popup.deps);
  assert.equal(popup.events.length, 2);

  const qtDropdown = macDesktop({
    hits: [100],
    extraWindows: [{
      kCGWindowOwnerPID: 7, kCGWindowLayer: 0, kCGWindowAlpha: 1, kCGWindowNumber: 100,
      kCGWindowName: '', kCGWindowBounds: { X: -320, Y: -240, Width: 280, Height: 320 },
    }],
  });
  await clickDesktop(app, click, qtDropdown.deps);
  assert.equal(qtDropdown.events.length, 2);

  const siblingMain = macDesktop({
    hits: [101],
    extraWindows: [{
      kCGWindowOwnerPID: 7, kCGWindowLayer: 0, kCGWindowAlpha: 1, kCGWindowNumber: 101,
      kCGWindowName: 'Other Chat', kCGWindowBounds: { X: -300, Y: -200, Width: 400, Height: 400 },
    }],
  });
  await assert.rejects(clickDesktop(app, click, siblingMain.deps), /遮挡/);
  assert.deepEqual(siblingMain.events, []);
});
