/**
 * Small process-local bridge between session execution and the menu-bar UI.
 *
 * Session IPC can publish lifecycle events without importing Electron services.
 * This keeps the session layer testable and lets menu-bar initialization decide
 * when native Tray/BrowserWindow work should begin.
 */

const listeners = new Set();

function publishMenuBarEvent(event) {
  if (!event || typeof event !== 'object' || typeof event.type !== 'string') return;
  for (const listener of [...listeners]) {
    try {
      listener(event);
    } catch {
      // A presentation failure must never affect a running agent turn.
    }
  }
}

function subscribeMenuBarEvent(listener) {
  if (typeof listener !== 'function') return () => {};
  listeners.add(listener);
  return () => listeners.delete(listener);
}

module.exports = { publishMenuBarEvent, subscribeMenuBarEvent };
