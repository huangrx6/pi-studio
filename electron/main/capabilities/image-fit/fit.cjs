/**
 * 请求图片适配：在 Pi Durable 真正发出请求前，把超出视觉接口限制的图片
 * 缩放或转码成受支持的格式，避免整段会话被一次 400 拒绝。
 *
 * 为什么需要它：Studio 把用户附件、工具结果里的图片原样写进会话历史。
 * 只要历史里有一张超出限制的图片（例如 10663px 高的长截图），之后每次请求
 * 都会带上它并被拒绝，会话再也发不出消息。这里只改「这一次请求」的投影，
 * 历史数据保持原样，因此既能自愈旧会话，也不会悄悄改写用户记录。
 *
 * 判定只看图片头部与 base64 长度，正常图片不解码，常见请求没有额外开销。
 * 解码与缩放由注入的 codec 完成，便于在 Node 测试里替换。
 */

/** 视觉接口普遍接受的图片格式；其余格式必须先转码。 */
const SUPPORTED_IMAGE_MIME = Object.freeze(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);

const SUPPORTED_MIME = new Set(SUPPORTED_IMAGE_MIME);

/** 单边像素上限：主流视觉接口的上限是 8000px。 */
const MAX_SIDE = 8000;

/** 单图 base64 上限（约 3.75MB 原图），留出与常见 5MB 限制的余量。 */
const MAX_BASE64_CHARS = 5 * 1024 * 1024;

/** 只解码这么多 base64 用于读图片头，避免为了量尺寸读入整张图。 */
const HEADER_BASE64_CHARS = 96 * 1024;

/** 首次读不到尺寸时的重试窗口：带大 EXIF 的 JPEG 在第一个窗口里可能还没到帧头。 */
const HEADER_RETRY_BASE64_CHARS = 1024 * 1024;

/** 修复结果缓存条数，避免同一张图每次请求都重新缩放。 */
const MAX_CACHE_ENTRIES = 32;

function readPngSize(buffer) {
  if (buffer.length < 24) return null;
  if (buffer.readUInt32BE(0) !== 0x89504e47 || buffer.readUInt32BE(4) !== 0x0d0a1a0a) return null;
  if (buffer.toString('latin1', 12, 16) !== 'IHDR') return null;
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

function readGifSize(buffer) {
  if (buffer.length < 10) return null;
  const signature = buffer.toString('latin1', 0, 6);
  if (signature !== 'GIF87a' && signature !== 'GIF89a') return null;
  return { width: buffer.readUInt16LE(6), height: buffer.readUInt16LE(8) };
}

function readWebpSize(buffer) {
  if (buffer.length < 30) return null;
  if (buffer.toString('latin1', 0, 4) !== 'RIFF' || buffer.toString('latin1', 8, 12) !== 'WEBP') return null;
  const kind = buffer.toString('latin1', 12, 16);
  if (kind === 'VP8X') {
    return {
      width: buffer.readUIntLE(24, 3) + 1,
      height: buffer.readUIntLE(27, 3) + 1,
    };
  }
  if (kind === 'VP8 ') {
    if (buffer.length < 30) return null;
    return {
      width: buffer.readUInt16LE(26) & 0x3fff,
      height: buffer.readUInt16LE(28) & 0x3fff,
    };
  }
  if (kind === 'VP8L') {
    if (buffer.length < 25) return null;
    const bits = buffer.readUInt32LE(21);
    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
  }
  return null;
}

function readJpegSize(buffer) {
  if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) return null;
  let offset = 2;
  while (offset + 9 < buffer.length) {
    if (buffer[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = buffer[offset + 1];
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
      continue;
    }
    if (marker === 0xda || marker === 0xd9) return null;
    const length = buffer.readUInt16BE(offset + 2);
    if (length < 2) return null;
    const isFrameHeader = marker >= 0xc0 && marker <= 0xcf
      && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isFrameHeader) {
      return {
        height: buffer.readUInt16BE(offset + 5),
        width: buffer.readUInt16BE(offset + 7),
      };
    }
    offset += 2 + length;
  }
  return null;
}

const SIZE_READERS = Object.freeze({
  'image/png': readPngSize,
  'image/jpeg': readJpegSize,
  'image/gif': readGifSize,
  'image/webp': readWebpSize,
});

/**
 * 从 base64 图片读出像素尺寸；只解析头部，失败返回 null。
 * @param {string} data base64（不含 data URI 前缀）
 * @param {string} mimeType image/png 等
 * @returns {{ width: number, height: number } | null}
 */
function imageSize(data, mimeType) {
  const reader = SIZE_READERS[mimeType];
  if (!reader || typeof data !== 'string' || data.length === 0) return null;
  for (const window of [HEADER_BASE64_CHARS, HEADER_RETRY_BASE64_CHARS]) {
    const head = data.length > window ? data.slice(0, window) : data;
    try {
      const size = reader(Buffer.from(head, 'base64'));
      if (size) return size;
    } catch {
      return null;
    }
    if (data.length <= window) break;
  }
  return null;
}

/**
 * 判断一个 image 内容块是否需要修复。
 *
 * 返回 ok=true 表示可以原样发送；否则 reason 说明原因：
 * unsupported（格式不受支持）、too-large（体积超限）、too-long（单边像素超限）、
 * unreadable（声明是受支持格式，但图片头解析不出来，通常是被改了后缀的文件）。
 */
function inspectImage(block) {
  const mimeType = typeof block?.mimeType === 'string' ? block.mimeType : '';
  const chars = typeof block?.data === 'string' ? block.data.length : 0;
  const supported = SUPPORTED_MIME.has(mimeType);
  const size = supported ? imageSize(block.data, mimeType) : null;
  const tooLarge = chars > MAX_BASE64_CHARS;
  const tooLong = Boolean(size && (size.width > MAX_SIDE || size.height > MAX_SIDE));
  const unreadable = supported && !size;
  if (supported && !tooLarge && !tooLong && !unreadable) return { ok: true, size, chars };
  return {
    ok: false,
    reason: !supported ? 'unsupported' : tooLarge ? 'too-large' : tooLong ? 'too-long' : 'unreadable',
    size,
    chars,
  };
}

function cacheKey(block) {
  return [
    block.mimeType,
    block.data.length,
    block.data.slice(0, 64),
    block.data.slice(-64),
  ].join(':');
}

function omitNote(block, reason) {
  const label = block.mimeType || '未知格式';
  const text = reason === 'unreadable'
    ? `[图片已省略：${label} 数据无法识别，不是有效的图片]`
    : `[图片已省略：${label} 不在模型支持的图片格式（png/jpeg/webp/gif）内]`;
  return { type: 'text', text };
}

/** 这类问题必须修，修不好就只能省略，否则整段会话会被持续拒绝。 */
function mustOmit(reason) {
  return reason === 'unsupported' || reason === 'unreadable';
}

/**
 * 把编码器结果整理成可发送的内容块。
 *
 * 编码器可以返回单个块，也可以返回多块（长图会被切成多段），
 * 任何一块不合格就整组放弃，宁可不改也不发出无效图片。
 */
function usableBlocks(fitted) {
  const list = Array.isArray(fitted) ? fitted : [fitted];
  if (list.length === 0) return null;
  const blocks = [];
  for (const item of list) {
    if (!item || typeof item.data !== 'string' || item.data.length === 0) return null;
    if (!SUPPORTED_MIME.has(item.mimeType) || item.data.length > MAX_BASE64_CHARS) return null;
    blocks.push({ type: 'image', data: item.data, mimeType: item.mimeType });
  }
  return blocks;
}

/**
 * 修复单个 image 块。
 * @returns {{ replacement: object[]|null, cached: boolean }} replacement 为 null 表示保持原样（无法修复时不破坏内容）
 */
function refitBlock(block, inspection, codec, cache) {
  const key = cache ? cacheKey(block) : null;
  if (cache && cache.has(key)) return { replacement: cache.get(key), cached: true };
  let fitted = null;
  try {
    fitted = codec.refit({
      data: block.data,
      mimeType: block.mimeType,
      maxSide: MAX_SIDE,
      maxBase64Chars: MAX_BASE64_CHARS,
    });
  } catch {
    fitted = null;
  }
  const replacement = usableBlocks(fitted)
    || (mustOmit(inspection.reason) ? [omitNote(block, inspection.reason)] : null);
  if (cache) {
    cache.set(key, replacement);
    while (cache.size > MAX_CACHE_ENTRIES) cache.delete(cache.keys().next().value);
  }
  return { replacement, cached: false };
}

/**
 * 修复一整批请求消息里的图片。
 *
 * 没有需要修复的图片时返回原数组本身，调用方据此跳过请求替换。
 *
 * @param {readonly object[]} messages Durable 的请求消息
 * @param {{ codec: { refit: Function }, cache?: Map }} options
 * @returns {{ messages: readonly object[], changed: boolean, applied: object[] }}
 */
function fitMessages(messages, options = {}) {
  const codec = options.codec;
  if (!codec || typeof codec.refit !== 'function') throw new Error('image-fit 缺少图片编码器');
  const cache = options.cache instanceof Map ? options.cache : undefined;
  const applied = [];
  let changed = false;
  const next = [];

  for (const message of messages) {
    if (!message || !Array.isArray(message.content)) {
      next.push(message);
      continue;
    }
    let messageChanged = false;
    const content = [];
    for (const block of message.content) {
      if (!block || block.type !== 'image' || typeof block.data !== 'string') {
        content.push(block);
        continue;
      }
      const inspection = inspectImage(block);
      if (inspection.ok) {
        content.push(block);
        continue;
      }
      const { replacement, cached } = refitBlock(block, inspection, codec, cache);
      if (!replacement) {
        content.push(block);
        continue;
      }
      content.push(...replacement);
      messageChanged = true;
      applied.push({
        reason: inspection.reason,
        from: block.mimeType,
        fromBytes: inspection.chars,
        width: inspection.size?.width,
        height: inspection.size?.height,
        to: replacement[0].type === 'image' ? replacement[0].mimeType : 'text',
        slices: replacement.length,
        cached,
      });
    }
    if (!messageChanged) {
      next.push(message);
      continue;
    }
    changed = true;
    next.push({ ...message, content });
  }

  return { messages: changed ? next : messages, changed, applied };
}

module.exports = {
  HEADER_BASE64_CHARS,
  HEADER_RETRY_BASE64_CHARS,
  MAX_BASE64_CHARS,
  MAX_CACHE_ENTRIES,
  MAX_SIDE,
  SUPPORTED_IMAGE_MIME,
  SUPPORTED_MIME,
  fitMessages,
  imageSize,
  inspectImage,
};
