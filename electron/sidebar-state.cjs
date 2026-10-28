/**
 * 侧边栏元数据（重命名 / 置顶 / 归档 / 隐藏工作区）。
 *
 * config.json 里的 workspaceMetadata 与 sessionMetadata 都是
 * `id → 元数据` 的映射；这里只做纯函数式更新，不碰文件 IO，方便单测
 * （见 scripts/sidebar-state.test.cjs）。
 *
 * @param {object} config 完整配置
 * @param {object} action { kind: 'workspace'|'session', id, action, name? }
 * @returns 更新后的新配置对象（不修改入参）
 */
function updateSidebar(config, { kind, id, action, name }) {
  if (!['workspace', 'session'].includes(kind) || typeof id !== 'string' || !id || ['__proto__', 'constructor', 'prototype'].includes(id)) throw new Error('无效的侧边栏项目');
  const key = kind === 'workspace' ? 'workspaceMetadata' : 'sessionMetadata';
  const all = config[key] || {};
  const entry = { ...all[id] };
  if (action === 'rename') {
    if (typeof name !== 'string' || !name.trim() || name.trim().length > 80) throw new Error('名称需要 1–80 个字符');
    entry.name = name.trim();
  } else if (kind === 'workspace' && action === 'remove') entry.hidden = true;
  else if (kind === 'workspace' && action === 'restore') entry.hidden = false;
  else if (kind === 'session' && action === 'pin') entry.pinned = !entry.pinned;
  else if (kind === 'session' && action === 'archive') entry.archived = !entry.archived;
  else throw new Error('不支持的操作');
  return { ...config, [key]: { ...all, [id]: entry } };
}
module.exports = { updateSidebar };
