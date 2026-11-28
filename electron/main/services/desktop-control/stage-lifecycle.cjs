const { AsyncLocalStorage } = require('node:async_hooks');

function createDesktopStageLifecycle({ release, onClose }) {
  const scope = new AsyncLocalStorage();
  const runs = new Map();
  const owners = new Map();
  let serial = Promise.resolve();
  let generation = 0;

  // The native helper has one virtual display. Keep restoration in order with
  // stage requests already in flight, including requests whose reply was lost.
  function enqueue(work) {
    const pending = serial.then(work);
    serial = pending.catch(() => {});
    return pending;
  }

  function assertOpen(run) {
    if (run?.closed) throw Object.assign(new Error('此轮桌面操作已结束。'), { code: 'desktop_run_ended' });
  }

  function finish(run) {
    if (run.closed) return;
    run.closed = true;
    runs.delete(run.sessionId);
    // Durable observers are synchronous. Keep IPC and native work off the commit line.
    queueMicrotask(() => {
      run.observation?.detach();
      onClose(run.sessionId, run.id);
    });
    void enqueue(async () => {
      for (const [windowId, borrowers] of owners) {
        if (!borrowers.delete(run) || borrowers.size) continue;
        owners.delete(windowId);
        const options = { windowId, focus: false, teardownIfEmpty: true };
        let result;
        try {
          result = await release(options);
        } catch {
          // An acknowledgement can be lost. Restoring a window is idempotent.
          try { result = await release(options); }
          catch (error) { console.warn('[pi-studio] 后台窗口恢复失败', windowId, error.code || error.message); }
        }
        if (result?.reason === 'window_geometry_changed') {
          console.warn('[pi-studio] 后台窗口结束时的位置或尺寸有变化', windowId, result.originalBounds, result.windowBounds);
        }
      }
    });
  }

  function attach(sessionId, observe) {
    const run = { sessionId, id: String(++generation), closed: false };
    runs.set(sessionId, run);
    let latest;
    function changed(live) {
      if (!live?.run || live.run.afterRun) finish(run);
      else if (run.first == null) run.first = live.run.first;
      else if (live.run.first != null && live.run.first !== run.first) finish(run);
    }
    run.ready = Promise.resolve().then(() => observe({
      advance(call) {
        latest = call.value;
        changed(latest);
      },
      end() { finish(run); },
    })).then(observation => {
      run.observation = observation;
      if (run.closed) { observation?.detach(); return; }
      run.first = observation?.value?.run?.first;
      changed(latest || observation?.value);
    }).catch(error => {
      finish(run);
      throw error;
    });
    return run;
  }

  async function withRun(sessionId, observe, work, signal) {
    signal?.throwIfAborted();
    const run = runs.get(sessionId) || attach(sessionId, observe);
    await run.ready;
    assertOpen(run);
    signal?.throwIfAborted();
    // A cancelled native request may still complete. Invalidate its scope
    // immediately; restoration is queued behind the native acknowledgement.
    const abort = () => finish(run);
    signal?.addEventListener('abort', abort, { once: true });
    try { return await scope.run(run, work); }
    finally { signal?.removeEventListener('abort', abort); }
  }

  function stage(work, options) {
    const run = scope.getStore();
    return enqueue(async () => {
      assertOpen(run);
      const id = Number(options.windowId);
      let borrowers = owners.get(id);
      if (!borrowers) owners.set(id, borrowers = new Set());
      // Session-less explicit stage requests own their window until an explicit release.
      // A failed move may still have taken effect. A bound popup click,
      // however, never moves its parent and can only borrow an existing stage.
      const alreadyBorrowed = borrowers.has(run);
      const inPlace = options.actions?.length === 1 && options.actions[0].popupWindowId != null;
      if (!inPlace) borrowers.add(run);
      try {
        const result = await work(options);
        if (result?.staged === true) borrowers.add(run);
        if (result?.staged === false && !alreadyBorrowed) borrowers.delete(run);
        return result;
      } finally {
        if (!borrowers.size) owners.delete(id);
      }
    });
  }

  function releaseExplicitly(options) {
    return enqueue(async () => {
      const result = await release(options);
      owners.delete(Number(options.windowId));
      return result;
    });
  }

  return { withRun, stage, releaseExplicitly, current: () => scope.getStore() };
}

module.exports = { createDesktopStageLifecycle };
