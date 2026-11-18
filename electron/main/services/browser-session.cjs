/**
 * Session hardening for the right-panel browser.
 *
 * The guest page is untrusted: it may only speak http(s) over the network or
 * render an explicitly selected local HTML document. Requests are filtered at
 * the session layer because embedder-initiated `loadURL` skips both
 * `will-navigate` and `will-frame-navigate`.
 */
const { session } = require('electron');
const path = require('node:path');
const { resolveLocalHtmlAsset, resolveLocalHtmlDocument } = require('./local-html.cjs');

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

const localHtmlRoots = new Map();

function isAllowedRequest(url, resourceType, webContentsId) {
  // A network/about page must never inherit the previous local document's
  // directory allowance when the same webview navigates again.
  if (resourceType === 'mainFrame') localHtmlRoots.delete(webContentsId);
  if (url === 'about:blank' || url.startsWith('data:')) return true;
  if (/^https?:/i.test(url)) return true;
  // Devtools and blob sources are internal to the guest renderer.
  if (/^(blob|devtools|chrome-extension):/i.test(url)) return true;
  if (/^file:/i.test(url)) {
    const document = resolveLocalHtmlDocument(url);
    if (document && (resourceType === 'mainFrame' || !localHtmlRoots.has(webContentsId))) {
      localHtmlRoots.set(webContentsId, path.dirname(document));
      return true;
    }
    const root = localHtmlRoots.get(webContentsId);
    if (root && resolveLocalHtmlAsset(url, root)) return true;
  }
  return false;
}

function installBrowserSessionGuards() {
  const browserSession = session.fromPartition(BROWSER_PARTITION);
  browserSession.webRequest.onBeforeRequest((details, callback) => {
    callback({ cancel: !isAllowedRequest(details.url, details.resourceType, details.webContentsId) });
  });
  browserSession.setPermissionRequestHandler((_contents, permission, callback) => {
    callback(!DENIED_PERMISSIONS.has(permission));
  });
  browserSession.setPermissionCheckHandler((_contents, permission) => !DENIED_PERMISSIONS.has(permission));
  return browserSession;
}

module.exports = { BROWSER_PARTITION, installBrowserSessionGuards };
