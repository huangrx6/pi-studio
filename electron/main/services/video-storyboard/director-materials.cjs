const fs = require('node:fs/promises');
const path = require('node:path');

async function textExcerpt(filename) {
  const file = await fs.open(filename, 'r');
  try {
    const stat = await file.stat();
    if (!stat.isFile()) return;
    const bytes = Buffer.alloc(Math.min(8192, stat.size));
    const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
    if (bytes.subarray(0, bytesRead).includes(0)) return;
    return bytes.toString('utf8', 0, bytesRead).slice(0, 2400);
  } finally { await file.close(); }
}

async function imageThumbnail(filename) {
  const { nativeImage } = require('electron');
  let picture;
  // Quick Look / Windows thumbnails cover formats which Chromium cannot decode directly.
  if (nativeImage.createThumbnailFromPath) {
    picture = await nativeImage.createThumbnailFromPath(filename, { width: 960, height: 960 }).catch(() => null);
  }
  if (!picture || picture.isEmpty()) {
    const stat = await fs.stat(filename);
    if (!stat.isFile() || stat.size > 12 * 1024 * 1024) return;
    picture = nativeImage.createFromPath(filename);
    if (picture.isEmpty()) return;
    const { width, height } = picture.getSize();
    if (Math.max(width, height) > 960) {
      picture = picture.resize(width >= height ? { width: 960 } : { height: 960 });
    }
  }
  const jpeg = picture.toJPEG(82);
  if (jpeg.length && jpeg.length <= 400 * 1024) {
    return { type: 'image', mimeType: 'image/jpeg', data: jpeg.toString('base64') };
  }
}

// File resolution stays on the main side. A missing source still has its name and editorial notes.
async function addMaterialReferences(assets, { sourceFor, supportsImages, thumbnail = imageThumbnail }) {
  const images = [];
  let excerptCount = 0;
  if (!sourceFor) return images;
  for (const asset of assets) {
    const readText = asset.kind === 'document' && /\.(txt|md|srt|vtt)$/i.test(asset.name) && excerptCount < 6;
    const readImage = supportsImages && asset.kind === 'image' && images.length < 6;
    if (!readText && !readImage) continue;
    try {
      const { filename } = sourceFor(asset.id);
      if (readText && ['.txt', '.md', '.srt', '.vtt'].includes(path.extname(filename).toLowerCase())) {
        const excerpt = await textExcerpt(filename);
        if (excerpt) { asset.excerpt = excerpt; excerptCount++; }
      } else if (readImage) {
        const image = await thumbnail(filename);
        if (image) { images.push(image); asset.imageNumber = images.length; }
      }
    } catch {
      // Keep unavailable previews as metadata, including files on disconnected volumes.
    }
  }
  return images;
}

module.exports = { addMaterialReferences };
