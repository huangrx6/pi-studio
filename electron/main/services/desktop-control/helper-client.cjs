/**
 * Client for the standalone macOS "Pi Studio Computer Use.app" helper bundle.
 *
 * Launches the helper via LaunchServices (`/usr/bin/open -g -n -a ...`) so macOS TCC
 * attributes Screen Recording and Accessibility permissions to `dev.pi.studio.computer-use`
 * instead of the main Electron app (`Pi Studio.app` / `Electron.app`).
 */
const { execFile } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { promisify } = require('node:util');

const execFileAsync = promisify(execFile);

const HELPER_APP_NAME = 'Pi Studio Computer Use.app';
const HELPER_DISPLAY_NAME = 'Pi Studio Computer Use';
const HELPER_BUNDLE_ID = 'dev.pi.studio.computer-use';
const HELPER_EXECUTABLE_NAME = 'PiStudioComputerUse';

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const DEFAULT_CONNECT_TIMEOUT_MS = 5000;
const DEFAULT_REQUEST_TIMEOUT_MS = 18000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function unknownExecutionOutcome(cause) {
  const error = new Error('辅助应用未确认命令的执行结果。请核对目标窗口后再操作，以免重复输入或发送。', { cause });
  error.code = 'desktop_action_outcome_unknown';
  return error;
}

/**
 * Locate the built "Pi Studio Computer Use.app" bundle in packaged or dev mode.
 * @param {{ env?: NodeJS.ProcessEnv, resourcesPath?: string, repoRoot?: string, existsSync?: typeof fs.existsSync }} [options]
 */
function resolveHelperAppPath(options = {}) {
  const env = options.env || process.env;
  const existsSync = options.existsSync || fs.existsSync;
  const resourcesPath = options.resourcesPath !== undefined ? options.resourcesPath : process.resourcesPath;
  const repoRoot = options.repoRoot || REPO_ROOT;

  const candidates = [];
  const envOverride = String(env.PI_STUDIO_COMPUTER_USE_APP || '').trim();
  if (envOverride) {
    candidates.push(path.resolve(envOverride));
  }
  if (resourcesPath) {
    // Packaged macOS layout: Pi Studio.app/Contents/Helpers/Pi Studio Computer Use.app
    candidates.push(path.join(resourcesPath, '..', 'Helpers', HELPER_APP_NAME));
    candidates.push(path.join(resourcesPath, HELPER_APP_NAME));
  }
  // Dev layout: <repo>/dist/computer-use/Pi Studio Computer Use.app
  candidates.push(path.join(repoRoot, 'dist', 'computer-use', HELPER_APP_NAME));

  for (const candidate of candidates) {
    const executable = path.join(candidate, 'Contents', 'MacOS', HELPER_EXECUTABLE_NAME);
    if (existsSync(executable)) {
      return candidate;
    }
  }
  return '';
}

function sendSocketRequest(socketPath, payload, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ path: socketPath });
    let settled = false;
    let dispatched = false;
    let buffer = '';

    const finish = (err, data) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (err) {
        err.dispatched = dispatched;
        reject(err);
      } else resolve(data);
    };

    const timer = setTimeout(() => {
      const error = new Error(`Pi Studio Computer Use helper timed out after ${timeoutMs}ms`);
      error.code = 'ETIMEDOUT';
      finish(error);
    }, timeoutMs);

    socket.on('connect', () => {
      dispatched = true;
      socket.write(`${JSON.stringify(payload)}\n`);
    });

    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      const newline = buffer.indexOf('\n');
      if (newline !== -1) {
        const line = buffer.slice(0, newline).trim();
        try {
          finish(null, JSON.parse(line));
        } catch (parseErr) {
          finish(parseErr);
        }
      }
    });

    socket.on('end', () => {
      if (settled) return;
      const line = buffer.trim();
      if (!line) {
        finish(new Error('Pi Studio Computer Use helper closed connection without response'));
        return;
      }
      try {
        finish(null, JSON.parse(line));
      } catch (parseErr) {
        finish(parseErr);
      }
    });

    socket.on('error', (err) => {
      finish(err);
    });
  });
}

function createComputerUseHelperClient(deps = {}) {
  const platform = deps.platform || process.platform;
  const launcher = deps.launcher || (async (appPath, configPath) => {
    await execFileAsync('/usr/bin/open', ['-g', '-n', '-a', appPath, '--args', '--config', configPath], {
      timeout: 8000,
    });
  });
  const resolveApp = deps.resolveHelperAppPath || (() => resolveHelperAppPath(deps));
  const requestOverSocket = deps.sendSocketRequest || sendSocketRequest;
  const runtimeDir = deps.runtimeDir || (platform === 'darwin' && fs.existsSync('/tmp') ? '/tmp' : os.tmpdir());
  const parentPid = deps.parentPid || process.pid;

  let session = null;
  let startingPromise = null;

  function cleanupSessionFiles(target) {
    if (!target) return;
    for (const file of [target.socketPath, target.configPath]) {
      if (!file) continue;
      try {
        if (fs.existsSync(file)) fs.unlinkSync(file);
      } catch {
        /* best effort */
      }
    }
  }

  async function launchFreshSession() {
    if (platform !== 'darwin') {
      const error = new Error('电脑操控目前仅支持 macOS。');
      error.code = 'desktop_unsupported_platform';
      throw error;
    }

    const appPath = resolveApp();
    if (!appPath) {
      const error = new Error(
        `未找到 ${HELPER_DISPLAY_NAME} 辅助应用（${HELPER_APP_NAME}）。请先运行 pnpm run build:computer-use 构建，或重新安装 Pi Studio。`,
      );
      error.code = 'desktop_helper_missing';
      throw error;
    }

    const nonce = crypto.randomBytes(8).toString('hex');
    const token = crypto.randomBytes(24).toString('hex');
    // Keep Unix socket path short (< 104 bytes on macOS).
    const socketPath = path.join(runtimeDir, `pi-cu-${process.pid}-${nonce}.sock`);
    const configPath = path.join(runtimeDir, `pi-cu-${process.pid}-${nonce}.json`);

    fs.writeFileSync(
      configPath,
      JSON.stringify({ socketPath, token, parentPid }),
      { mode: 0o600 },
    );

    const candidate = { appPath, socketPath, configPath, token, pid: null };
    try {
      await launcher(appPath, configPath, candidate);
      const deadline = Date.now() + (deps.connectTimeoutMs || DEFAULT_CONNECT_TIMEOUT_MS);
      let lastError = null;
      while (Date.now() < deadline) {
        try {
          const ping = await requestOverSocket(socketPath, { token, op: 'ping' }, 1000);
          if (ping && ping.ok) {
            candidate.pid = typeof ping.pid === 'number' ? ping.pid : null;
            session = candidate;
            return candidate;
          }
        } catch (err) {
          lastError = err;
        }
        await sleep(40);
      }
      const error = new Error(
        `无法连接到 ${HELPER_DISPLAY_NAME} 辅助应用${lastError && lastError.message ? `：${lastError.message}` : ''}。`,
      );
      error.code = 'desktop_helper_unavailable';
      error.cause = lastError;
      throw error;
    } catch (err) {
      cleanupSessionFiles(candidate);
      throw err;
    }
  }

  async function ensureStarted() {
    if (session) {
      try {
        const ping = await requestOverSocket(session.socketPath, { token: session.token, op: 'ping' }, 1500);
        if (ping && ping.ok) return session;
      } catch {
        cleanupSessionFiles(session);
        session = null;
      }
    }
    if (!startingPromise) {
      startingPromise = launchFreshSession().finally(() => {
        startingPromise = null;
      });
    }
    return startingPromise;
  }

  async function stop() {
    const active = session;
    session = null;
    if (!active) return;
    try {
      await requestOverSocket(active.socketPath, { token: active.token, op: 'shutdown' }, 1000);
    } catch {
      /* helper may already have exited */
    }
    cleanupSessionFiles(active);
  }

  async function restart() {
    await stop();
    return ensureStarted();
  }

  async function call(op, extra = {}, options = {}) {
    const active = options.restart ? await restart() : await ensureStarted();
    const timeoutMs = Number(options.timeoutMs || DEFAULT_REQUEST_TIMEOUT_MS);
    const canPostInput = ['exec', 'stage_act'].includes(op);
    try {
      return await requestOverSocket(
        active.socketPath,
        { token: active.token, op, ...extra },
        timeoutMs,
      );
    } catch (err) {
      // Losing the reply can happen after the helper has already posted a key or click.
      if (canPostInput && err.dispatched !== false) throw unknownExecutionOutcome(err);
      if (op === 'permissions' || op === 'capture_window' || op === 'stage_status' || op === 'stage_window'
        || (canPostInput && err.dispatched === false)) {
        cleanupSessionFiles(active);
        if (session === active) session = null;
        const fresh = await ensureStarted();
        try {
          return await requestOverSocket(fresh.socketPath, { token: fresh.token, op, ...extra }, timeoutMs);
        } catch (retryError) {
          if (canPostInput && retryError.dispatched !== false) throw unknownExecutionOutcome(retryError);
          throw retryError;
        }
      }
      throw err;
    }
  }

  async function getPermissions(options = {}) {
    return call('permissions', {}, {
      restart: options.restart === true,
      timeoutMs: 5000,
    });
  }

  async function requestPermission(kind) {
    return call('request_permission', { kind: kind === 'accessibility' ? 'accessibility' : 'screen' }, {
      timeoutMs: 5000,
    });
  }

  /**
   * Drop-in runner compatible with `observe.cjs` and `act.cjs`.
   */
  async function exec(command, args = [], options = {}) {
    const timeoutMs = Number(options.timeout || 15000);
    const response = await call('exec', {
      command: String(command || ''),
      args: Array.isArray(args) ? args.map((item) => String(item)) : [],
      timeoutMs,
    }, {
      timeoutMs: timeoutMs + 5000,
    });

    if (!response || typeof response.ok !== 'boolean' || response.code === 'ETIMEDOUT') {
      throw unknownExecutionOutcome(new Error(response?.error || 'Missing execution acknowledgement'));
    }
    if (!response.ok) {
      const message = String(response?.error || response?.stderr || 'Helper command failed').trim();
      const error = new Error(message);
      error.code = response?.code || response?.exitCode || 'helper_exec_failed';
      error.stdout = String(response?.stdout || '');
      error.stderr = String(response?.stderr || '');
      throw error;
    }

    return {
      stdout: String(response.stdout || ''),
      stderr: String(response.stderr || ''),
    };
  }

  /**
   * Native ScreenCaptureKit window + same-app popup/dropdown capture via helper.
   */
  async function captureWindow(options = {}) {
    const timeoutMs = Number(options.timeoutMs || 12000);
    const response = await call('capture_window', {
      windowId: Number(options.windowId || 0),
      includePopups: options.includePopups !== false,
      popupWaitMs: options.popupWaitMs || 0,
      maxEdge: Number(options.maxEdge || 1440),
      format: String(options.format || 'png'),
      quality: Number(options.quality || 0.78),
      timeoutMs,
    }, {
      timeoutMs: timeoutMs + 5000,
    });
    if (!response || !response.ok) {
      const message = String(response?.error || 'ScreenCaptureKit capture failed').trim();
      const error = new Error(message);
      error.code = response?.code || 'sc_capture_failed';
      throw error;
    }
    return response;
  }

  /**
   * Query whether the macOS CGVirtualDisplay Virtual Stage is active and which windows are staged.
   */
  async function stageStatus() {
    const response = await call('stage_status', {}, { timeoutMs: 5000 });
    if (!response || !response.ok) {
      const error = new Error(String(response?.error || 'Failed to query virtual stage status').trim());
      error.code = response?.code || 'virtual_stage_failed';
      throw error;
    }
    return response;
  }

  /**
   * Move an allowed application window onto the isolated macOS CGVirtualDisplay Virtual Stage.
   */
  async function stageWindow(options = {}) {
    const timeoutMs = Number(options.timeoutMs || 12000);
    const response = await call('stage_window', {
      windowId: Number(options.windowId || 0),
      ...(options.pid != null ? { pid: Number(options.pid) } : {}),
      appName: String(options.appName || ''),
      bundleId: String(options.bundleId || ''),
      appPath: String(options.appPath || options.path || ''),
    }, { timeoutMs });
    if (!response || !response.ok) {
      const error = new Error(String(response?.error || 'Failed to stage window on virtual display').trim());
      error.code = response?.code || 'stage_move_failed';
      throw error;
    }
    return response;
  }

  /**
   * Return a staged window back to its original physical display position.
   */
  async function stageRelease(options = {}) {
    const response = await call('stage_release', {
      windowId: Number(options.windowId || 0),
      focus: options.focus === true,
      teardownIfEmpty: options.teardownIfEmpty !== false,
    }, { timeoutMs: 8000 });
    if (!response || !response.ok) {
      const error = new Error(String(response?.error || 'Failed to release staged window').trim());
      error.code = response?.code || 'stage_release_failed';
      throw error;
    }
    return response;
  }

  /**
   * Execute an atomic batch of visual/keyboard actions on the Virtual Stage with cursor & focus
   * save/restore and pre-restore ScreenCaptureKit composite capture (preserving popups/dropdowns).
   */
  async function stageAct(options = {}) {
    const timeoutMs = Number(options.timeoutMs || 28000);
    const response = await call('stage_act', {
      windowId: Number(options.windowId || 0),
      ...(options.pid != null ? { pid: Number(options.pid) } : {}),
      appName: String(options.appName || ''),
      bundleId: String(options.bundleId || ''),
      appPath: String(options.appPath || options.path || ''),
      actions: Array.isArray(options.actions) ? options.actions : [],
      ...(options.searchField ? { searchField: true } : {}),
      captureAfter: options.captureAfter !== false,
      settleMs: options.settleMs != null ? Number(options.settleMs) : 260,
      popupWaitMs: options.popupWaitMs || 0,
      includePopups: options.includePopups !== false,
      maxEdge: Number(options.maxEdge || 1440),
      restoreFocus: options.restoreFocus !== false,
    }, { timeoutMs });
    if (!response || typeof response.ok !== 'boolean') {
      throw unknownExecutionOutcome(new Error(response?.error || 'Missing virtual stage execution acknowledgement'));
    }
    if (!response.ok && !Array.isArray(response.steps)) {
      const error = new Error(String(response?.error || 'Virtual stage action failed').trim());
      error.code = response?.code || 'virtual_stage_failed';
      throw error;
    }
    return response;
  }

  async function stageTeardown() {
    try {
      await call('stage_teardown', {}, { timeoutMs: 5000 });
    } catch {
      /* best effort */
    }
  }

  return {
    HELPER_APP_NAME,
    HELPER_DISPLAY_NAME,
    HELPER_BUNDLE_ID,
    resolveAppPath: resolveApp,
    ensureStarted,
    restart,
    stop,
    getPermissions,
    requestPermission,
    exec,
    captureWindow,
    stageStatus,
    stageWindow,
    stageRelease,
    stageAct,
    stageTeardown,
  };
}

const defaultHelperClient = createComputerUseHelperClient();

module.exports = {
  HELPER_APP_NAME,
  HELPER_DISPLAY_NAME,
  HELPER_BUNDLE_ID,
  HELPER_EXECUTABLE_NAME,
  resolveHelperAppPath,
  sendSocketRequest,
  createComputerUseHelperClient,
  defaultHelperClient,
};
