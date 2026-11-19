/**
 * Keep wallpaper decode/GPU cost bounded.
 *
 * Full-resolution phone/camera photos become multi-hundred-megabyte GPU
 * textures once Chromium applies a full-viewport CSS blur. Display copies are
 * capped on the long edge and stored next to the original so the preference URL
 * stays stable while the protocol serves the cheaper file.
 */

const fs = require('node:fs');
const path = require('node:path');

/** Longest edge kept for on-screen wallpaper (covers 2× 1440p and most desktops). */
const MAX_DISPLAY_EDGE = 2560;
/** Skip rewriting when the original is already light enough. */
const MAX_ORIGINAL_BYTES = 1_500_000;
const DISPLAY_SUFFIX = '.display.jpg';
const DISPLAY_QUALITY = 82;

function displayScale(width, height, maxEdge = MAX_DISPLAY_EDGE) {
  const w = Number(width);
  const h = Number(height);
  if (!Number.isFinite(w) || !Number.isFinite(h) || w < 1 || h < 1) return null;
  const edge = Math.max(w, h);
  if (edge <= maxEdge) return null;
  const scale = maxEdge / edge;
  return {
    width: Math.max(1, Math.round(w * scale)),
    height: Math.max(1, Math.round(h * scale)),
  };
}

function displayCachePath(filePath) {
  return `${filePath}${DISPLAY_SUFFIX}`;
}

function shouldAttemptDisplayFit(mime, kind) {
  if (kind === 'video') return false;
  if (typeof mime !== 'string' || !mime.startsWith('image/')) return false;
  // nativeImage collapses animation; leave GIF and animated sources alone.
  if (mime === 'image/gif') return false;
  return true;
}

/**
 * Build or reuse a long-edge-capped JPEG for wallpaper painting.
 * Returns null when the original should be served as-is.
 */
async function resolveBackgroundDisplayFile(filePath, mime, {
  nativeImage = require('electron').nativeImage,
  maxEdge = MAX_DISPLAY_EDGE,
  maxOriginalBytes = MAX_ORIGINAL_BYTES,
  quality = DISPLAY_QUALITY,
} = {}) {
  if (!shouldAttemptDisplayFit(mime)) return null;
  const stat = await fs.promises.stat(filePath);
  if (!stat.isFile()) return null;

  const cachePath = displayCachePath(filePath);
  try {
    const cached = await fs.promises.stat(cachePath);
    if (cached.isFile() && cached.mtimeMs >= stat.mtimeMs && cached.size > 0) {
      return { path: cachePath, mime: 'image/jpeg', bytes: cached.size };
    }
  } catch {
    // Create on demand.
  }

  let image = nativeImage.createFromPath(filePath);
  if (!image || image.isEmpty?.()) return null;
  const size = image.getSize();
  const next = displayScale(size.width, size.height, maxEdge);
  const needsResize = Boolean(next);
  const needsReencode = stat.size > maxOriginalBytes;
  if (!needsResize && !needsReencode) return null;

  if (next) {
    image = image.resize({ width: next.width, height: next.height });
  }
  const jpeg = image.toJPEG(quality);
  if (!jpeg?.length) return null;
  // Only keep the display copy when it is meaningfully cheaper.
  if (!needsResize && jpeg.length >= stat.size * 0.9) return null;

  const tempPath = `${cachePath}.${process.pid}.tmp`;
  await fs.promises.writeFile(tempPath, jpeg);
  await fs.promises.rename(tempPath, cachePath);
  return { path: cachePath, mime: 'image/jpeg', bytes: jpeg.length };
}

/**
 * After import, replace oversized static images with a display-sized JPEG so
 * disk and first paint stay cheap. Videos and GIFs are left untouched.
 */
async function optimizeImportedBackgroundImage(filePath, {
  kind,
  mime,
  nativeImage = require('electron').nativeImage,
  maxEdge = MAX_DISPLAY_EDGE,
  quality = DISPLAY_QUALITY,
} = {}) {
  if (!shouldAttemptDisplayFit(mime, kind)) {
    return null;
  }
  const prepared = await resolveBackgroundDisplayFile(filePath, mime, {
    nativeImage,
    maxEdge,
    maxOriginalBytes: 0, // always consider fresh imports
    quality,
  });
  if (!prepared) return null;

  // Prefer serving the optimized bytes under the original preference URL when we
  // can rewrite the file in place as JPEG with a matching extension; otherwise
  // keep the sibling display cache for the protocol handler.
  const extension = path.extname(filePath).toLowerCase();
  if (extension === '.jpg' || extension === '.jpeg') {
    await fs.promises.copyFile(prepared.path, filePath);
    await fs.promises.rm(prepared.path, { force: true }).catch(() => {});
    const stat = await fs.promises.stat(filePath);
    return { path: filePath, mime: 'image/jpeg', bytes: stat.size, rewritten: true };
  }
  return { ...prepared, rewritten: false };
}

module.exports = {
  DISPLAY_SUFFIX,
  MAX_DISPLAY_EDGE,
  MAX_ORIGINAL_BYTES,
  displayCachePath,
  displayScale,
  optimizeImportedBackgroundImage,
  resolveBackgroundDisplayFile,
  shouldAttemptDisplayFit,
};
