const fs = require('node:fs/promises');
const path = require('node:path');
const { mimeTypeForPath } = require('../file-preview.cjs');
const { mediaResponse } = require('../media-response.cjs');
const { sourcePath } = require('./generated-files.cjs');
const renders = require('./render-files.cjs');
const { getStudioDatabase } = require('../../core/studio-db.cjs');

const otherMime = { '.heic': 'image/heic', '.heif': 'image/heif', '.tif': 'image/tiff', '.tiff': 'image/tiff',
  '.mkv': 'video/x-matroska', '.avi': 'video/x-msvideo', '.mts': 'video/mp2t', '.m2ts': 'video/mp2t',
  '.opus': 'audio/ogg', '.aiff': 'audio/aiff' };

function playableMime(filename) {
  const mime = otherMime[path.extname(filename).toLowerCase()] || mimeTypeForPath(filename);
  if (/^(audio|video|image)\//.test(mime) && mime !== 'image/svg+xml') return mime;
}

async function storyboardMediaResponse(request) {
  const render = /^\/render\/([\da-f-]{36})$/i.exec(new URL(request.url).pathname);
  if (render) return renders.stream(request, render[1]);
  const match = /^\/([\da-f-]{36})\/([\da-f-]{36})$/i.exec(new URL(request.url).pathname);
  if (!match) return new Response(null, { status: 404 });
  const source = getStudioDatabase().db.prepare('SELECT source_path FROM video_storyboard_sources WHERE work_id = ? AND asset_id = ?')
    .get(match[1], match[2]);
  const mime = source && playableMime(source.source_path);
  if (!mime) return new Response(null, { status: 404 });
  return mediaResponse(request, sourcePath(source.source_path), mime, 'private, no-store');
}

async function inspectSource(workId, { asset, filename }, nativeImage) {
  const stat = await fs.stat(filename).catch(() => null);
  if (!stat?.isFile()) return { missing: true };
  const info = { missing: false, size: stat.size };
  if (playableMime(filename)) info.url = `pi-media://storyboard/${workId}/${asset.id}?v=${stat.mtimeMs}`;
  if (nativeImage.createThumbnailFromPath && asset.kind === 'image') {
    const image = await nativeImage.createThumbnailFromPath(filename, { width: 480, height: 300 }).catch(() => null);
    if (image && !image.isEmpty()) info.thumbnail = image.toDataURL();
  }
  if (/\.(txt|md|srt|vtt)$/i.test(filename)) {
    const file = await fs.open(filename, 'r');
    try {
      const buffer = Buffer.alloc(Math.min(8192, stat.size));
      const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
      info.text = buffer.toString('utf8', 0, bytesRead) + (stat.size > bytesRead ? '…' : '');
    } finally { await file.close(); }
  }
  return info;
}

module.exports = { inspectSource, storyboardMediaResponse };
