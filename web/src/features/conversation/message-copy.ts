/**
 * 复制消息时的富文本拼装。
 *
 * 只做纯函数：把正文和消息里的内联图片拼成剪贴板 HTML，供 CopyButton 直接写入。
 * 图片在前、正文在后，与气泡里的阅读顺序一致；正文按行转成 <br>，并按 HTML
 * 转义，保证复制结果里不会出现可执行的标签。
 *
 * 走内联 base64 而不是文件路径：粘贴方（编辑器、聊天窗口）拿到即用，不依赖
 * 图片文件还在原位置。
 */

/** 主进程也会再校验一次；这里只按前缀筛选，避免对大段 base64 做正则回溯。 */
const IMAGE_SOURCE_PREFIXES = Object.freeze([
  'data:image/png;base64,',
  'data:image/jpeg;base64,',
  'data:image/webp;base64,',
  'data:image/gif;base64,',
]);

function supportedImageSource(src: unknown): src is string {
  if (typeof src !== 'string') return false;
  return IMAGE_SOURCE_PREFIXES.some((prefix) => src.startsWith(prefix) && src.length > prefix.length);
}

/** HTML 转义；先转 & 再转其余字符，避免二次转义。 */
export function escapeClipboardText(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * 拼出可写入剪贴板的 HTML。没有可用图片时返回空串，调用方退回纯文本复制。
 *
 * @param text 消息正文（已还原成用户实际输入的形式）
 * @param images 消息里的图片 data URI，按展示顺序
 */
export function messageClipboardHtml({ text, images }: { text: string; images: readonly unknown[] }): string {
  const usable = images.filter(supportedImageSource);
  if (usable.length === 0) return '';
  const parts = usable.map((src) => `<img src="${src}" alt="">`);
  const body = escapeClipboardText(text).replace(/\r?\n/g, '<br>');
  if (body.trim().length > 0) parts.push(`<div>${body}</div>`);
  return parts.join('');
}
