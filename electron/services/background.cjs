/**
 * Background media IPC service.
 *
 * Selected files are copied into userData/background-media. The renderer only
 * receives a pi-media:// URL; the protocol handler resolves that URL back into the
 * app-owned directory and streams it through Electron's net module.
 */

const fs = require('node:fs');
const { Readable } = require('node:stream');
const { app, dialog, protocol } = require('electron');
const { getWindow } = require('../core/state.cjs');
const {
  BACKGROUND_SCHEME,
  discardBackgroundMedia,
  importBackgroundMedia,
  mimeTypeForPath,
  parseByteRange,
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
      const filePath = resolveBackgroundMediaPath(app.getPath('userData'), request.url);
      const stat = await fs.promises.stat(filePath);
      if (!stat.isFile()) return new Response('Background media not found', { status: 404 });

      let range;
      try {
        range = parseByteRange(request.headers.get('range'), stat.size);
      } catch {
        return new Response(null, {
          status: 416,
          headers: {
            'Accept-Ranges': 'bytes',
            'Content-Range': `bytes */${stat.size}`,
          },
        });
      }

      const headers = new Headers({
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'private, max-age=31536000, immutable',
        'Content-Type': mimeTypeForPath(filePath) || 'application/octet-stream',
      });
      let status = 200;
      let start = 0;
      let end = Math.max(0, stat.size - 1);
      if (range) {
        status = 206;
        start = range.start;
        end = range.end;
        headers.set('Content-Range', `bytes ${start}-${end}/${stat.size}`);
      }
      headers.set('Content-Length', String(stat.size === 0 ? 0 : end - start + 1));

      const body = request.method === 'HEAD' || stat.size === 0
        ? null
        : Readable.toWeb(fs.createReadStream(filePath, { start, end }));
      return new Response(body, { status, headers });
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

  const media = await importBackgroundMedia(app.getPath('userData'), result.filePaths[0]);
  const previousUrl = typeof payload.replaceUrl === 'string' ? payload.replaceUrl : '';
  if (previousUrl && previousUrl !== media.url) {
    await discardBackgroundMedia(app.getPath('userData'), previousUrl).catch(() => {});
  }
  return media;
}

async function removeBackgroundMedia(value) {
  const removed = await discardBackgroundMedia(app.getPath('userData'), value);
  return { removed };
}

module.exports = {
  chooseBackgroundMedia,
  registerBackgroundProtocol,
  removeBackgroundMedia,
};
