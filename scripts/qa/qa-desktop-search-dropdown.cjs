// macOS 14+, with the development helper already allowed to capture and type.
const assert = require('node:assert/strict');
const { execFileSync, spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { setTimeout: wait } = require('node:timers/promises');

async function main() {
  const root = path.resolve(__dirname, '../..');
  const qa = path.join(root, '.qa');
  fs.mkdirSync(qa, { recursive: true });
  const out = fs.mkdtempSync(path.join(qa, 'desktop-search-'));
  process.env.PI_STUDIO_USER_DATA = out;
  process.env.PI_STUDIO_DB = path.join(out, 'fixture.sqlite');
  const { createComputerUseHelperClient } = require('../../electron/main/services/desktop-control/helper-client.cjs');
  const { createDesktopControlService } = require('../../electron/main/services/desktop-control/index.cjs');
  const { setDesktopControlPreferences } = require('../../electron/main/services/desktop-control/policy.cjs');
  const handle = createComputerUseHelperClient();
  let fixture;
  try {
    const permission = await handle.getPermissions();
    assert.ok(permission.accessibility && permission.screenRecording === 'granted', 'The fixture needs an already-authorized Computer Use helper');
    const name = 'Dropdown Fixture';
    const bundleId = 'dev.pi.studio.qa.search-dropdown';
    const bundle = path.join(out, name + '.app');
    const contents = path.join(bundle, 'Contents');
    const executable = path.join(contents, 'MacOS', 'DropdownFixture');
    fs.mkdirSync(path.dirname(executable), { recursive: true });
    fs.writeFileSync(path.join(contents, 'Info.plist'), `<plist version="1.0"><dict>
      <key>CFBundleIdentifier</key><string>${bundleId}</string><key>CFBundlePackageType</key><string>APPL</string>
      <key>CFBundleName</key><string>${name}</string><key>CFBundleExecutable</key><string>DropdownFixture</string></dict></plist>`);
    execFileSync('/usr/bin/swiftc', ['-module-cache-path', path.join(os.tmpdir(), 'pi-studio-swift-module-cache'),
      path.join(__dirname, 'fixtures/desktop-search-dropdown.swift'), '-o', executable]);
    const stateFile = path.join(out, 'window.json');
    fixture = spawn(executable, [stateFile], { stdio: 'ignore' });
    const state = () => JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    for (let i = 0; i < 100 && (!fs.existsSync(stateFile) || !state().key); i++) await wait(50);
    const initial = state();
    assert.ok(initial.key);
    const target = { appName: name, bundleId, windowId: initial.windowId };
    setDesktopControlPreferences({ enabled: true, alwaysAllow: [{ name, bundleId, path: bundle }] });
    const service = createDesktopControlService({ platform: 'darwin', helperClient: handle });
    const typed = await service.type({ ...target, searchField: true, text: 'panel' });
    assert.ok(typed.ok && !typed.staged, JSON.stringify(typed.screenshotError || typed.method));
    assert.equal(state().text, 'panel');
    const panel = typed.screenshot?.panels.find(item => item.windowId === state().panelId);
    assert.ok(panel?.data, 'expected the protruding panel image after typing');
    fs.writeFileSync(path.join(out, 'panel.png'), Buffer.from(panel.data, 'base64'));
    const again = await service.act({ ...target, actions: [{ type: 'wait', ms: 50 }] });
    assert.ok(again.screenshot?.panels.some(item => item.windowId === panel.windowId));
    const inline = await service.act({ ...target, searchField: true, actions: [{ type: 'type', clear: true, text: 'inline' }] });
    assert.ok(inline.ok && inline.screenshot?.data && !inline.staged);
    fs.writeFileSync(path.join(out, 'inline.png'), Buffer.from(inline.screenshot.data, 'base64'));
    assert.equal(state().text, 'inline');
    assert.equal(state().inlineVisible, true, JSON.stringify({ ...state(), overlays: inline.screenshot.overlayCount, out }));
    assert.equal(inline.screenshot.overlayCount, 0);
    assert.equal(state().blurred, initial.blurred);
    assert.equal(state().frame, initial.frame);
    assert.ok(state().key);
    console.log(`Captured detached and inline suggestions without a focus or display change: ${out}`);
  } finally {
    fixture?.kill();
    await handle.stop();
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
