/**
 * 图片剪贴板服务。
 *
 * Electron 45 的 clipboard 只有 W3C 风格接口：`write(ClipboardItem[])`、
 * `read()`、`readText()`、`has()`，没有 writeImage/readImage/availableFormats。
 * 早先按旧接口写会直接抛「当前环境不支持写入图片剪贴板」，表现就是右键
 * 「复制图片」点了没反应。
 *
 * 渲染进程只传内联图片 data URI；这里再限制 MIME、编码和体积，避免通用 URL
 * 读取能力越过主进程边界。
 */

const MAX_IMAGE_DATA_URL_LENGTH = 64 * 1024 * 1024;
const SUPPORTED_IMAGE_DATA_URL = /^data:image\/(?:png|jpe?g|webp|gif|bmp|svg\+xml);base64,[a-z0-9+/=\s]+$/i;

function electronClipboardAdapter(electron = require('electron')) {
  if (!electron.clipboard?.write || typeof electron.ClipboardItem !== 'function') {
    throw new Error('当前环境不支持写入图片剪贴板');
  }
  return {
    decode: (value) => electron.nativeImage.createFromDataURL(value),
    createItem: (mimeType, buffer) => new electron.ClipboardItem({
      [mimeType]: new Blob([buffer], { type: mimeType }),
    }),
    write: (items) => electron.clipboard.write(items),
  };
}

/**
 * 把内联图片写入系统剪贴板。
 *
 * 一律以 PNG 交付：先让 nativeImage 解码，再取 PNG 字节，避免把 webp/svg 这类
 * 目标应用认不出的格式塞进粘贴板，也顺带验证了数据本身可解码。
 *
 * @param {string} src 内联图片 data URI
 * @param {{ decode: Function, createItem: Function, write: Function }} [adapter]
 * @returns {Promise<{ ok: true }>}
 */
async function copyImageToClipboard(src, adapter = electronClipboardAdapter()) {
  if (typeof src !== 'string') throw new Error('缺少要复制的图片');
  if (src.length > MAX_IMAGE_DATA_URL_LENGTH) throw new Error('图片过大，无法复制到剪贴板');
  const value = src.trim();
  if (!SUPPORTED_IMAGE_DATA_URL.test(value)) throw new Error('不支持的图片数据格式');

  let image;
  try {
    image = adapter.decode(value);
  } catch {
    throw new Error('图片数据无法解码');
  }
  if (!image || image.isEmpty()) throw new Error('图片数据无法解码');

  const buffer = image.toPNG();
  if (!buffer || buffer.length === 0) throw new Error('图片数据无法解码');

  await adapter.write([adapter.createItem('image/png', buffer)]);
  return { ok: true };
}

module.exports = {
  MAX_IMAGE_DATA_URL_LENGTH,
  copyImageToClipboard,
  electronClipboardAdapter,
};
