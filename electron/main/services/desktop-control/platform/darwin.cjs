/**
 * macOS (darwin) desktop-control platform adapter.
 *
 * Wraps the existing CoreGraphics / Accessibility / LaunchServices / Swift helper
 * modules behind the shared cross-platform adapter interface.
 */
const { installedAppMappings } = require('../../mac-apps.cjs');
const {
  listRunningDesktopApps,
  listDesktopWindowsForApp,
  listDesktopWindowsForApps,
  assertWindowBelongsToApp,
  captureDesktopSnapshot,
  captureDesktopScreenshot,
  defaultRunner,
} = require('../observe.cjs');
const {
  clickDesktop,
  typeDesktop,
  scrollDesktop,
  dragDesktop,
  hotkeyDesktop,
} = require('../act.cjs');

async function listInstalledAppMappings(options = {}) {
  return installedAppMappings({ refresh: options.refresh === true });
}

async function launchApp(target, deps = {}) {
  if (typeof deps.launchApp === 'function') return deps.launchApp(target, { bringToFront: deps.bringToFront === true });
  const launchArgs = target.path
    ? ['-a', target.path]
    : target.bundleId
      ? ['-b', target.bundleId]
      : ['-a', target.name];
  const runner = deps.localRunner || deps.runner || defaultRunner;
  await runner('/usr/bin/open', deps.bringToFront === true ? launchArgs : ['-g', ...launchArgs], { timeout: 10000 });
  return { ok: true };
}

module.exports = {
  platform: 'darwin',
  listInstalledAppMappings,
  listRunningApps: listRunningDesktopApps,
  listWindowsForApp: listDesktopWindowsForApp,
  listWindowsForApps: listDesktopWindowsForApps,
  assertWindowOwnership: assertWindowBelongsToApp,
  captureSnapshot: captureDesktopSnapshot,
  captureScreenshot: captureDesktopScreenshot,
  click: clickDesktop,
  type: typeDesktop,
  scroll: scrollDesktop,
  drag: dragDesktop,
  hotkey: hotkeyDesktop,
  launchApp,
};
