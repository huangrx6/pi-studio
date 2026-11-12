/**
 * 终端面板的纯逻辑：快捷键判定、粘贴保护、字号档位与链接解析。
 *
 * 抽成纯函数是因为这些判断最容易出错，也最值得单测：TerminalPanel 里跑的
 * xterm 与 PTY 没法在 Node 测试里断言，但「⌘V 到底该不该拦」「这行输出是
 * URL 还是 path:line」完全可以。
 */

export const MIN_TERMINAL_FONT_SIZE = 11;
export const MAX_TERMINAL_FONT_SIZE = 20;
export const DEFAULT_TERMINAL_FONT_SIZE = 12;

/** 粘贴内容超过这些阈值就先确认：终端里一次回车就可能执行整段脚本。 */
const PASTE_LINE_THRESHOLD = 1;
const PASTE_CHAR_THRESHOLD = 400;

/** 把字号夹到可用区间；非法输入退回默认值。 */
export function clampTerminalFontSize(value: unknown): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return DEFAULT_TERMINAL_FONT_SIZE;
  return Math.min(MAX_TERMINAL_FONT_SIZE, Math.max(MIN_TERMINAL_FONT_SIZE, Math.round(numeric)));
}

/** 缩放一档；已经是边界时返回原值，调用方据此跳过写偏好。 */
export function stepTerminalFontSize(current: unknown, direction: 1 | -1): number {
  const size = clampTerminalFontSize(current);
  return clampTerminalFontSize(size + direction);
}

/**
 * 多行或很长的粘贴先问一次。
 *
 * 单行短命令（`ls`、`git status`）不打断；换行意味着粘贴里可能跟着一个回车，
 * 用户看不到就直接执行了。
 */
export function needsPasteConfirm(text: string): boolean {
  if (typeof text !== 'string' || !text) return false;
  if (text.length > PASTE_CHAR_THRESHOLD) return true;
  const lines = text.split('\n').filter((line) => line.trim().length > 0);
  return lines.length > PASTE_LINE_THRESHOLD;
}

/** 终端里的按键意图；null 表示交回 xterm 与 shell。 */
export type TerminalKeyIntent =
  | 'copy'
  | 'paste'
  | 'select-all'
  | 'search'
  | 'clear'
  | 'zoom-in'
  | 'zoom-out'
  | 'zoom-reset'
  | 'new-terminal';

/**
 * 判定终端内的组合键。
 *
 * 只接管带主修饰键的组合，其余（方向键、⌃C、vi 的按键）必须原样交给 PTY，
 * 否则 shell 的日常操作会被面板抢走。⌘C 在没有选区时也不拦：那时它是
 * 「中断当前进程」，属于 shell。
 */
export function terminalKeyIntent(input: {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  hasSelection: boolean;
  platform?: 'mac' | 'other';
}): TerminalKeyIntent | null {
  const mac = (input.platform ?? (typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent) ? 'mac' : 'other')) === 'mac';
  const primary = mac ? input.metaKey && !input.ctrlKey : input.ctrlKey && !input.metaKey;
  if (!primary || input.altKey) return null;
  const key = input.key.toLowerCase();
  if (input.shiftKey) {
    // ⌘⇧C 在 macOS 上约定俗成是复制，趁早拦住。
    return key === 'c' && input.hasSelection ? 'copy' : null;
  }
  if (key === 'c') return input.hasSelection ? 'copy' : null;
  if (key === 'v') return 'paste';
  if (key === 'a') return 'select-all';
  if (key === 'f') return 'search';
  if (key === 'k') return 'clear';
  if (key === 't') return 'new-terminal';
  if (key === '+' || key === '=') return 'zoom-in';
  if (key === '-' || key === '_') return 'zoom-out';
  if (key === '0') return 'zoom-reset';
  return null;
}

/** 终端输出里可点击的目标。 */
export type TerminalLinkTarget =
  | { kind: 'url'; url: string }
  | { kind: 'file'; path: string; line?: number; column?: number };

const URL_PATTERN = /^https?:\/\/[^\s]+$/i;
const FILE_PATTERN = /^(?:[.~/]|[\w.-]+\/)[^\s:*?"<>|]*$/;

/**
 * 解析一行输出里的可点击目标。
 *
 * 支持 `https://…` 与 `path/to/file:12:3`；`path:12` 只在看起来像文件时才算，
 * 免得把 `warning:3` 这类纯文本当成可打开的文件。
 */
export function parseTerminalLink(raw: string): TerminalLinkTarget | null {
  const text = typeof raw === 'string' ? raw.trim() : '';
  if (!text) return null;
  if (URL_PATTERN.test(text)) return { kind: 'url', url: text };
  const match = /^(.+?)(?::(\d+))(?::(\d+))?$/u.exec(text);
  if (!match) return FILE_PATTERN.test(text) && text.includes('.') ? { kind: 'file', path: text } : null;
  const path = match[1];
  if (!FILE_PATTERN.test(path) || path.includes('/') === false) return null;
  const line = Number(match[2]);
  const column = match[3] === undefined ? undefined : Number(match[3]);
  return {
    kind: 'file',
    path,
    line: Number.isInteger(line) && line > 0 ? line : undefined,
    column: Number.isInteger(column) && (column ?? 0) > 0 ? column : undefined,
  };
}

/**
 * 把拖进终端的文件路径变成可以直接粘贴的 shell 参数。
 *
 * 含空格或引号时用单引号包住，并把内部的单引号转义成 `'\''`，
 * 这样粘贴进命令行不会把路径拆成两段。
 */
export function shellQuotePath(path: string): string {
  const value = typeof path === 'string' ? path : '';
  if (!value) return '';
  if (!/[\s'"\\$`!*?()[\]{}<>|&;#~]/u.test(value)) return value;
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/** 终端标题来自 shell 的 OSC 序列，可能带路径或很长；只留可读的主干。 */
export function terminalTabTitle(raw: string, fallback: string): string {
  const text = typeof raw === 'string' ? raw.replace(/\s+/gu, ' ').trim() : '';
  if (!text) return fallback;
  const segment = text.split(' — ')[0].split(' - ')[0].split('/').filter(Boolean).pop() || text;
  const trimmed = segment.trim();
  if (!trimmed || trimmed.length > 24) return fallback;
  return trimmed;
}
