/**
 * image-fit 的 Durable 钩子与 Electron 图片编码器。
 *
 * 钩子只替换「这一次请求」的消息投影：历史里的图片保持原样，失败重试和恢复
 * 重放都会重新走一遍同样的修复，所以旧会话能自动恢复。
 *
 * 长截图不只缩小：1:5 这种比例压到 8000px 后，视觉接口自己再按长边缩放，
 * 文字就彻底看不清了。编码器改为按「接近原比例的段落」切分，保持原宽度，
 * 模型收到的是同一页的连续几段。
 */

const { nativeImage } = require('electron');
const { fitMessages } = require('./fit.cjs');

/** 段落之间重叠的像素，避免正好切断一行文字。 */
const SLICE_OVERLAP = 32;

/** 切段上限；再长的图切太多段不如整图缩小。 */
const MAX_SLICES = 6;

/** 每段目标高度/宽度不超过短边的倍数，保证单段比例接近正常截图。 */
const SLICE_ASPECT = 2;

/** 只是略微超限时等比缩小损失很小，不必切段。 */
const SLICE_THRESHOLD = 1.15;

function base64Length(bytes) {
  return Math.ceil(bytes / 3) * 4;
}

function encodeWithin(image, maxBase64Chars) {
  let encoded = image.toPNG();
  let mimeType = 'image/png';
  if (base64Length(encoded.length) > maxBase64Chars) {
    encoded = image.toJPEG(86);
    mimeType = 'image/jpeg';
  }
  if (encoded.length === 0 || base64Length(encoded.length) > maxBase64Chars) return null;
  return { data: encoded.toString('base64'), mimeType };
}

/** 等比缩小直到单边和体积都满足上限。 */
function fitWhole(image, maxSide, maxBase64Chars) {
  const size = image.getSize();
  let scale = Math.min(1, maxSide / Math.max(size.width, size.height));
  if (!Number.isFinite(scale) || scale <= 0) return null;
  for (let attempt = 0; attempt < 6 && scale > 0.01; attempt += 1) {
    const width = Math.max(1, Math.round(size.width * scale));
    const height = Math.max(1, Math.round(size.height * scale));
    const resized = width === size.width && height === size.height
      ? image
      : image.resize({ width, height, quality: 'good' });
    const encoded = encodeWithin(resized, maxBase64Chars);
    if (encoded) return encoded;
    scale *= 0.7;
  }
  return null;
}

/** 沿超限的一边切段，每段保持完整宽度（或高度）。 */
function sliceAlong(image, axis, maxSide, maxBase64Chars) {
  const { width, height } = image.getSize();
  const along = axis === 'height' ? height : width;
  const short = axis === 'height' ? width : height;
  if (!along || !short) return null;
  if (along <= maxSide * SLICE_THRESHOLD) return null;
  const target = Math.min(maxSide, Math.max(1024, Math.round(short * SLICE_ASPECT)));
  const count = Math.ceil(along / target);
  if (count < 2 || count > MAX_SLICES) return null;
  const span = Math.ceil(along / count);
  const spanWithOverlap = Math.min(maxSide, span + SLICE_OVERLAP);
  const slices = [];
  for (let index = 0; index < count; index += 1) {
    const start = index * span;
    const length = Math.min(spanWithOverlap, along - start);
    if (length <= 0) break;
    const rect = axis === 'height'
      ? { x: 0, y: start, width, height: length }
      : { x: start, y: 0, width: length, height };
    const cropped = image.crop(rect);
    if (!cropped || cropped.isEmpty()) return null;
    const encoded = encodeWithin(cropped, maxBase64Chars);
    if (!encoded) return null;
    slices.push(encoded);
  }
  return slices.length > 1 ? slices : null;
}

/**
 * 用 Electron 的 nativeImage 解码并重新编码图片。
 *
 * 返回内容块数组：普通超限图只有一块，长图是多段。解码失败（例如 Electron
 * 不支持的位图格式）返回 null，交给上层决定是否省略。
 */
function createNativeImageCodec() {
  return {
    refit({ data, mimeType, maxSide, maxBase64Chars }) {
      let source;
      try {
        source = nativeImage.createFromDataURL(`data:${mimeType};base64,${data}`);
      } catch {
        return null;
      }
      if (!source || source.isEmpty()) return null;
      const size = source.getSize();
      if (!size.width || !size.height) return null;

      if (size.width > maxSide) {
        const sliced = sliceAlong(source, 'width', maxSide, maxBase64Chars);
        if (sliced) return sliced;
      }
      if (size.height > maxSide) {
        const sliced = sliceAlong(source, 'height', maxSide, maxBase64Chars);
        if (sliced) return sliced;
      }
      const fitted = fitWhole(source, maxSide, maxBase64Chars);
      return fitted ? [fitted] : null;
    },
  };
}

function createStudioImageFitExtension(durable, { codec, cache } = {}) {
  const encoder = codec || createNativeImageCodec();
  const store = cache instanceof Map ? cache : new Map();
  return durable.defineExtension({
    name: 'studio-image-fit',
    hooks: [
      durable.hook(durable.GenerationTask, {
        async beforeRequest(request) {
          if (!Array.isArray(request?.messages)) return undefined;
          try {
            const result = fitMessages(request.messages, { codec: encoder, cache: store });
            if (!result.changed) return undefined;
            for (const item of result.applied) {
              if (item.cached) continue;
              console.warn(
                '[pi-studio] 请求图片已适配',
                JSON.stringify({
                  reason: item.reason,
                  from: item.from,
                  to: item.to,
                  width: item.width,
                  height: item.height,
                  fromBytes: item.fromBytes,
                  slices: item.slices,
                }),
              );
            }
            return { messages: result.messages };
          } catch (error) {
            // 图片适配失败时保持原请求，不因为它让整次对话发不出去。
            console.warn('[pi-studio] image-fit hook failed', error);
            return undefined;
          }
        },
      }),
    ],
  });
}

module.exports = {
  MAX_SLICES,
  SLICE_ASPECT,
  SLICE_OVERLAP,
  SLICE_THRESHOLD,
  createNativeImageCodec,
  createStudioImageFitExtension,
};
