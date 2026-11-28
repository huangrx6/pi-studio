const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { readFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { createDesktopStageLifecycle } = require('../../electron/main/services/desktop-control/stage-lifecycle.cjs');

test('macOS stage verifies and reapplies a frame resized after a display move', { skip: process.platform !== 'darwin' }, () => {
  const restoration = readFileSync(path.join(__dirname, '../../scripts/build/computer-use-helper/WindowRestoration.swift'), 'utf8');
  const scenario = `
    let target = CGRect(x: 144, y: 82, width: 1682, height: 945)
    let rehomed = CGRect(x: -1, y: 30, width: 1441, height: 870)
    var frame = target
    var ticks = 0
    var writes = 0
    let final = restoreWindowFrame(target: target, read: { frame }, apply: {
      frame = $0
      writes += 1
    }, wait: {
      ticks += 1
      if ticks == 1 { frame = rehomed }
    })
    precondition(final == target && writes == 1)
    let clamped = restoreWindowFrame(target: target, read: { rehomed }, apply: { _ in }, wait: {})
    precondition(clamped == rehomed && !sameWindowFrame(clamped!, target))
    let closed = restoreWindowFrame(target: target, read: { nil }, apply: { _ in fatalError() }, wait: {})
    precondition(closed == nil)

    let physicalDisplay = CGRect(x: 0, y: 0, width: 1440, height: 900)
    let beforeDisconnect = CGRect(x: 0, y: 82, width: 1682, height: 945)
    let sliver = CGRect(x: -1624, y: 82, width: 1682, height: 945)
    let movedByUser = CGRect(x: 200, y: 100, width: 1682, height: 945)
    precondition(physicalDisplay.intersection(sliver).width == 58)
    precondition(shouldRestoreAfterDisconnect(sliver, target: beforeDisconnect,
      ownedFrame: beforeDisconnect, displays: [physicalDisplay]), "repair a late offscreen relocation")
    precondition(!shouldRestoreAfterDisconnect(movedByUser, target: beforeDisconnect,
      ownedFrame: beforeDisconnect, displays: [physicalDisplay]), "preserve the user's new visible position")
    precondition(!shouldRestoreAfterDisconnect(sliver, target: sliver,
      ownedFrame: beforeDisconnect, displays: [physicalDisplay]), "preserve an intentionally offscreen starting frame")
  `;
  execFileSync('/usr/bin/swift', ['-module-cache-path', path.join(tmpdir(), 'pi-studio-swift-module-cache'), '-'], {
    input: restoration + scenario, timeout: 60000,
  });
});

function fixture() {
  const closed = [];
  const released = [];
  const observers = new Map();
  const { withRun, stage, current, releaseExplicitly } = createDesktopStageLifecycle({
    release: async options => { released.push(options); return { ok: true }; },
    onClose: (sessionId, runId) => closed.push([sessionId, runId]),
  });
  function execute(sessionId, work, signal) {
    return withRun(sessionId, async observer => {
      observers.set(sessionId, observer);
      return {
        value: { run: { first: 1 } },
        detach() {
          if (observers.get(sessionId) === observer) observers.delete(sessionId);
        },
      };
    }, work, signal);
  }
  const tick = () => new Promise(resolve => setImmediate(resolve));
  const borrow = windowId => stage(async () => ({ staged: true }), { windowId });
  return { closed, released, observers, execute, tick, borrow, current, stage, releaseExplicitly };
}

test('Durable completion, failure, and a queued replacement restore only the final borrower', async () => {
  const f = fixture();
  await f.execute('a', () => f.borrow(10));
  await f.execute('b', async () => { await f.borrow(10); await f.borrow(11); });
  f.observers.get('a').advance({ value: { run: { first: 1, afterRun: {} } } });
  await f.tick();
  assert.deepEqual(f.released, []);
  assert.equal(f.observers.has('a'), false);
  f.observers.get('b').advance({ value: { runFailure: { reason: 'error' } } });
  await f.tick();
  assert.deepEqual(f.released, [10, 11].map(windowId => ({ windowId, focus: false, teardownIfEmpty: true })));
  await f.execute('b', () => f.borrow(12));
  f.observers.get('b').advance({ value: { run: { first: 2 } } });
  await f.tick();
  assert.equal(f.released.at(-1).windowId, 12);
  assert.deepEqual(f.closed.map(([session]) => session), ['a', 'b', 'b']);
});

test('abort during a native move suppresses late previews and restores the window after acknowledgement', async () => {
  const f = fixture();
  const controller = new AbortController();
  let acknowledge;
  let started;
  const pending = new Promise(resolve => { started = resolve; });
  const work = f.execute('a', async () => {
    await f.stage(() => new Promise(resolve => { acknowledge = resolve; started(); }), { windowId: 17 });
    assert.equal(f.current().closed, true);
    await assert.rejects(f.borrow(18), { code: 'desktop_run_ended' });
  }, controller.signal);
  await pending;
  controller.abort();
  await f.tick();
  assert.equal(f.closed.length, 1);
  assert.deepEqual(f.released, []);
  acknowledge({ staged: true });
  await work;
  assert.deepEqual(f.released, [{ windowId: 17, focus: false, teardownIfEmpty: true }]);
});

test('a manual stage remains owned across automatic runs and a lost action reply is cleaned up', async () => {
  const f = fixture();
  await f.borrow(42);
  await f.execute('a', async () => {
    await f.borrow(42);
    await assert.rejects(f.stage(async () => { throw new Error('lost reply'); }, { windowId: 55 }));
  });
  f.observers.get('a').end();
  await f.tick();
  assert.deepEqual(f.released, [{ windowId: 55, focus: false, teardownIfEmpty: true }]);
  await f.releaseExplicitly({ windowId: 42, focus: true });
  await f.execute('b', () => f.borrow(42));
  f.observers.get('b').advance({ value: {} });
  await f.tick();
  assert.deepEqual(f.released.at(-1), { windowId: 42, focus: false, teardownIfEmpty: true });
});
