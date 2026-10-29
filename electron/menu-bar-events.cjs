/**
 * Small process-local bridge between app/session state and the menu-bar UI.
 *
 * Session and appearance code can publish events without importing Electron
 * services. This keeps those layers testable and lets menu-bar initialization
 * decide when native Tray/BrowserWindow work should begin.
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
