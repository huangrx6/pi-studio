/**
 * Packaged startup regression.
 *
 * Verifies the installed code path rather than the Vite renderer alone:
 * - a fresh profile reaches pi:state without a missing-handler error;
 * - a copied Studio database also reaches pi:state;
 * - a second process exits and reveals the primary instance;
 * - hiding and reactivating the main window keeps IPC available;
 * - the application exits without waiting for a timeout.
 */
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron } from 'playwright-core';

const root = fileURLToPath(new URL('../..', import.meta.url));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function executablePath() {
  const explicit = argument('--app') || process.env.PI_STUDIO_PACKAGED_APP;
  const candidates = explicit ? [explicit] : [
    path.join(root, 'release', process.arch === 'arm64' ? 'mac-arm64' : 'mac', 'Pi Studio.app', 'Contents', 'MacOS', 'Pi Studio'),
    '/Applications/Pi Studio.app/Contents/MacOS/Pi Studio',
  ];
  const found = candidates.find(candidate => fs.existsSync(candidate));
  if (!found) throw new Error('Packaged Pi Studio app was not found. Set PI_STUDIO_PACKAGED_APP.');
  return found;
}

function profileEnvironment(profile) {
  const env = {
    ...process.env,
    PI_STUDIO_USER_DATA: profile,
    PI_STUDIO_DB: path.join(profile, 'pi-studio.sqlite'),
  };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.PI_STUDIO_DEV;
  return env;
}

async function assertState(page, app) {
  await page.waitForLoadState('domcontentloaded');
  const state = await page.evaluate(() => window.piApi.state());
  assert.ok(Array.isArray(state.workspaces), 'pi:state must return a workspace array');
  assert.ok(state.model && typeof state.model === 'object', 'pi:state must return a model selection');
  assert.equal(typeof state.cwd, 'string', 'pi:state must return the default cwd');

  const body = await page.locator('body').innerText();
  assert.doesNotMatch(body, /No handler registered for 'pi:state'/);

  const windows = await app.evaluate(({ BrowserWindow }) => (
    BrowserWindow.getAllWindows().filter(window => !window.isDestroyed()).length
  ));
  assert.ok(windows >= 1, 'primary application must still own a window');
}

async function waitForExit(child, timeoutMs = 15_000) {
  if (child.exitCode !== null) return child.exitCode;
  return Promise.race([
    new Promise(resolve => child.once('exit', code => resolve(code))),
    sleep(timeoutMs).then(() => {
      child.kill('SIGKILL');
      throw new Error('Application did not exit before the packaged-startup timeout');
    }),
  ]);
}

async function exerciseProfile(executable, profile, label) {
  const env = profileEnvironment(profile);
  let app;
  let page;
  const startupErrors = [];
  try {
    app = await _electron.launch({
      executablePath: executable,
      args: [],
      env,
      timeout: 30_000,
    });
    page = await app.firstWindow();
    await page.waitForURL(/\/web-dist\/index\.html$/, { timeout: 30_000 });
    page.on('console', message => {
      if (/No handler registered|startup failed/i.test(message.text())) startupErrors.push(message.text());
    });
    page.on('pageerror', error => startupErrors.push(error.message));

    await assertState(page, app);

    const second = spawn(executable, [], {
      env,
      stdio: 'ignore',
    });
    assert.equal(await waitForExit(second), 0, `${label}: second instance exited unexpectedly`);
    await sleep(500);
    await assertState(page, app);

    await app.evaluate(({ BrowserWindow, app }) => {
      const main = BrowserWindow.getAllWindows().find(window => !window.isDestroyed());
      if (!main) throw new Error('Main window is missing');
      main.close();
      if (!main.isDestroyed() && main.isVisible()) throw new Error('Closing the main window must hide it');
      app.emit('activate');
    });
    await sleep(500);
    await assertState(page, app);

    assert.deepEqual(startupErrors, [], `${label}: renderer startup errors: ${startupErrors.join('; ')}`);
    const exited = waitForExit(app.process());
    await app.evaluate(({ app }) => app.quit());
    assert.equal(await exited, 0, `${label}: primary application did not exit cleanly`);
  } finally {
    if (app?.process().exitCode === null) await app.close().catch(() => {});
  }
}

function cloneCurrentStudioDatabase(profile) {
  const source = path.join(
    os.homedir(),
    'Library',
    'Application Support',
    'pi-studio',
    'pi-studio.sqlite',
  );
  if (!fs.existsSync(source)) return false;
  const target = path.join(profile, 'pi-studio.sqlite');
  execFileSync('sqlite3', [source, `.backup '${target.replaceAll("'", "''")}'`], {
    stdio: 'ignore',
  });

  const sourceRoot = path.dirname(source);
  for (const name of ['config.json', 'model-catalogs', 'AGENTS.md']) {
    const sourcePath = path.join(sourceRoot, name);
    if (!fs.existsSync(sourcePath)) continue;
    fs.cpSync(sourcePath, path.join(profile, name), { recursive: true });
  }
  return true;
}

const executable = executablePath();
const freshProfile = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-studio-startup-fresh-'));
const copiedProfile = process.argv.includes('--copy-current-profile')
  ? fs.mkdtempSync(path.join(os.tmpdir(), 'pi-studio-startup-current-'))
  : undefined;

try {
  await exerciseProfile(executable, freshProfile, 'fresh profile');
  console.log('fresh profile: pi:state, second instance, reactivation, and quit passed');

  if (copiedProfile) {
    assert.equal(cloneCurrentStudioDatabase(copiedProfile), true, 'Current Studio database was not found');
    await exerciseProfile(executable, copiedProfile, 'copied current profile');
    console.log('copied current profile: startup and reactivation passed');
  }
} finally {
  fs.rmSync(freshProfile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  if (copiedProfile) {
    fs.rmSync(copiedProfile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}
