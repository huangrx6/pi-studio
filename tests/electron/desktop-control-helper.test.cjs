const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  HELPER_APP_NAME,
  HELPER_DISPLAY_NAME,
  HELPER_BUNDLE_ID,
  HELPER_EXECUTABLE_NAME,
  resolveHelperAppPath,
  createComputerUseHelperClient,
} = require('../../electron/main/services/desktop-control/helper-client.cjs');
const {
  getDesktopPermissionStatus,
  assertDesktopPermissions,
  openDesktopPermissionSettings,
} = require('../../electron/main/services/desktop-control/permissions.cjs');
const { isBlockedApp } = require('../../electron/main/services/desktop-control/policy.cjs');

test('resolveHelperAppPath prefers env override, then packaged Helpers, then dev dist', () => {
  const existing = new Set([
    path.join('/custom/helper.app', 'Contents', 'MacOS', HELPER_EXECUTABLE_NAME),
    path.join('/Applications/Pi Studio.app/Contents/Helpers', HELPER_APP_NAME, 'Contents', 'MacOS', HELPER_EXECUTABLE_NAME),
    path.join('/repo/dist/computer-use', HELPER_APP_NAME, 'Contents', 'MacOS', HELPER_EXECUTABLE_NAME),
  ]);
  const existsSync = (candidate) => existing.has(candidate);

  assert.equal(
    resolveHelperAppPath({
      env: { PI_STUDIO_COMPUTER_USE_APP: '/custom/helper.app' },
      resourcesPath: '/Applications/Pi Studio.app/Contents/Resources',
      repoRoot: '/repo',
      existsSync,
    }),
    path.resolve('/custom/helper.app'),
  );

  assert.equal(
    resolveHelperAppPath({
      env: {},
      resourcesPath: '/Applications/Pi Studio.app/Contents/Resources',
      repoRoot: '/repo',
      existsSync,
    }),
    path.join('/Applications/Pi Studio.app/Contents/Helpers', HELPER_APP_NAME),
  );

  assert.equal(
    resolveHelperAppPath({
      env: {},
      resourcesPath: '/other/Resources',
      repoRoot: '/repo',
      existsSync,
    }),
    path.join('/repo/dist/computer-use', HELPER_APP_NAME),
  );
});

test('Pi Studio Computer Use helper is always hard-blocked from desktop control', () => {
  assert.equal(isBlockedApp({ name: HELPER_DISPLAY_NAME }), true);
  assert.equal(isBlockedApp({ bundleId: HELPER_BUNDLE_ID }), true);
});

test('computer-use helper client speaks authenticated JSON protocol and restarts on refresh', async () => {
  const tempBase = process.platform === 'darwin' && fs.existsSync('/tmp') ? '/tmp' : os.tmpdir();
  const tempDir = fs.mkdtempSync(path.join(tempBase, 'pi-cu-'));
  const activeServers = new Map();
  let launchCount = 0;
  let screenGranted = false;

  const client = createComputerUseHelperClient({
    platform: 'darwin',
    runtimeDir: tempDir,
    resolveHelperAppPath: () => path.join(tempDir, HELPER_APP_NAME),
    launcher: async (_appPath, configPath) => {
      launchCount += 1;
      const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      fs.unlinkSync(configPath);
      activeServers.set(cfg.socketPath, { token: cfg.token, alive: true });
    },
    sendSocketRequest: async (socketPath, req) => {
      const server = activeServers.get(socketPath);
      if (!server || !server.alive) {
        const err = new Error('ENOENT');
        err.code = 'ENOENT';
        throw err;
      }
      if (req.token !== server.token) {
        return { ok: false, code: 'unauthorized' };
      }
      if (req.op === 'ping') {
        return { ok: true, pid: 4242, bundleId: HELPER_BUNDLE_ID, helperName: HELPER_DISPLAY_NAME };
      }
      if (req.op === 'permissions') {
        return {
          ok: true,
          screenRecording: screenGranted ? 'granted' : 'not-determined',
          accessibility: true,
          bundleId: HELPER_BUNDLE_ID,
          bundlePath: path.join(tempDir, HELPER_APP_NAME),
          helperName: HELPER_DISPLAY_NAME,
        };
      }
      if (req.op === 'request_permission') {
        return { ok: true, prompted: true, kind: req.kind };
      }
      if (req.op === 'exec') {
        return { ok: true, exitCode: 0, stdout: `ran:${req.command}:${req.args.join(',')}`, stderr: '' };
      }
      if (req.op === 'shutdown') {
        server.alive = false;
        activeServers.delete(socketPath);
        return { ok: true };
      }
      return { ok: false, code: 'unknown_op' };
    },
  });

  try {
    const first = await getDesktopPermissionStatus({ platform: 'darwin', helperClient: client });
    assert.equal(launchCount, 1);
    assert.equal(first.screenRecording, 'not-determined');
    assert.equal(first.accessibility, true);
    assert.equal(first.ready, false);
    assert.equal(first.helper.bundleId, HELPER_BUNDLE_ID);
    assert.equal(first.helper.available, true);

    await assert.rejects(
      () => assertDesktopPermissions('screenshot', { platform: 'darwin', helperClient: client }),
      (err) => err && err.code === 'desktop_screen_permission' && err.message.includes(HELPER_DISPLAY_NAME),
    );

    // Simulate user granting Screen Recording and clicking "Refresh" -> restarts helper.
    screenGranted = true;
    const refreshed = await getDesktopPermissionStatus({ platform: 'darwin', helperClient: client, refresh: true });
    assert.equal(launchCount, 2);
    assert.equal(refreshed.screenRecording, 'granted');
    assert.equal(refreshed.ready, true);

    const execResult = await client.exec('/usr/bin/osascript', ['-l', 'JavaScript', '-e', '1+1']);
    assert.equal(execResult.stdout, 'ran:/usr/bin/osascript:-l,JavaScript,-e,1+1');

    let openedUrl = '';
    const openResult = await openDesktopPermissionSettings('accessibility', {
      platform: 'darwin',
      helperClient: client,
      shell: {
        openExternal: async (url) => {
          openedUrl = url;
        },
      },
    });
    assert.equal(openResult.ok, true);
    assert.equal(openResult.prompted, true);
    assert.match(openedUrl, /Privacy_Accessibility/);
  } finally {
    await client.stop();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('getDesktopPermissionStatus surfaces missing helper cleanly', async () => {
  const missingClient = createComputerUseHelperClient({
    platform: 'darwin',
    resolveHelperAppPath: () => '',
  });
  const status = await getDesktopPermissionStatus({ platform: 'darwin', helperClient: missingClient });
  assert.equal(status.supported, true);
  assert.equal(status.ready, false);
  assert.equal(status.helper.available, false);
  assert.equal(status.helper.code, 'desktop_helper_missing');

  await assert.rejects(
    () => assertDesktopPermissions('windows', { platform: 'darwin', helperClient: missingClient }),
    (err) => err && err.code === 'desktop_helper_missing',
  );
});

test('a lost, malformed or timed-out execution acknowledgement never repeats a desktop command', async (t) => {
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-cu-ack-'));
  const outcomes = [
    () => { throw new Error('reply lost after dispatch'); },
    () => ({}),
    () => ({ ok: false, code: 'ETIMEDOUT' }),
    () => { throw Object.assign(new Error('socket closed before connect'), { dispatched: false }); },
    () => ({ ok: true, stdout: 'ack' }),
  ];
  let dispatches = 0;
  const client = createComputerUseHelperClient({
    platform: 'darwin', runtimeDir,
    resolveHelperAppPath: () => HELPER_APP_NAME,
    launcher: async () => {},
    sendSocketRequest: async (_socket, req) => req.op === 'exec' ? outcomes[dispatches++]() : { ok: true },
  });
  t.after(async () => {
    await client.stop();
    fs.rmSync(runtimeDir, { recursive: true, force: true });
  });
  for (let attempt = 1; attempt <= 3; attempt++) {
    await assert.rejects(client.exec('/usr/bin/osascript'), { code: 'desktop_action_outcome_unknown' });
    assert.equal(dispatches, attempt);
  }
  assert.equal((await client.exec('/usr/bin/osascript')).stdout, 'ack');
  assert.equal(dispatches, 5); // One connection was lost before a command could be dispatched.
});
