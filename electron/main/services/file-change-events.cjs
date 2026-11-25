const fs = require('node:fs');
const { createHmac, randomBytes } = require('node:crypto');
const os = require('node:os');
const path = require('node:path');
const { getWindow } = require('../core/state.cjs');
const { studioDataDirectory } = require('../core/studio-paths.cjs');
const { assertNotProtected } = require('./file-target.cjs');

const previewKey = randomBytes(32);

/** Identify a physical file without publishing its resolved path in the event. */
function fileChangeKey(target) {
  return createHmac('sha256', previewKey).update(path.normalize(target)).digest('hex');
}

/** Publish the identities affected by a known mutation. */
function publishFileChanges(paths, { resolveAliases = false } = {}) {
  const window = getWindow();
  if (!window || window.isDestroyed() || window.webContents.isDestroyed()) return;
  const privateRoots = [path.join(os.homedir(), '.pi'), studioDataDirectory()];
  const checkPath = target => {
    assertNotProtected(target);
    for (const root of privateRoots) {
      if (target === root || target.startsWith(root + path.sep)) throw new Error('Private app data');
    }
  };
  const changed = new Set();
  for (const target of paths) {
    if (!path.isAbsolute(target)) continue;
    try {
      const absolute = path.normalize(target);
      checkPath(absolute);
      const canonical = resolveAliases ? fs.realpathSync(absolute) : absolute;
      checkPath(canonical);
      changed.add(fileChangeKey(canonical));
    } catch {
      // A protected path or a disappearing target need not reach the preview.
    }
  }
  if (!changed.size) return;
  try {
    window.webContents.send('pi:files-changed', [...changed]);
  } catch {
    // Closing a window must not turn a successful write into a failed tool.
  }
}

module.exports = { fileChangeKey, publishFileChanges };
