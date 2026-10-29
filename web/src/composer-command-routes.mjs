/**
 * Studio 原生斜杠命令的最小路由表。
 *
 * Pi 负责发现扩展命令、Prompt 模板与 Skill；这些命令没有出现在这里时，
 * 输入框会把原始文本完整交给 Pi。只有需要改变 Studio 自身状态或打开原生
 * 控件的少数命令才在这里登记，避免每接入一个扩展就要改前端分支。
 */

/** @typedef {'session.new' | 'model.picker' | 'thinking.picker' | 'settings.open' | 'settings.mcp' | 'assistant.copy'} StudioCommandRoute */

/** @type {Readonly<Record<string, StudioCommandRoute>>} */
export const STUDIO_COMMAND_ROUTES = Object.freeze({
  new: 'session.new',
  model: 'model.picker',
  thinking: 'thinking.picker',
  settings: 'settings.open',
  mcp: 'settings.mcp',
  copy: 'assistant.copy',
});

const THINKING_LEVELS = new Set([
  'default',
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
]);

/**
 * 解析 Studio 原生命令。返回 null 表示命令应原样交给 Pi。
 *
 * 命令名只在首 token 识别；参数保持为原始文本，由具体路由决定如何使用。
 *
 * @param {string} input
 * @returns {{ name: string, route: StudioCommandRoute, argument: string, raw: string } | null}
 */
export function parseStudioCommand(input) {
  if (typeof input !== 'string') return null;
  const match = input.match(/^\/([^\s/]+)(?:\s+([\s\S]*))?$/);
  if (!match) return null;
  const name = match[1].toLowerCase();
  if (!Object.hasOwn(STUDIO_COMMAND_ROUTES, name)) return null;
  return {
    name,
    route: STUDIO_COMMAND_ROUTES[name],
    argument: (match[2] ?? '').trim(),
    raw: input,
  };
}

/**
 * 把用户输入的 thinking 参数归一化为 Pi 的枚举值。
 * 支持大小写，以及 `x-high` / `x_high` 这类可读写法。
 *
 * @param {string} value
 * @returns {string | null}
 */
export function normalizeThinkingLevelArgument(value) {
  const normalized = value.trim().toLowerCase().replace(/[-_\s]+/g, '');
  return THINKING_LEVELS.has(normalized) ? normalized : null;
}
