/**
 * Background media IPC service.
 *
 * Selected files are copied into userData/background-media. The renderer only
 * receives a pi-media:// URL; the protocol handler resolves that URL back into the
 * app-owned directory. The storyboard host on the same scheme resolves its
 * imported sources separately. Both stream range requests from the filesystem.
 */

const { mediaResponse } = require('./media-response.cjs');
const { storyboardMediaResponse } = require('./video-storyboard/media.cjs');
const { app, dialog, protocol } = require('electron');
const { getWindow } = require('../core/state.cjs');
const { studioDataDirectory } = require('../core/studio-paths.cjs');
const {
  BACKGROUND_SCHEME,
  discardBackgroundMedia,
  importBackgroundMedia,
  mimeTypeForPath,
  resolveBackgroundMediaPath,
} = require('../background-media.cjs');

let protocolInstalled = false;

async function registerBackgroundProtocol() {
  if (protocolInstalled) return;
  protocolInstalled = true;
  protocol.handle(BACKGROUND_SCHEME, async (request) => {
    try {
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        return new Response('Method not allowed', { status: 405, headers: { Allow: 'GET, HEAD' } });
      }
      if (new URL(request.url).hostname === 'storyboard') return await storyboardMediaResponse(request);
      const filePath = resolveBackgroundMediaPath(studioDataDirectory(), request.url);
      return await mediaResponse(request, filePath, mimeTypeForPath(filePath), 'private, max-age=31536000, immutable');
    } catch {
      return new Response('Background media not found', { status: 404 });
    }
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
  const previousUrl = typeof payload.replaceUrl === 'string' ? payload.replaceUrl : '';
  if (previousUrl && previousUrl !== media.url) {
    await discardBackgroundMedia(studioDataDirectory(), previousUrl).catch(() => {});
  }
  return media;
}

async function removeBackgroundMedia(value) {
  const removed = await discardBackgroundMedia(studioDataDirectory(), value);
  return { removed };
}

module.exports = {
  chooseBackgroundMedia,
  registerBackgroundProtocol,
  removeBackgroundMedia,
};
