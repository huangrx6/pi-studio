/**
 * Cross-platform desktop-control adapter router.
 *
 * Supports `darwin` (macOS CoreGraphics + Accessibility + Swift helper) and
 * `win32` (Windows Win32 + DWM + UI Automation + PrintWindow + SendInput).
 */
const darwinAdapter = require('./darwin.cjs');
const win32Adapter = require('./win32.cjs');

const SUPPORTED_PLATFORMS = Object.freeze(['darwin', 'win32']);

function isSupportedDesktopPlatform(platform = process.platform) {
  return platform === 'darwin' || platform === 'win32';
}

function getDesktopPlatformAdapter(platform = process.platform) {
  if (platform === 'darwin') return darwinAdapter;
  if (platform === 'win32') return win32Adapter;
  return null;
}

function assertSupportedDesktopPlatform(platform = process.platform) {
  const adapter = getDesktopPlatformAdapter(platform);
  if (!adapter) {
    const error = new Error('电脑操控目前支持 macOS 与 Windows。');
    error.code = 'desktop_unsupported_platform';
    throw error;
  }
  return adapter;
}

module.exports = {
  SUPPORTED_PLATFORMS,
  isSupportedDesktopPlatform,
  getDesktopPlatformAdapter,
  assertSupportedDesktopPlatform,
  darwinAdapter,
  win32Adapter,
};
