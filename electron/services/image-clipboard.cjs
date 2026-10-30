/**
 * 图片剪贴板服务。
 *
 * 渲染进程只传内联图片 data URI；这里再次限制 MIME、编码和体积，
 * 避免通用 URL 读取能力越过主进程边界。
 */

const MAX_IMAGE_DATA_URL_LENGTH = 64 * 1024 * 1024;
const SUPPORTED_IMAGE_DATA_URL = /^data:image\/(?:png|jpe?g|webp|gif|bmp|svg\+xml);base64,[a-z0-9+/=\s]+$/i;

function electronClipboardAdapter() {
  const electron = require('electron');
  if (!electron.clipboard?.writeImage || !electron.nativeImage?.createFromDataURL) {
    throw new Error('当前环境不支持写入图片剪贴板');
  }
  return {
    createFromDataURL: (value) => electron.nativeImage.createFromDataURL(value),
    writeImage: (image) => electron.clipboard.writeImage(image),
  };
}

function copyImageToClipboard(src, adapter = electronClipboardAdapter()) {
  if (typeof src !== 'string') throw new Error('缺少要复制的图片');
  if (src.length > MAX_IMAGE_DATA_URL_LENGTH) throw new Error('图片过大，无法复制到剪贴板');
  const value = src.trim();
  if (!SUPPORTED_IMAGE_DATA_URL.test(value)) throw new Error('不支持的图片数据格式');

  let image;
  try {
    image = adapter.createFromDataURL(value);
  } catch {
    throw new Error('图片数据无法解码');
  }
  if (!image || image.isEmpty()) throw new Error('图片数据无法解码');

  adapter.writeImage(image);
  return { ok: true };
}

module.exports = {
  MAX_IMAGE_DATA_URL_LENGTH,
  copyImageToClipboard,
};
