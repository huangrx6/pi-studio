/**
 * Session hardening for the right-panel browser.
 *
 * The guest page is untrusted: it may only speak http(s) over the network and
 * may not use device permissions. Requests are filtered at the session layer
 * because embedder-initiated `loadURL` skips both `will-navigate` and
 * `will-frame-navigate`, so a navigation guard alone cannot stop a `file:` load.
 */
const { session } = require('electron');

const BROWSER_PARTITION = 'persist:pi-browser';
const DENIED_PERMISSIONS = new Set([
  'media',
  'geolocation',
  'midi',
  'midiSysex',
  'notifications',
  'openExternal',
  'pointerLock',
  'fullscreen',
  'idle-detection',
  'hid',
  'serial',
  'usb',
  'clipboard-read',
]);

function isAllowedRequest(url, resourceType) {
  if (url === 'about:blank' || url.startsWith('data:')) return true;
  if (/^https?:/i.test(url)) return true;
  // Devtools and blob sources are internal to the guest renderer.
  if (/^(blob|devtools|chrome-extension):/i.test(url)) return true;
  void resourceType;
  return false;
}

function installBrowserSessionGuards() {
  const browserSession = session.fromPartition(BROWSER_PARTITION);
  browserSession.webRequest.onBeforeRequest((details, callback) => {
    callback({ cancel: !isAllowedRequest(details.url, details.resourceType) });
  });
  browserSession.setPermissionRequestHandler((_contents, permission, callback) => {
    callback(!DENIED_PERMISSIONS.has(permission));
  });
  browserSession.setPermissionCheckHandler((_contents, permission) => !DENIED_PERMISSIONS.has(permission));
  return browserSession;
}

module.exports = { BROWSER_PARTITION, installBrowserSessionGuards };
