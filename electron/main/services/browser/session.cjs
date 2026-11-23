/**
 * Session hardening for the in-app browser partition.
 *
 * Guest pages are untrusted: they may only speak http(s) or render an
 * explicitly selected local HTML document. Request filtering lives here
 * because embedder-initiated `loadURL` skips will-navigate handlers.
 */
const { session } = require('electron');
const path = require('node:path');
const { resolveLocalHtmlAsset, resolveLocalHtmlDocument } = require('../local-html.cjs');

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
let browserSession;

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

function getBrowserSession() {
  if (!browserSession) browserSession = session.fromPartition(BROWSER_PARTITION);
  return browserSession;
}

function installBrowserSessionGuards() {
  const target = getBrowserSession();
  target.webRequest.onBeforeRequest((details, callback) => {
    callback({ cancel: !isAllowedRequest(details.url, details.resourceType, details.webContentsId) });
  });
  target.setPermissionRequestHandler((_contents, permission, callback) => {
    callback(!DENIED_PERMISSIONS.has(permission));
  });
  target.setPermissionCheckHandler((_contents, permission) => !DENIED_PERMISSIONS.has(permission));
  return target;
}

/**
 * Clear cookies, cache and local storage for the Studio browser profile.
 * Does not delete download files on disk.
 */
async function clearBrowserData() {
  const target = getBrowserSession();
  await Promise.all([
    target.clearCache(),
    target.clearStorageData({
      storages: [
        'cookies',
        'filesystem',
        'indexdb',
        'localstorage',
        'shadercache',
        'websql',
        'serviceworkers',
        'cachestorage',
      ],
    }),
  ]);
  localHtmlRoots.clear();
  return { ok: true };
}

module.exports = {
  BROWSER_PARTITION,
  clearBrowserData,
  getBrowserSession,
  installBrowserSessionGuards,
  isAllowedRequest,
};
