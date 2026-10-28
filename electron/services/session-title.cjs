/**
 * 会话标题清洗。
 *
 * Pi 会把 `/skill:name ...` 展开成 `<skill name="..." location="...">正文</skill>`
 * 再写进历史，因此 `firstMessage` 的第一行可能是整个技能块。
 * 侧边栏和对话头部只应显示用户真正的问题，这里把技能块剥掉并压平空白。
 */

const TITLE_LIMIT = 80;
const SKILL_BLOCK = /<skill\s+[^>]*>[\s\S]*?<\/skill>/g;

/**
 * 从首条消息生成展示标题。
 * @param raw 原始首条消息（可能包含技能块）
 * @param fallback 清洗后为空时的兜底标题
 */
function cleanSessionTitle(raw, fallback = '新会话') {
  const text = String(raw ?? '')
    .replace(SKILL_BLOCK, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return text.slice(0, TITLE_LIMIT) || fallback;
}

/**
 * 会话索引用的标题：用户显式命名优先，否则从首条消息生成。
 * @param name Pi 记录的会话名（重命名后存在）
 * @param firstMessage 首条消息正文
 */
function sessionTitle(name, firstMessage) {
  if (typeof name === 'string' && name.trim()) return name.trim().slice(0, TITLE_LIMIT);
  return cleanSessionTitle(firstMessage);
}

module.exports = { cleanSessionTitle, sessionTitle };
