/**
 * Packaged startup regression.
 *
 * This exercises the installed application rather than the development shell:
 * - the loaded renderer assets match the current production build;
 * - a fresh offline profile reaches pi:state without missing handlers;
 * - Studio preferences and a real Durable conversation survive a restart;
 * - packaged node-pty starts a shell with Studio's terminal environment;
 * - a second process exits and reveals the primary instance;
 * - hiding/reactivation keeps IPC available and the app exits cleanly.
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
const offlineArguments = [
  '--disable-background-networking',
  '--proxy-server=http://127.0.0.1:9',
  '--proxy-bypass-list=<-loopback>',
];
const offlineConversationTitle = '打包离线历史验收';
const expectedVersion = JSON.parse(
  fs.readFileSync(path.join(root, 'package.json'), 'utf8'),
).version;
const currentAssets = assetsFromIndex(
  fs.readFileSync(path.join(root, 'web-dist', 'index.html'), 'utf8'),
);
const artifactDirectory = path.join(root, '.qa', 'packaged-startup');

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function flag(name) {
  return process.argv.includes(name);
}

function assetsFromIndex(source) {
  const script = source.match(/<script[^>]+src="(?:\.\/)?([^"]+\.js)"/)?.[1];
  const style = source.match(/<link[^>]+href="(?:\.\/)?([^"]+\.css)"/)?.[1];
  assert.ok(script, 'The production index must reference a JavaScript entry');
  assert.ok(style, 'The production index must reference a CSS entry');
  return {
    script: path.basename(script),
    style: path.basename(style),
  };
}

function normalizeExecutable(candidate) {
  if (!fs.existsSync(candidate)) return candidate;
  if (!fs.statSync(candidate).isDirectory()) return candidate;
  return path.join(candidate, 'Contents', 'MacOS', 'Pi Studio');
}

function executablePath() {
  const explicit = argument('--app') || process.env.PI_STUDIO_PACKAGED_APP;
  const candidates = explicit ? [explicit] : [
    path.join(
      root,
      'release',
      process.arch === 'arm64' ? 'mac-arm64' : 'mac',
      'Pi Studio.app',
      'Contents',
      'MacOS',
      'Pi Studio',
    ),
    '/Applications/Pi Studio.app/Contents/MacOS/Pi Studio',
  ];
  const found = candidates.map(normalizeExecutable).find(candidate => fs.existsSync(candidate));
  if (!found) throw new Error('Packaged Pi Studio app was not found. Set PI_STUDIO_PACKAGED_APP.');
  return found;
}

function appBundleForExecutable(executable) {
  return path.dirname(path.dirname(path.dirname(executable)));
}

function packageResources(executable) {
  return path.join(appBundleForExecutable(executable), 'Contents', 'Resources');
}

function readPackageIdentity(executable) {
  const filename = path.join(packageResources(executable), 'pi-studio-build.json');
  assert.ok(fs.existsSync(filename), `The packaged build identity is missing: ${filename}`);
  const identity = JSON.parse(fs.readFileSync(filename, 'utf8'));
  assert.equal(identity.version, expectedVersion, 'The packaged app version differs from package.json');
  assert.match(identity.buildId || '', /^[a-z0-9][a-z0-9._-]{7,79}$/i);
  assert.match(identity.buildNumber || '', /^\d+$/);
  return identity;
}

function collectFiles(rootDirectory, predicate, output = []) {
  if (!fs.existsSync(rootDirectory)) return output;
  for (const entry of fs.readdirSync(rootDirectory, { withFileTypes: true })) {
    const target = path.join(rootDirectory, entry.name);
    if (entry.isDirectory()) collectFiles(target, predicate, output);
    else if (entry.isFile() && predicate(target)) output.push(target);
  }
  return output;
}

function verifyPackageFiles(executable) {
  const resources = packageResources(executable);
  assert.ok(
    fs.existsSync(path.join(resources, 'app.asar')),
    'The packaged application is missing app.asar',
  );

  const ptyRoot = path.join(resources, 'app.asar.unpacked', 'node_modules', 'node-pty');
  const helpers = collectFiles(ptyRoot, file => path.basename(file) === 'spawn-helper');
  assert.ok(helpers.length > 0, 'Packaged node-pty is missing spawn-helper');
  for (const helper of helpers) fs.accessSync(helper, fs.constants.X_OK);

  const nativeModules = collectFiles(ptyRoot, file => file.endsWith('.node'));
  assert.ok(nativeModules.length > 0, 'Packaged node-pty is missing native modules');

  const officialRoot = path.join(resources, 'official-extensions');
  const officialExtensions = fs.existsSync(officialRoot)
    ? fs.readdirSync(officialRoot, { withFileTypes: true })
      .filter(entry => entry.isDirectory())
    : [];
  assert.ok(officialExtensions.length > 0, 'Packaged official extensions are missing');
  for (const extension of officialExtensions) {
    const manifest = path.join(
      officialRoot,
      extension.name,
      'pi-studio.extension.json',
    );
    assert.ok(fs.existsSync(manifest), `Packaged extension manifest is missing: ${manifest}`);
    JSON.parse(fs.readFileSync(manifest, 'utf8'));
  }

  if (!flag('--allow-unsigned')) {
    execFileSync('codesign', [
      '--verify',
      '--deep',
      '--strict',
      appBundleForExecutable(executable),
    ], { stdio: 'pipe', timeout: 30_000 });
  }

  return {
    archive: path.join(resources, 'app.asar'),
    ptyHelpers: helpers.length,
    nativeModules: nativeModules.length,
    officialExtensions: officialExtensions.map(entry => entry.name).sort(),
  };
}

function profileEnvironment(profile, workspace) {
  const env = {
    ...process.env,
    PI_STUDIO_USER_DATA: profile,
    PI_STUDIO_DB: path.join(profile, 'pi-studio.sqlite'),
    HOME: profile,
    ZDOTDIR: profile,
    SHELL: '/bin/zsh',
  };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.PI_STUDIO_DEV;
  env.PWD = workspace;
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
  return state;
}

async function assertCurrentRenderer(page) {
  const loaded = await page.evaluate(() => {
    const script = document.querySelector('script[type="module"][src]');
    const style = document.querySelector('link[rel="stylesheet"][href]');
    return {
      script: script ? new URL(script.src).pathname.split('/').pop() : '',
      style: style ? new URL(style.href).pathname.split('/').pop() : '',
      url: location.href,
      bridgeMethods: Object.keys(window.piApi || {}).length,
    };
  });
  if (!flag('--allow-source-mismatch')) {
    assert.equal(
      loaded.script,
      currentAssets.script,
      'The packaged JavaScript does not match the current web-dist build',
    );
    assert.equal(
      loaded.style,
      currentAssets.style,
      'The packaged CSS does not match the current web-dist build',
    );
  }
  assert.match(loaded.url, /\/app\.asar\/web-dist\/index\.html(?:[?#].*)?$/);
  assert.ok(loaded.bridgeMethods >= 100, 'The packaged preload bridge is incomplete');
  return loaded;
}

async function assertApplicationIdentity(app, profile) {
  const identity = await app.evaluate(({ app }) => ({
    version: app.getVersion(),
    packaged: app.isPackaged,
    appPath: app.getAppPath(),
    userData: app.getPath('userData'),
  }));
  assert.equal(identity.version, expectedVersion);
  assert.equal(identity.packaged, true);
  assert.match(identity.appPath, /\/app\.asar$/);
  assert.equal(path.resolve(identity.userData), path.resolve(profile));
  return identity;
}

async function seedOfflineConfiguration(page, workspace) {
  await page.evaluate(() => {
    const key = 'pi-studio:preferences';
    let current = {};
    try {
      current = JSON.parse(localStorage.getItem(key) || '{}');
    } catch {
      current = {};
    }
    localStorage.setItem(key, JSON.stringify({
      ...current,
      theme: 'dark',
      palette: 'ocean',
      radiusStyle: 'compact',
    }));
  });
  await page.reload();
  await page.waitForURL(/\/web-dist\/index\.html(?:[?#].*)?$/);
  await page.waitForFunction(() => (
    document.documentElement.dataset.theme === 'dark'
    && document.documentElement.dataset.palette === 'ocean'
  ));
  await sleep(150);

  const created = await page.evaluate(async ({ workspace, title }) => {
    const api = window.piApi;
    await api.addProvider({
      providerId: 'offline-packaged-qa',
      name: 'Offline packaged QA',
      baseUrl: 'http://127.0.0.1:9/v1',
      api: 'openai-completions',
      enabled: true,
      cwd: workspace,
    });
    await api.addCustomModel({
      providerId: 'offline-packaged-qa',
      modelId: 'offline-model',
      name: 'Offline model',
      api: 'openai-completions',
      contextWindow: 8_192,
      maxTokens: 1_024,
      enabled: true,
      cwd: workspace,
    });
    await api.setDefaultModel('offline-packaged-qa/offline-model', workspace);
    const conversation = await api.createConversation({ cwd: workspace, title });
    const beforeRestart = await api.conversationPage({ id: conversation.id, limit: 20 });
    return {
      id: conversation.id,
      title: conversation.title,
      modelRef: (await api.state()).model.modelRef,
      pageMessages: beforeRestart?.messages?.length,
    };
  }, { workspace, title: offlineConversationTitle });
  assert.equal(created.title, offlineConversationTitle);
  assert.equal(created.modelRef, 'offline-packaged-qa/offline-model');
  assert.ok(Number.isInteger(created.pageMessages));
  return created;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function exercisePackagedTerminal(page, workspace) {
  const created = await page.evaluate(async ({ cwd }) => {
    window.__packagedPtyEvents = [];
    window.__disposePackagedPty = window.piApi.onTerminalEvent((event) => {
      window.__packagedPtyEvents.push(event);
    });
    return window.piApi.terminalCreate({
      id: 'packaged-startup-pty',
      cwd,
      cols: 96,
      rows: 24,
    });
  }, { cwd: workspace });
  assert.equal(created.status, 'running');
  const marker = '__PI_STUDIO_PACKAGED_PTY_OK__';
  try {
    await page.evaluate(({ marker }) => window.piApi.terminalWrite(
      'packaged-startup-pty',
      `printf '\\r${marker}:%s:%s:%s\\r\\n' "$PWD" "$TERM_PROGRAM" "$PI_STUDIO_TERMINAL"; exit\r`,
    ), { marker });
    await page.waitForFunction(
      expected => window.__packagedPtyEvents
        .filter(event => event.type === 'data')
        .map(event => event.data)
        .join('')
        .replaceAll('\r', '')
        .includes(expected),
      `${marker}:${workspace}:Pi Studio:1`,
      { timeout: 15_000 },
    );
    const output = await page.evaluate(() => window.__packagedPtyEvents
      .filter(event => event.type === 'data')
      .map(event => event.data)
      .join('')
      .replaceAll('\r', ''));
    assert.match(
      output,
      new RegExp(`${escapeRegExp(marker)}:${escapeRegExp(workspace)}:Pi Studio:1`),
    );
    return {
      shell: created.shell,
      cwd: created.cwd,
      marker,
    };
  } finally {
    await page.evaluate(() => {
      window.__disposePackagedPty?.();
      delete window.__disposePackagedPty;
      delete window.__packagedPtyEvents;
      return window.piApi.terminalClose('packaged-startup-pty').catch(() => undefined);
    }).catch(() => {});
  }
}

async function assertRestoredProfile(page) {
  const restored = await page.evaluate(async ({ title }) => {
    const groups = await window.piApi.conversationList();
    const session = groups.flatMap(group => group.sessions || [])
      .find(candidate => candidate.title === title);
    const conversation = session
      ? await window.piApi.conversationPage({ id: session.id, limit: 20 })
      : undefined;
    return {
      session,
      pageMessages: conversation?.messages?.length,
      modelRef: (await window.piApi.state()).model.modelRef,
      theme: document.documentElement.dataset.theme,
      palette: document.documentElement.dataset.palette,
    };
  }, { title: offlineConversationTitle });
  assert.ok(restored.session, 'The offline conversation was not restored after restart');
  assert.equal(restored.session.title, offlineConversationTitle);
  assert.ok(Number.isInteger(restored.pageMessages));
  assert.equal(restored.modelRef, 'offline-packaged-qa/offline-model');
  assert.equal(restored.theme, 'dark');
  assert.equal(restored.palette, 'ocean');
  return {
    id: restored.session.id,
    title: restored.session.title,
    pageMessages: restored.pageMessages,
    modelRef: restored.modelRef,
    theme: restored.theme,
    palette: restored.palette,
  };
}

function assertPersistedDatabase(profile) {
  const database = path.join(profile, 'pi-studio.sqlite');
  assert.ok(fs.existsSync(database), 'Studio SQLite was not created in the isolated profile');
  const quickCheck = execFileSync('sqlite3', [database, 'PRAGMA quick_check;'], {
    encoding: 'utf8',
  }).trim();
  assert.equal(quickCheck, 'ok');
  const conversations = Number(execFileSync('sqlite3', [
    database,
    `SELECT count(*) FROM conversations WHERE title = '${offlineConversationTitle}';`,
  ], { encoding: 'utf8' }).trim());
  assert.equal(conversations, 1);
  const appearance = execFileSync('sqlite3', [
    database,
    "SELECT key || '=' || value FROM settings WHERE key IN ('studio.app.theme', 'studio.app.palette', 'studio.app.radiusStyle') ORDER BY key;",
  ], { encoding: 'utf8' }).trim();
  assert.match(appearance, /studio\.app\.theme="dark"/);
  assert.match(appearance, /studio\.app\.palette="ocean"/);
  assert.match(appearance, /studio\.app\.radiusStyle="compact"/);
  return {
    quickCheck,
    conversations,
    appearanceRows: appearance.split('\n').filter(Boolean),
  };
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

async function exerciseProfile(executable, profile, workspace, label, options = {}) {
  const env = profileEnvironment(profile, workspace);
  let app;
  let page;
  const startupErrors = [];
  const consoleErrors = [];
  const rendererRemoteRequests = [];
  let evidence;
  try {
    app = await _electron.launch({
      executablePath: executable,
      args: offlineArguments,
      cwd: workspace,
      env,
      timeout: 30_000,
    });
    page = await app.firstWindow();
    page.on('console', message => {
      if (message.type() !== 'error') return;
      consoleErrors.push(message.text());
      if (/No handler registered|startup failed/i.test(message.text())) {
        startupErrors.push(message.text());
      }
    });
    page.on('pageerror', error => startupErrors.push(error.message));
    page.on('request', request => {
      if (/^https?:\/\//i.test(request.url())) rendererRemoteRequests.push(request.url());
    });
    await page.waitForURL(/\/web-dist\/index\.html$/, { timeout: 30_000 });

    const application = await assertApplicationIdentity(app, profile);
    const initialState = await assertState(page, app);
    const renderer = await assertCurrentRenderer(page);
    if (options.expectFresh) {
      assert.equal(
        initialState.model.modelRef,
        '',
        'A fresh isolated profile unexpectedly contains a model selection',
      );
    }

    if (options.seed) {
      evidence = await seedOfflineConfiguration(page, workspace);
      evidence.pty = await exercisePackagedTerminal(page, workspace);
      await page.screenshot({
        path: path.join(artifactDirectory, '01-offline-configured.png'),
        fullPage: true,
      });
    }

    if (options.restore) {
      evidence = await assertRestoredProfile(page);
      await page.screenshot({
        path: path.join(artifactDirectory, '02-offline-restored.png'),
        fullPage: true,
      });
    }

    if (options.lifecycle) {
      const second = spawn(executable, offlineArguments, {
        cwd: workspace,
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
    }

    assert.deepEqual(rendererRemoteRequests, [], `${label}: renderer made a remote request`);
    assert.deepEqual(consoleErrors, [], `${label}: renderer console errors: ${consoleErrors.join('; ')}`);
    assert.deepEqual(startupErrors, [], `${label}: renderer startup errors: ${startupErrors.join('; ')}`);
    const exited = waitForExit(app.process());
    await app.evaluate(({ app }) => app.quit());
    assert.equal(await exited, 0, `${label}: primary application did not exit cleanly`);
    return { application, renderer, evidence };
  } finally {
    try {
      if (app?.process().exitCode === null) await app.close().catch(() => {});
    } catch {
      // Playwright disposes its process dispatcher as soon as the app exits.
    }
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
const packageIdentity = readPackageIdentity(executable);
const packageFiles = verifyPackageFiles(executable);
const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-studio-packaged-qa-'));
const freshProfile = path.join(temporaryRoot, 'profile');
const workspace = path.join(temporaryRoot, 'workspace');
const copiedProfile = flag('--copy-current-profile')
  ? fs.mkdtempSync(path.join(os.tmpdir(), 'pi-studio-startup-current-'))
  : undefined;

fs.mkdirSync(freshProfile, { recursive: true });
fs.mkdirSync(workspace, { recursive: true });
fs.mkdirSync(artifactDirectory, { recursive: true });
fs.writeFileSync(
  path.join(freshProfile, '.zprofile'),
  "PROMPT=''; RPROMPT=''; unsetopt PROMPT_SP 2>/dev/null || true\n",
);
fs.writeFileSync(
  path.join(freshProfile, '.zshrc'),
  "PROMPT=''; RPROMPT=''; unsetopt PROMPT_SP 2>/dev/null || true\n",
);

try {
  const first = await exerciseProfile(executable, freshProfile, workspace, 'fresh offline profile', {
    expectFresh: true,
    seed: true,
    lifecycle: true,
  });
  const database = assertPersistedDatabase(freshProfile);
  const restored = await exerciseProfile(executable, freshProfile, workspace, 'restored offline profile', {
    restore: true,
  });

  fs.writeFileSync(path.join(artifactDirectory, 'results.json'), `${JSON.stringify({
    executable,
    version: expectedVersion,
    build: packageIdentity,
    files: packageFiles,
    assets: currentAssets,
    firstBoot: first,
    database,
    restoredBoot: restored,
    offline: true,
    limitations: [
      'The probe uses an isolated macOS profile and a loopback-unreachable model endpoint; no model request is expected or sent.',
      'The shell probe verifies packaged node-pty and Studio terminal variables, not a long-running or complex TUI workload.',
      'Self-signed code integrity is verified; Apple notarization and Gatekeeper acceptance are not claimed.',
    ],
  }, null, 2)}\n`);
  console.log(`current package ${packageIdentity.buildId}: assets, offline history, preferences, PTY, lifecycle, and restart passed`);

  if (copiedProfile) {
    assert.equal(cloneCurrentStudioDatabase(copiedProfile), true, 'Current Studio database was not found');
    await exerciseProfile(executable, copiedProfile, workspace, 'copied current profile', {
      lifecycle: true,
    });
    console.log('copied current profile: startup and reactivation passed');
  }
} finally {
  fs.rmSync(temporaryRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  if (copiedProfile) {
    fs.rmSync(copiedProfile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}
