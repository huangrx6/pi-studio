/**
 * Keyboard shortcut registry.
 *
 * One source of truth for the bindings the shell exposes: the default table,
 * canonical combo strings, matching against a KeyboardEvent, pretty printing
 * for the UI, and conflict detection when a user records a new key.
 *
 * Combo grammar: `Mod+Alt+Shift+<key>` where Mod is ⌘ on macOS and Ctrl
 * elsewhere. `<key>` is a single printable character (letters upper-case) or
 * one of the named keys below. Modifiers always appear in that order so two
 * equal shortcuts always have one string representation.
 */

/** Named keys we accept in a binding. Anything else must be one character. */
export const NAMED_KEYS = new Set([
  'Enter', 'Escape', 'Tab', 'Space', 'Backspace', 'Delete',
  'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
  'Home', 'End', 'PageUp', 'PageDown', '/', '\\', ',', '.', ';', "'", '[', ']', '`', '-', '=',
]);

/** Actions the shell can dispatch. `default` is the shipped binding. */
export const SHORTCUT_ACTIONS = [
  { id: 'palette', label: '命令面板', hint: '搜索会话、命令与文件', default: 'Mod+K' },
  { id: 'settings', label: '打开设置', hint: '', default: 'Mod+,' },
  { id: 'toggleSidebar', label: '折叠 / 展开侧栏', hint: '', default: 'Mod+B' },
  { id: 'togglePanel', label: '折叠 / 展开右侧面板', hint: '', default: 'Mod+J' },
  { id: 'newChat', label: '新建会话', hint: '', default: 'Mod+N' },
  { id: 'openBrowser', label: '在右侧打开浏览器', hint: '', default: 'Mod+Shift+B' },
  { id: 'openTerminal', label: '在右侧打开终端', hint: '', default: 'Mod+`' },
  { id: 'prevSession', label: '上一个会话', hint: '', default: 'Mod+Shift+[' },
  { id: 'nextSession', label: '下一个会话', hint: '', default: 'Mod+Shift+]' },
  { id: 'stopGeneration', label: '停止当前生成', hint: '', default: 'Mod+.' },
];

export const SHORTCUT_IDS = SHORTCUT_ACTIONS.map((action) => action.id);

/** Shipped bindings as a plain map. */
export const DEFAULT_SHORTCUTS = Object.fromEntries(
  SHORTCUT_ACTIONS.map((action) => [action.id, action.default]),
);

const MOD_ORDER = ['Mod', 'Alt', 'Shift'];

function normalizeKey(key) {
  if (typeof key !== 'string' || !key) return '';
  if (key === ' ' || key === 'Spacebar') return 'Space';
  if (key === 'Esc') return 'Escape';
  if (NAMED_KEYS.has(key)) return key;
  if (key.length === 1) return key.toUpperCase();
  return '';
}

/** 'mac' when the primary modifier is ⌘, otherwise 'other' (Ctrl). */
export function resolvePlatform(platform) {
  if (platform === 'mac' || platform === 'other') return platform;
  const ua = typeof navigator !== 'undefined' ? (navigator.platform || navigator.userAgent || '') : '';
  return /Mac|iPhone|iPad/.test(ua) ? 'mac' : 'other';
}

/** True when the platform's primary modifier is pressed. */
function hasMod(event, platform) {
  return resolvePlatform(platform) === 'mac' ? event.metaKey : event.ctrlKey;
}

/** Build a canonical combo from a KeyboardEvent; '' when unusable. */
export function comboFromEvent(event, platform) {
  if (!event || event.isComposing || event.keyCode === 229) return '';
  // The grammar cannot encode the secondary platform modifier or AltGraph.
  // Reject these rather than silently recording a different combination.
  if (event.getModifierState?.('AltGraph')) return '';
  if (resolvePlatform(platform) === 'mac' ? event.ctrlKey : event.metaKey) return '';
  const key = normalizeKey(event.key);
  if (!key || key === '+' || key === 'Control' || key === 'Meta' || key === 'Alt' || key === 'Shift') return '';
  const parts = [];
  if (hasMod(event, platform)) parts.push('Mod');
  if (event.altKey) parts.push('Alt');
  if (event.shiftKey) parts.push('Shift');
  // A bare letter would hijack typing, so a binding always needs a modifier.
  if (parts.length === 0) return '';
  parts.push(key);
  return parts.join('+');
}

/** Canonical combo for a stored value, or '' when it cannot be understood. */
export function normalizeCombo(combo) {
  if (typeof combo !== 'string' || !combo.trim()) return '';
  const parts = combo.split('+').map((part) => part.trim()).filter(Boolean);
  if (parts.length < 2) return '';
  const key = parts.pop();
  const modifiers = new Set(parts.map((part) => part.toLowerCase()));
  const ordered = MOD_ORDER.filter((mod) => modifiers.has(mod.toLowerCase()));
  // Unknown modifier names make the binding ambiguous: reject instead of guessing.
  if (ordered.length !== parts.length) return '';
  const normalizedKey = normalizeKey(key);
  if (!normalizedKey) return '';
  return [...ordered, normalizedKey].join('+');
}

/** Match a live event against a stored combo. */
export function matchesShortcut(event, combo, platform) {
  if (!event || event.repeat) return false;
  if (event.isComposing) return false;
  const expected = normalizeCombo(combo);
  if (!expected) return false;
  return comboFromEvent(event, platform) === expected;
}

const MOD_LABEL_MAC = { Mod: '⌘', Alt: '⌥', Shift: '⇧' };
const MOD_LABEL_OTHER = { Mod: 'Ctrl', Alt: 'Alt', Shift: 'Shift' };

/** Pretty-print a combo for the settings UI. */
export function formatShortcut(combo, platform) {
  const normalized = normalizeCombo(combo);
  if (!normalized) return '未设置';
  const isMac = platform ?? (typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || ''));
  const labels = isMac ? MOD_LABEL_MAC : MOD_LABEL_OTHER;
  const parts = normalized.split('+');
  const key = parts.pop();
  const modifiers = parts.map((part) => labels[part] ?? part);
  return isMac ? `${modifiers.join('')}${key}` : [...modifiers, key].join('+');
}

/**
 * 逐键标签，供键帽渲染使用（`formatShortcut` 仍是唯一的纯文本形式）。
 * 返回修饰键在前、主键在后的顺序；组合非法时返回空数组。
 */
export function formatShortcutParts(combo, platform) {
  const normalized = normalizeCombo(combo);
  if (!normalized) return [];
  const isMac = platform ?? (typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || ''));
  const labels = isMac ? MOD_LABEL_MAC : MOD_LABEL_OTHER;
  const parts = normalized.split('+');
  const key = parts.pop();
  return [...parts.map((part) => labels[part] ?? part), key];
}

/**
 * Merge stored bindings over the defaults: unknown actions are dropped and
 * unparsable values fall back to the shipped key.
 */
export function normalizeShortcuts(stored) {
  const source = stored && typeof stored === 'object' && !Array.isArray(stored) ? stored : {};
  const next = {};
  for (const action of SHORTCUT_ACTIONS) {
    const candidate = normalizeCombo(source[action.id]);
    next[action.id] = candidate || action.default;
  }
  return next;
}

/** The action that already owns this combo, ignoring `exceptId`. */
export function shortcutConflict(shortcuts, exceptId, combo) {
  const normalized = normalizeCombo(combo);
  if (!normalized) return undefined;
  return SHORTCUT_ACTIONS
    .map((action) => action.id)
    .find((id) => id !== exceptId && normalizeCombo(shortcuts[id]) === normalized);
}

/** True when the event target is a text entry where bare keys must pass through. */
export function isTextEntry(target) {
  if (!target || typeof target !== 'object') return false;
  const element = target;
  const tag = String(element.tagName || '').toUpperCase();
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  return Boolean(element.isContentEditable);
}
