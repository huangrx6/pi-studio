/**
 * 富文本剪贴板服务。
 *
 * 为什么需要它：消息里可能既有正文又有图片。只写纯文本会让粘贴方丢失图片，
 * 只写图片又会丢掉正文。这里一次写入 text/plain + text/html 两种表示，粘贴方
 * 自行取用：富文本编辑器拿到内联图片，纯文本输入框拿到正文。
 *
 * Electron 45 只提供 W3C 风格接口：`write(ClipboardItem[])` 返回 Promise，
 * 既没有 writeImage，也不接受 `{ text, html }` 这种旧对象参数。
 *
 * 渲染进程传来的 HTML 只允许「内联位图 + 纯文本段落」，避免把任意 HTML
 * 写进系统剪贴板后粘到别处执行。
 */

/** 正文上限，正常消息远小于此。 */
const MAX_TEXT_CHARS = 1_000_000;

/** 富文本上限：图片是 base64，几张长截图就能到几十 MB。 */
const MAX_HTML_CHARS = 48 * 1024 * 1024;

const IMAGE_TAG = '<img src="data:image/(?:png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+" alt="">';

/** 只接受本应用拼出的结构：若干内联图片，其后最多一个转义过的正文段落。 */
const SAFE_HTML = new RegExp(`^(?:${IMAGE_TAG})*(?:<div>(?:<br>|[^<>])*</div>)?$`);

function electronClipboardAdapter(electron = require('electron')) {
  if (!electron.clipboard?.write || typeof electron.ClipboardItem !== 'function') {
    throw new Error('当前环境不支持写入剪贴板');
  }
  return {
    createItem: (data) => new electron.ClipboardItem(data),
    write: (items) => electron.clipboard.write(items),
  };
}

/**
 * 把正文与内联图片一起写入系统剪贴板。
 *
 * @param {{ text: string, html: string }} payload
 * @param {{ createItem: Function, write: Function }} [adapter]
 * @returns {Promise<{ ok: true }>}
 */
async function copyTextAndHtml(payload, adapter = electronClipboardAdapter()) {
  const text = typeof payload?.text === 'string' ? payload.text : '';
  const html = typeof payload?.html === 'string' ? payload.html : '';
  if (text.length > MAX_TEXT_CHARS) throw new Error('消息文本过长，无法复制');
  if (html.length === 0) throw new Error('没有可复制的富文本内容');
  if (html.length > MAX_HTML_CHARS) throw new Error('图片过大，无法复制到剪贴板');
  if (!SAFE_HTML.test(html)) throw new Error('不支持的富文本格式');

  await adapter.write([adapter.createItem({
    'text/plain': text,
    'text/html': html,
  })]);
  return { ok: true };
}

module.exports = {
  MAX_HTML_CHARS,
  MAX_TEXT_CHARS,
  copyTextAndHtml,
  electronClipboardAdapter,
};
