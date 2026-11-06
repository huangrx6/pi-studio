const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  createTerminalSessionManager,
  shellArgsForPlatform,
} = require('../../electron/services/terminal-sessions.cjs');

class FakePty {
  constructor() {
    this.dataListeners = [];
    this.exitListeners = [];
    this.writes = [];
    this.resizes = [];
    this.killed = false;
  }

  onData(listener) {
    this.dataListeners.push(listener);
  }

  onExit(listener) {
    this.exitListeners.push(listener);
  }

  write(data) {
    this.writes.push(data);
  }

  resize(cols, rows) {
    this.resizes.push([cols, rows]);
  }

  kill() {
    this.killed = true;
  }

  emitData(data) {
    for (const listener of this.dataListeners) listener(data);
  }

  emitExit(exitCode = 0, signal) {
    for (const listener of this.exitListeners) listener({ exitCode, signal });
  }
}

function fixture() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-studio-terminal-'));
  const processes = [];
  const spawns = [];
  const events = [];
  const manager = createTerminalSessionManager({
    cwd,
    spawnPty: (shell, args, options) => {
      const pty = new FakePty();
      processes.push(pty);
      spawns.push({ shell, args, options });
      return pty;
    },
    send: (_ownerId, channel, payload) => events.push({ channel, payload }),
    maxOutputChars: 8,
    now: () => 1_000,
    platform: 'darwin',
    environment: { SHELL: '/bin/zsh' },
  });
  return { cwd, manager, processes, spawns, events };
}

test('terminal sessions keep a bounded replay buffer and sequenced events', () => {
  const { cwd, manager, processes, spawns, events } = fixture();
  const created = manager.create({ ownerId: 7, id: 'terminal:one', cwd, cols: 80, rows: 20 });
  assert.equal(created.createdNow, true);
  assert.equal(created.cwd, cwd);
  assert.deepEqual(created.replay, { cols: 80, rows: 20, steps: [], truncated: false });
  assert.equal(processes.length, 1);
  assert.deepEqual(spawns[0].args, ['-l']);

  processes[0].emitData('abcdef');
  processes[0].emitData('ghijkl');
  const snapshot = manager.create({ ownerId: 7, id: 'terminal:one', cwd, cols: 80, rows: 20 });
  assert.equal(snapshot.replay.steps.filter(step => step.type === 'data').map(step => step.data).join(''), 'efghijkl');
  assert.equal(snapshot.replay.truncated, true);
  assert.equal(snapshot.sequence, 2);
  assert.deepEqual(events.map((event) => event.payload.sequence), [1, 2]);
  assert.equal(events[0].channel, 'pi:terminal-event');
});

test('terminal sessions write, resize, replay and close without exposing handles', () => {
  const { cwd, manager, processes } = fixture();
  manager.create({ ownerId: 7, id: 'terminal:one', cwd, cols: 80, rows: 20 });
  assert.deepEqual(manager.write({ ownerId: 7, id: 'terminal:one', data: 'pwd\r' }), { ok: true });
  assert.deepEqual(manager.resize({ ownerId: 7, id: 'terminal:one', cols: 120, rows: 40 }), { ok: true });
  assert.deepEqual(processes[0].writes, ['pwd\r']);
  assert.deepEqual(processes[0].resizes.at(-1), [120, 40]);

  const reattached = manager.create({ ownerId: 7, id: 'terminal:one', cwd, cols: 90, rows: 30 });
  assert.equal(reattached.createdNow, false);
  assert.deepEqual(processes[0].resizes.at(-1), [90, 30]);
  assert.equal('ptyProcess' in reattached, false);

  manager.close({ ownerId: 7, id: 'terminal:one' });
  assert.equal(processes[0].killed, true);
  assert.deepEqual(manager.snapshot(), []);
});

test('terminal sessions reject cross-window access and enforce the session cap', () => {
  const { cwd, manager } = fixture();
  manager.create({ ownerId: 7, id: 'terminal:one', cwd, cols: 80, rows: 20 });
  assert.throws(
    () => manager.create({ ownerId: 8, id: 'terminal:one', cwd }),
    /不属于当前窗口/,
  );

  const capped = createTerminalSessionManager({
    spawnPty: () => new FakePty(),
    maxSessions: 1,
    cwd,
    platform: 'darwin',
    environment: { SHELL: '/bin/zsh' },
  });
  capped.create({ ownerId: 1, id: 'one', cwd });
  assert.throws(() => capped.create({ ownerId: 1, id: 'two', cwd }), /最多同时打开 1 个终端/);
});

test('reattaching journals intervening geometry without rewriting already returned snapshots', () => {
  const { cwd, manager, processes } = fixture();
  manager.create({ ownerId: 7, id: 'one', cwd, cols: 36, rows: 39 });
  processes[0].emitData('A');
  manager.resize({ ownerId: 7, id: 'one', cols: 55, rows: 33 });
  processes[0].emitData('B');
  const attached = manager.create({ ownerId: 7, id: 'one', cwd: '/ignored-new-cwd', cols: 60, rows: 30 });
  assert.deepEqual(attached.replay, {
    cols: 36, rows: 39, truncated: false,
    steps: [{ type: 'data', data: 'A' }, { type: 'resize', cols: 55, rows: 33 }, { type: 'data', data: 'B' }, { type: 'resize', cols: 60, rows: 30 }],
  });
  assert.equal(attached.cwd, cwd); assert.equal(attached.sequence, 2);
  processes[0].emitData('C');
  assert.equal(attached.replay.steps.length, 4);
  assert.equal('output' in attached, false);
  assert.equal(processes.length, 1);
  manager.closeOwner(7); fs.rmSync(cwd, { recursive: true, force: true });
});

test('closing an owner kills every PTY it owns', () => {
  const { cwd, manager, processes } = fixture();
  manager.create({ ownerId: 7, id: 'terminal:one', cwd });
  manager.create({ ownerId: 7, id: 'terminal:two', cwd });
  manager.closeOwner(7);
  assert.ok(processes.every((processInfo) => processInfo.killed));
  assert.deepEqual(manager.snapshot(), []);
});

test('POSIX terminals use a login shell while Windows and unknown shells do not', () => {
  assert.deepEqual(shellArgsForPlatform('/bin/zsh', 'darwin'), ['-l']);
  assert.deepEqual(shellArgsForPlatform('/opt/homebrew/bin/fish', 'darwin'), ['-l']);
  assert.deepEqual(shellArgsForPlatform('/bin/bash', 'linux'), ['-l']);
  assert.deepEqual(shellArgsForPlatform('/custom/terminal-shell', 'linux'), []);
  assert.deepEqual(shellArgsForPlatform('C:\\Windows\\System32\\cmd.exe', 'win32'), []);
});
