const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { captureDesktopSnapshot } = require('../../electron/main/services/desktop-control/observe.cjs');
const { typeDesktop, clickDesktop } = require('../../electron/main/services/desktop-control/act.cjs');

const app = { name: 'AX fixture', bundleId: 'example.fixture' };
const windowId = 630;

function fixture() {
  let presses = 0;
  let value = 'old';
  let label = 'Press';
  let throwAfterPress = false;
  const window = { windowId, visible: false, minimized: false, bounds: { x: 10, y: 10, width: 320, height: 220 } };
  function element(role, title) {
    const identifier = role;
    const attr = {
      exists: () => true, settable: () => true,
      get value() { return () => value; }, set value(next) { value = next; },
    };
    return {
      role: () => role, title, subrole: () => '', description: () => '', position: () => [20, 30], size: () => [80, 30],
      attributes: { byName: k => k === 'AXValue' ? attr : { value: () => identifier } },
      actions: { byName: () => ({ exists: () => role === 'AXButton', perform() {
        presses++;
        if (throwAfterPress) throw new Error('accessibility connection lost');
      } }) },
    };
  }
  const children = [element('AXButton', () => label), element('AXTextField', () => '')];
  const deps = {
    platform: 'darwin', listWindows: async () => [window],
    runner: async (_command, [, , , script, ...argv]) => {
      if (script.includes('walk(win, 0')) {
        return { stdout: JSON.stringify({ pid: 77, windowId, nodes: children.map((el, index) => ({
          path: '1/' + (index + 1), role: el.role(), name: el.title(),
          axIdentity: JSON.stringify([el.role(), el.title(), '', '', el.role()]),
        })) }) };
      }
      // Run the production mutation with no keyboard, pointer or activation API.
      const run = script.slice(script.lastIndexOf('function run(argv)'));
      const stdout = vm.runInNewContext(run + '\nrun(argv);', {
        argv, findRunningApp: () => ({ pid: 77 }), listCgWindowsForPid: () => [window],
        findSeProcess: () => ({ unixId: () => 77 }), findSeWindowForWindowId: () => ({ uiElements: () => children }),
        axIdentity: (el, ...props) => JSON.stringify([...props, el.attributes.byName('AXIdentifier').value()]),
        Application(name) { assert.equal(name, 'System Events'); return {}; },
      });
      return { stdout };
    },
  };
  return {
    deps, snapshot: () => captureDesktopSnapshot(app, { windowId }, deps),
    rename: next => { label = next; }, losePressAck: () => { throwAfterPress = true; },
    get presses() { return presses; }, get value() { return value; },
  };
}

test('background field replacement and AXPress reach the exact off-Space window without pointer or keyboard dispatch', async () => {
  const f = fixture();
  const { nodes: [button, field] } = await f.snapshot();
  const typed = await typeDesktop(app, { windowId, ref: field.ref, text: 'wx和中文', clear: true }, f.deps);
  assert.equal(typed.method, 'AXValue');
  assert.equal(typed.valueVerified, true);
  assert.equal(typed.submitted, false);
  assert.equal(f.value, 'wx和中文');
  const clicked = await clickDesktop(app, { windowId, ref: button.ref, path: button.path }, f.deps);
  assert.equal(clicked.method, 'AXPress');
  assert.equal(f.presses, 1);
});

test('changed or conflicting AX targets require a fresh snapshot before any side effect', async () => {
  const f = fixture();
  const { nodes: [button, field] } = await f.snapshot();
  await assert.rejects(clickDesktop(app, { windowId, ref: button.ref, path: field.path }, f.deps), { code: 'desktop_target_not_found' });
  f.rename('Other action');
  await assert.rejects(clickDesktop(app, { windowId, ref: button.ref }, f.deps), { code: 'desktop_target_not_found' });
  const next = await f.snapshot();
  assert.notEqual(next.nodes[0].ref, button.ref);
  assert.equal(next.nodes[1].ref, field.ref);
  await assert.rejects(clickDesktop(app, { windowId, ref: button.ref }, f.deps), { code: 'desktop_target_not_found' });
  assert.equal(f.presses, 0);
});

test('an AXPress that loses acknowledgement is never replayed as a coordinate click', async () => {
  const f = fixture();
  const { nodes: [button] } = await f.snapshot();
  f.losePressAck();
  await assert.rejects(clickDesktop(app, { windowId, ref: button.ref }, f.deps), { code: 'desktop_action_outcome_unknown' });
  assert.equal(f.presses, 1);
});

test('a second conversation cannot rebind the first conversation’s path on the same window', async t => {
  const fs = require('node:fs');
  const path = require('node:path');
  const os = require('node:os');
  const { createStudioDatabase } = require('../../electron/main/core/studio-db.cjs');
  const { setDesktopControlPreferences } = require('../../electron/main/services/desktop-control/policy.cjs');
  const { createDesktopControlService } = require('../../electron/main/services/desktop-control/index.cjs');
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-ax-sessions-'));
  const db = createStudioDatabase(path.join(temp, 'studio.sqlite'));
  t.after(() => { db.close(); fs.rmSync(temp, { recursive: true, force: true }); });
  setDesktopControlPreferences({ enabled: true, alwaysAllow: [app] }, db);
  const f = fixture();
  const service = createDesktopControlService({
    ...f.deps, db,
    listRunningApps: async () => [app],
    helperClient: { getPermissions: async () => ({ screenRecording: 'granted', accessibility: true }) },
  });
  const first = { windowId, bundleId: app.bundleId, sessionId: 'first' };
  const second = { ...first, sessionId: 'second' };
  const old = (await service.snapshot(first)).nodes[0];
  f.rename('Changed in the second conversation');
  const current = (await service.snapshot(second)).nodes[0];
  assert.equal(current.path, old.path);
  assert.notEqual(current.ref, old.ref);

  await assert.rejects(service.click({ ...first, elementPath: old.path }), { code: 'desktop_target_not_found' });
  const failed = await service.act({ ...first, screenshot: false, actions: [{ type: 'click', elementPath: old.path }] });
  assert.equal(failed.failedStep.code, 'desktop_target_not_found');
  await assert.rejects(service.click({ ...second, ref: old.ref }), { code: 'desktop_target_not_found' });
  assert.equal(f.presses, 0);

  const ok = await service.act({ ...second, screenshot: false, actions: [{ type: 'click', elementPath: current.path }] });
  assert.equal(ok.steps[0].method, 'AXPress');
  assert.equal(f.presses, 1);
});
