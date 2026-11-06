/**
 * Main-process ownership for interactive terminal sessions.
 *
 * A renderer receives only JSON-safe session metadata and output strings. PTY
 * handles, child environment objects and process objects never cross the
 * context bridge. Sessions deliberately outlive individual React mounts so a
 * user can switch panel tabs without interrupting a running development
 * server; explicit tab closure or window destruction owns final cleanup.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createTerminalReplay } = require('./terminal-replay.cjs');

const MAX_SESSIONS_PER_RENDERER = 8;
const MAX_OUTPUT_CHARS = 1_000_000;
const MAX_WRITE_CHARS = 64 * 1024;
const LOGIN_SHELLS = new Set([
  'bash',
  'csh',
  'dash',
  'fish',
  'ksh',
  'mksh',
  'nu',
  'sh',
  'tcsh',
  'zsh',
]);

function clampDimension(value, fallback, minimum, maximum) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.round(numeric)));
}

function normalizeCwd(candidate) {
  const requested = typeof candidate === 'string' && candidate.trim()
    ? path.resolve(candidate)
    : os.homedir();
  try {
    if (fs.statSync(requested).isDirectory()) return requested;
  } catch {
    // A removed session workspace should not prevent opening a terminal.
  }
  return os.homedir();
}

function shellForPlatform(platform = process.platform, environment = process.env) {
  if (platform === 'win32') {
    const command = environment.ComSpec || environment.COMSPEC;
    return command || 'cmd.exe';
  }
  const candidate = environment.SHELL;
  if (candidate && path.isAbsolute(candidate)) {
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // Fall through to the platform default.
    }
  }
  try {
    fs.accessSync('/bin/zsh', fs.constants.X_OK);
    return '/bin/zsh';
  } catch {
    return '/bin/sh';
  }
}

function shellArgsForPlatform(shell, platform = process.platform) {
  if (platform === 'win32') return [];
  const executable = path.basename(shell).replace(/\.exe$/i, '').toLowerCase();
  return LOGIN_SHELLS.has(executable) ? ['-l'] : [];
}

function sessionDto(session, includeOutput = false) {
  return {
    id: session.id,
    title: session.title,
    shell: session.shell,
    cwd: session.cwd,
    status: session.status,
    createdAt: session.createdAt,
    exitedAt: session.exitedAt,
    exitCode: session.exitCode,
    sequence: session.sequence,
    ...(includeOutput ? { replay: session.replay.snapshot() } : {}),
  };
}

function loadNodePty() {
  if (process.platform !== 'win32') {
    try {
      const packageRoot = path.resolve(path.dirname(require.resolve('node-pty')), '..');
      const helper = path.join(
        packageRoot,
        'prebuilds',
        `${process.platform}-${process.arch}`,
        'spawn-helper',
      );
      fs.accessSync(helper, fs.constants.X_OK);
    } catch {
      try {
        const packageRoot = path.resolve(path.dirname(require.resolve('node-pty')), '..');
        const helper = path.join(
          packageRoot,
          'prebuilds',
          `${process.platform}-${process.arch}`,
          'spawn-helper',
        );
        fs.chmodSync(helper, 0o755);
      } catch {
        // Packaging validates the helper permission explicitly; require()
        // below will surface a precise native-module error if it is missing.
      }
    }
  }
  return require('node-pty');
}

/**
 * @param {{
 *   spawnPty?: (shell: string, args: string[], options: Record<string, unknown>) => any,
 *   send?: (ownerId: number, channel: string, payload: unknown) => void,
 *   maxSessions?: number,
 *   maxOutputChars?: number,
 *   now?: () => number,
 *   platform?: NodeJS.Platform,
 *   environment?: NodeJS.ProcessEnv,
 * }} options
 */
function createTerminalSessionManager(options = {}) {
  const spawnPty = options.spawnPty || ((shell, args, spawnOptions) => {
    const nodePty = loadNodePty();
    return nodePty.spawn(shell, args, spawnOptions);
  });
  const send = options.send || (() => {});
  const maxSessions = options.maxSessions || MAX_SESSIONS_PER_RENDERER;
  const maxOutputChars = options.maxOutputChars || MAX_OUTPUT_CHARS;
  const now = options.now || Date.now;
  const platform = options.platform || process.platform;
  const environment = options.environment || process.env;
  const sessions = new Map();

  function sessionsForOwner(ownerId) {
    return [...sessions.values()].filter((session) => session.ownerId === ownerId);
  }

  function assertOwner(session, ownerId) {
    if (!session || session.ownerId !== ownerId) {
      throw new Error('终端会话不存在或不属于当前窗口');
    }
  }

  function emit(session, payload) {
    try {
      send(session.ownerId, 'pi:terminal-event', payload);
    } catch {
      // The owning renderer may have been destroyed while the PTY exited.
    }
  }

  function create({ ownerId, id, cwd, cols, rows } = {}) {
    if (!Number.isInteger(ownerId)) throw new Error('终端缺少有效的窗口标识');
    if (typeof id !== 'string' || !id || id.length > 100) throw new Error('终端标识无效');
    const existing = sessions.get(id);
    if (existing) {
      assertOwner(existing, ownerId);
      resize({ ownerId, id, cols, rows });
      return { ...sessionDto(existing, true), createdNow: false };
    }
    if (sessionsForOwner(ownerId).length >= maxSessions) {
      throw new Error(`最多同时打开 ${maxSessions} 个终端`);
    }

    const shell = shellForPlatform(platform, environment);
    const shellArgs = shellArgsForPlatform(shell, platform);
    const workingDirectory = normalizeCwd(cwd);
    const title = path.basename(shell).replace(/\.exe$/i, '') || 'shell';
    const initialCols = clampDimension(cols, 90, 20, 500);
    const initialRows = clampDimension(rows, 24, 5, 300);
    // A GUI-launched app inherits a minimal launchd environment. Starting the
    // user's login shell lets ~/.zprofile run `brew shellenv` before ~/.zshrc
    // resolves Homebrew tools, matching Terminal.app instead of only /usr/bin.
    const ptyProcess = spawnPty(shell, shellArgs, {
      name: 'xterm-256color',
      cols: initialCols,
      rows: initialRows,
      cwd: workingDirectory,
      env: {
        ...environment,
        TERM: 'xterm-256color',
        TERM_PROGRAM: 'Pi Studio',
        PI_STUDIO_TERMINAL: '1',
      },
    });
    const session = {
      id,
      ownerId,
      title,
      shell,
      cwd: workingDirectory,
      status: 'running',
      createdAt: now(),
      exitedAt: undefined,
      exitCode: undefined,
      replay: createTerminalReplay({ cols: initialCols, rows: initialRows, maxChars: maxOutputChars }),
      sequence: 0,
      ptyProcess,
    };
    sessions.set(id, session);

    ptyProcess.onData((data) => {
      if (sessions.get(id) !== session) return;
      session.replay.append(String(data));
      session.sequence += 1;
      emit(session, { id, type: 'data', data: String(data), sequence: session.sequence });
    });
    ptyProcess.onExit(({ exitCode, signal } = {}) => {
      if (sessions.get(id) !== session) return;
      session.status = 'exited';
      session.exitCode = exitCode;
      session.exitedAt = now();
      emit(session, { id, type: 'exit', exitCode, signal, status: 'exited' });
    });

    // Even the first attach needs its PTY's initial geometry: the renderer may
    // have been resized while this IPC response was in flight.
    return { ...sessionDto(session, true), createdNow: true };
  }

  function write({ ownerId, id, data } = {}) {
    const session = sessions.get(id);
    assertOwner(session, ownerId);
    if (session.status !== 'running') return { ok: false, status: session.status };
    if (typeof data !== 'string' || data.length > MAX_WRITE_CHARS) throw new Error('终端输入无效');
    session.ptyProcess.write(data);
    return { ok: true };
  }

  function resize({ ownerId, id, cols, rows } = {}) {
    const session = sessions.get(id);
    assertOwner(session, ownerId);
    if (session.status !== 'running') return { ok: false, status: session.status };
    const nextCols = clampDimension(cols, 90, 20, 500);
    const nextRows = clampDimension(rows, 24, 5, 300);
    session.ptyProcess.resize(nextCols, nextRows);
    session.replay.resize(nextCols, nextRows);
    return { ok: true };
  }

  function close({ ownerId, id } = {}) {
    const session = sessions.get(id);
    if (!session) return { ok: true };
    assertOwner(session, ownerId);
    sessions.delete(id);
    try {
      session.ptyProcess.kill();
    } catch {
      // Process may already have exited.
    }
    return { ok: true };
  }

  function closeOwner(ownerId) {
    for (const session of sessionsForOwner(ownerId)) {
      sessions.delete(session.id);
      try {
        session.ptyProcess.kill();
      } catch {
        // Process may already have exited.
      }
    }
  }

  function shutdown() {
    for (const ownerId of new Set([...sessions.values()].map((session) => session.ownerId))) {
      closeOwner(ownerId);
    }
  }

  function snapshot() {
    return [...sessions.values()].map((session) => sessionDto(session, false));
  }

  return { create, write, resize, close, closeOwner, shutdown, snapshot };
}

module.exports = {
  MAX_OUTPUT_CHARS,
  MAX_SESSIONS_PER_RENDERER,
  createTerminalSessionManager,
  normalizeCwd,
  shellArgsForPlatform,
  shellForPlatform,
};
