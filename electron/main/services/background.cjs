/**
 * Background media IPC service.
 *
 * Selected files are copied into userData/background-media. The renderer only
 * receives a pi-media:// URL; the protocol handler resolves that URL back into the
 * app-owned directory. The protocol handler streams range requests from the filesystem.
 */

const fs = require('node:fs');
const path = require('node:path');
const { mediaResponse } = require('./media-response.cjs');
const {
  displayCachePath,
  optimizeImportedBackgroundImage,
  resolveBackgroundDisplayFile,
} = require('./background-display.cjs');
const { dialog, protocol } = require('electron');
const { getWindow } = require('../core/state.cjs');
const { studioDataDirectory } = require('../core/studio-paths.cjs');
const {
  BACKGROUND_SCHEME,
  backgroundDirectory,
  discardBackgroundMedia,
  importBackgroundMedia,
  mimeTypeForPath,
  resolveBackgroundMediaPath,
} = require('../background-media.cjs');

let protocolInstalled = false;

async function warmBackgroundDisplayCache() {
  try {
    const directory = backgroundDirectory(studioDataDirectory());
    const entries = await fs.promises.readdir(directory, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isFile() || entry.name.includes('.display.')) continue;
      const filePath = path.join(directory, entry.name);
      const mime = mimeTypeForPath(filePath);
      if (!mime) continue;
      await resolveBackgroundDisplayFile(filePath, mime).catch(() => null);
    }
  } catch {
    // Wallpaper warm-up is best-effort and must never block startup.
  }
}

async function registerBackgroundProtocol() {
  if (protocolInstalled) return;
  protocolInstalled = true;
  protocol.handle(BACKGROUND_SCHEME, async (request) => {
    try {
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        return new Response('Method not allowed', { status: 405, headers: { Allow: 'GET, HEAD' } });
      }
      const filePath = resolveBackgroundMediaPath(studioDataDirectory(), request.url);
      const mime = mimeTypeForPath(filePath);
      const display = await resolveBackgroundDisplayFile(filePath, mime).catch(() => null);
      return await mediaResponse(
        request,
        display?.path || filePath,
        display?.mime || mime,
        'private, max-age=31536000, immutable',
      );
    } catch {
      return new Response('Background media not found', { status: 404 });
    }
  });
  setImmediate(() => {
    void warmBackgroundDisplayCache();
  });
}

async function chooseBackgroundMedia(payload = {}) {
  const result = await dialog.showOpenDialog(getWindow(), {
    title: '选择背景图片或视频',
    buttonLabel: '设为背景',
    properties: ['openFile'],
    filters: [
      { name: '图片与视频', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'avif', 'mp4', 'mov', 'm4v', 'webm'] },
    ],
  });
  if (result.canceled || !result.filePaths[0]) return null;

  const media = await importBackgroundMedia(studioDataDirectory(), result.filePaths[0]);
  const filePath = resolveBackgroundMediaPath(studioDataDirectory(), media.url);
  const optimized = await optimizeImportedBackgroundImage(filePath, {
    kind: media.kind,
    mime: media.mime,
  }).catch(() => null);
  if (optimized?.rewritten) {
    media.mime = optimized.mime;
    media.bytes = optimized.bytes;
  }
  // Non-rewritten results leave a sibling .display.jpg cache for the protocol handler.
  const previousUrl = typeof payload.replaceUrl === 'string' ? payload.replaceUrl : '';
  if (previousUrl && previousUrl !== media.url) {
    await removeBackgroundMedia(previousUrl).catch(() => {});
  }
  return media;
}

async function removeBackgroundMedia(value) {
  let displayPath;
  try {
    displayPath = displayCachePath(resolveBackgroundMediaPath(studioDataDirectory(), value));
  } catch {
    displayPath = undefined;
  }
  const removed = await discardBackgroundMedia(studioDataDirectory(), value);
  if (displayPath) {
    await fs.promises.rm(displayPath, { force: true }).catch(() => {});
  }
  return { removed };
}

module.exports = {
  chooseBackgroundMedia,
  registerBackgroundProtocol,
  removeBackgroundMedia,
};
