/** One quit boundary for Dock, application menu and tray. Window close is separate. */
function installApplicationShutdown({ app, updaterOwnsQuit, stopUi, steps, report = console.error }) {
  let closing;
  let complete = false;

  async function runStep({ label, run, timeoutMs }) {
    let timer;
    try {
      await Promise.race([
        Promise.resolve().then(run),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error(`${label} shutdown timed out`)), timeoutMs);
        }),
      ]);
    } catch (error) {
      report(`[pi-studio] ${label} shutdown failed`, error);
    } finally {
      clearTimeout(timer);
    }
  }

  app.on('before-quit', event => {
    app.isQuitting = true;
    // Updating must retain the updater's native quit/install path.
    if (complete || updaterOwnsQuit()) return;
    event.preventDefault();
    if (closing) return;
    closing = (async () => {
      try {
        // Remove tray and completion listeners immediately, before asynchronous cleanup.
        await runStep({ label: 'UI', run: stopUi, timeoutMs: 1_000 });
        for (const group of steps) await Promise.all(group.map(runStep));
      } catch (error) {
        report('[pi-studio] shutdown failed', error);
      } finally {
        complete = true;
        app.exit(0);
      }
    })();
  });
  // Do not cancel will-quit: it is the final native termination phase, not a
  // second cleanup gate. Cancelling there can leave a windowless app alive.
}

module.exports = { installApplicationShutdown };
