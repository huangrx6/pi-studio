/**
 * 终端配色主题。
 *
 * 颜色本身写在 styles/palette.css 的 `[data-terminal-theme]` 段里；这里只保留
 * 主题清单，并在需要时把那组 CSS 变量读成 xterm 能用的具体色值。xterm 不认
 * color-mix()，所以不能像界面其他地方那样直接传 var()。
 *
 * `studio` 是默认值：不指定配色，跟随界面明暗与语义色。
 */

import type { ITheme } from '@xterm/xterm';

/** 默认主题：跟随界面明暗，颜色从 palette.css 的语义 token 读。 */
export const STUDIO_TERMINAL_THEME = 'studio';

export type TerminalThemeDefinition = { id: string; label: string };

export const TERMINAL_THEMES: TerminalThemeDefinition[] = [
  { id: 'catppuccin-mocha', label: 'Catppuccin Mocha' },
  { id: 'tokyo-night', label: 'Tokyo Night' },
  { id: 'dracula', label: 'Dracula' },
  { id: 'nord', label: 'Nord' },
  { id: 'one-dark', label: 'One Dark' },
  { id: 'gruvbox-dark', label: 'Gruvbox Dark' },
  { id: 'solarized-light', label: 'Solarized Light' },
];

/** xterm 的 ITheme 字段与 CSS 变量的对应关系；只列主题要覆盖的那部分。 */
const THEME_VARS = {
  background: '--terminal-bg',
  foreground: '--terminal-fg',
  cursor: '--terminal-cursor',
  cursorAccent: '--terminal-cursor-accent',
  selection: '--terminal-selection',
  black: '--terminal-black',
  red: '--terminal-red',
  green: '--terminal-green',
  yellow: '--terminal-yellow',
  blue: '--terminal-blue',
  magenta: '--terminal-magenta',
  cyan: '--terminal-cyan',
  white: '--terminal-white',
  brightBlack: '--terminal-bright-black',
  brightRed: '--terminal-bright-red',
  brightGreen: '--terminal-bright-green',
  brightYellow: '--terminal-bright-yellow',
  brightBlue: '--terminal-bright-blue',
  brightMagenta: '--terminal-bright-magenta',
  brightCyan: '--terminal-bright-cyan',
  brightWhite: '--terminal-bright-white',
} as const;

/** 主题 id 是否可用；未知 id 一律退回 Studio 默认配色。 */
export function isTerminalTheme(id: string | undefined): boolean {
  return typeof id === 'string' && id !== STUDIO_TERMINAL_THEME && TERMINAL_THEMES.some((theme) => theme.id === id);
}

const paletteCache = new Map<string, ITheme | null>();

/**
 * 读取某个主题在 xterm 里的 ITheme。
 *
 * 用一个脱离布局的探针元素套上 `data-terminal-theme`，让浏览器解析出那组变量，
 * 读完立即移除；结果按主题 id 缓存，切主题只会读一次。
 */
export function terminalTheme(id: string | undefined): ITheme | null {
  if (!isTerminalTheme(id)) return null;
  const key = id as string;
  if (paletteCache.has(key)) return paletteCache.get(key) ?? null;
  if (typeof document === 'undefined' || !document.body) return null;
  const probe = document.createElement('div');
  probe.dataset.terminalTheme = key;
  probe.style.cssText = 'position:absolute;left:-9999px;top:0;width:0;height:0;pointer-events:none;';
  document.body.appendChild(probe);
  const style = getComputedStyle(probe);
  const theme: ITheme = {};
  for (const [field, cssVar] of Object.entries(THEME_VARS)) {
    const value = style.getPropertyValue(cssVar).trim();
    if (value) (theme as Record<string, string>)[field === 'selection' ? 'selectionBackground' : field] = value;
  }
  probe.remove();
  const resolved = theme.background ? theme : null;
  paletteCache.set(key, resolved);
  return resolved;
}
