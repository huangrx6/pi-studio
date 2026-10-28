/**
 * 附件标记（attachment marker）的编码与解析。
 *
 * 附件落盘后，会话文本里会带上一段不可见的标记：
 *
 *   [[pi-studio-attachment:<base64(JSON)>]]
 *
 * 收到消息时把它解析出来，渲染进程就能显示附件卡片；
 * 发回去给模型的内容则只保留纯文本。编码与解码放在同一个文件里，
 * 避免主进程两端（附件服务 / 消息序列化）各写一份格式。
 */

/** 标记的匹配规则：base64 允许 + / = 与字母数字。 */
const ATTACHMENT_MARKER_PATTERN = /\[\[pi-studio-attachment:([A-Za-z0-9+/=]+)\]\]/g;

/**
 * 生成附件标记。
 * @param {object} info 附件元信息（name / path / bytes / lines / kind / mime）
 */
function makeAttachmentMarker(info) {
  return `[[pi-studio-attachment:${Buffer.from(JSON.stringify(info)).toString('base64')}]]`;
}

/**
 * 从文本中提取附件标记，并返回去掉标记的纯文本。
 * 格式不合法的标记会被跳过（不抛错），避免一条坏数据卡住整个会话。
 */
function parseAttachmentMarkers(text) {
  const attachments = [];
  let clean = text;
  for (const match of text.matchAll(ATTACHMENT_MARKER_PATTERN)) {
    try {
      const info = JSON.parse(Buffer.from(match[1], 'base64').toString('utf8'));
      if (!info || typeof info.path !== 'string' || typeof info.name !== 'string') continue;
      attachments.push({
        name: String(info.name),
        path: info.path,
        bytes: Number(info.bytes) || 0,
        lines: Number(info.lines) || 0,
        kind: info.kind === 'file' ? 'file' : 'text',
        mime: typeof info.mime === 'string' ? info.mime : undefined,
      });
      clean = clean.replace(match[0], '');
    } catch {
      /* 忽略格式错误的标记 */
    }
  }
  return { text: clean.trim(), attachments };
}

module.exports = { makeAttachmentMarker, parseAttachmentMarkers };
