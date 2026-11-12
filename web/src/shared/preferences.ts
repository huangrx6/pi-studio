/**
 * 渲染进程的偏好设置：类型、默认值、localStorage 持久化与主题解析。
 *
 * 状态流：App 用 useState 持有 Preferences；偏好变化时统一调用
 * savePreferences + setActivePreferences，并把主题、字号、圆角写成 CSS 变量。
 * 非 React 树里的代码（例如 Markdown 的链接渲染器）通过 getActivePreferences()
 * 读取同一份最新值，避免层层传 props。
 *
 * 与主进程的关系：本文件只写 localStorage，不直接走 IPC；原生窗口主题由 App
 * 调用 `window.piApi.setAppearance` 同步给 electron 主进程（见 App.tsx 的偏好 effect）。
 */

/** 主题偏好；system 表示跟随 macOS 外观。 */
export type ThemePreference = 'light' | 'dark' | 'system';
/** 全局强调色方案；中性背景和语义状态色不随它改变。 */
export const PALETTE_PRESETS = [
  { id: 'lime', label: '玉石', description: '克制的玉石青，与黑白界面形成高级对比。' },
  { id: 'ocean', label: '海蓝', description: '冷静、清晰，适合长时间阅读。' },
  { id: 'amber', label: '琥珀', description: '温暖、专注，强调当前操作。' },
  { id: 'berry', label: '莓果', description: '柔和、鲜明，增加界面辨识度。' },
] as const;
export type PalettePreference = typeof PALETTE_PRESETS[number]['id'];
/** 工作步骤（工具调用/思考）的展示密度。 */
export type StepDisplay = 'compact' | 'standard' | 'detailed';
/** 工作步骤的自动收起时机。 */
export type StepCollapse = 'after-answer' | 'keep-open' | 'manual';
/** 对话内网页链接的打开方式：系统浏览器或应用内窗口。 */
export type LinkPreference = 'external' | 'window';
/**
 * 扩展在会话界面的落点偏好。
 *
 * 扩展自己声明可以落在哪些位置（`slots`），用户只决定最终出现在哪一处；
 * both 是默认值，表示按扩展声明的全部落点渲染。
 */
export type ExtensionPlacement = 'both' | 'chip' | 'footer' | 'hidden';
/** 全局圆角风格，映射到 RADIUS_PRESETS。 */
export type RadiusStyle = 'square' | 'compact' | 'standard' | 'soft';
/** 终端光标形状。 */
export type TerminalCursorStyle = 'bar' | 'block' | 'underline';
/** 由主进程复制到应用私有目录的背景媒体。 */
export type BackgroundMedia = {
  kind: 'image' | 'video';
  url: string;
  name: string;
  mime: string;
  bytes: number;
};

import { DEFAULT_SHORTCUTS, normalizeShortcuts } from './shortcuts.mjs';

export type KeyValueStorage = Pick<Storage, 'getItem' | 'setItem'>;

/** 用户可调整的全部偏好。 */
export type Preferences = {
  /** 主题偏好。 */
  theme: ThemePreference;
  /** 全局配色方案；只改变品牌强调色，不改变中性背景与语义状态色。 */
  palette: PalettePreference;
  /** 对话正文字号（px），仅影响聊天内容。 */
  fontSize: number;
  /** 终端字号（px），独立于对话正文；终端需要比正文更紧凑的等宽排版。 */
  terminalFontSize: number;
  /** 终端配色主题 id；studio 表示跟随界面明暗。 */
  terminalTheme: string;
  /** 终端字体族；空串表示跟随系统的等宽字体栈。 */
  terminalFontFamily: string;
  /** 终端行高倍数。 */
  terminalLineHeight: number;
  /** 终端光标形状。 */
  terminalCursorStyle: TerminalCursorStyle;
  /** 是否给终端注入 OSC 133 shell 集成（目前仅 zsh）。 */
  terminalShellIntegration: boolean;
  /** 步骤展示密度。 */
  stepDisplay: StepDisplay;
  /** 步骤收起时机。 */
  stepCollapse: StepCollapse;
  /** 是否展示「代码工作视图」文件清单。 */
  showCodeView: boolean;
  /** 网页链接打开方式。 */
  linkOpen: LinkPreference;
  /** 圆角风格。 */
  radiusStyle: RadiusStyle;
  /** 当前背景媒体；null 表示使用纯色背景。 */
  backgroundMedia: BackgroundMedia | null;
  /** 背景媒体自身可见度，0–100。 */
  backgroundOpacity: number;
  /** 背景媒体柔化强度，0–100%；渲染时映射为有上限的模糊像素值。 */
  backgroundBlur: number;
  /** 主界面外壳底漆的遮挡强度，0–100%；卡片和控件层级随主题统一派生。 */
  backgroundSurfaceOpacity: number;
  /** 窗口内的壁纸可见度，0–100；0 表示窗口内完全用纯色，只在四周留白看到壁纸。 */
  backgroundInsideVisibility: number;
  /** 可配置的快捷键：动作 id → 规范化的按键组合。 */
  shortcuts: Record<string, string>;
  /** 扩展落点偏好：panel contribution id → 落点；缺省表示按扩展声明全部渲染。 */
  extensionPlacements: Record<string, ExtensionPlacement>;
};

/** localStorage 键名；改动会导致旧用户偏好失效，需谨慎。 */
const STORAGE_KEY = 'pi-studio:preferences';

/** 首次启动或存储损坏时使用的默认偏好。 */
export const DEFAULT_PREFERENCES: Preferences = {
  theme: 'light',
  palette: 'lime',
  fontSize: 14,
  terminalFontSize: 12,
  terminalTheme: 'studio',
  terminalFontFamily: '',
  terminalLineHeight: 1.25,
  terminalCursorStyle: 'bar',
  terminalShellIntegration: false,
  stepDisplay: 'standard',
  stepCollapse: 'after-answer',
  showCodeView: false,
  linkOpen: 'external',
  radiusStyle: 'standard',
  backgroundMedia: null,
  backgroundOpacity: 68,
  backgroundBlur: 0,
  backgroundSurfaceOpacity: 88,
  backgroundInsideVisibility: 8,
  shortcuts: { ...DEFAULT_SHORTCUTS },
  extensionPlacements: {},
};

const THEMES = new Set<ThemePreference>(['light', 'dark', 'system']);
const STEP_DISPLAYS = new Set<StepDisplay>(['compact', 'standard', 'detailed']);
const STEP_COLLAPSES = new Set<StepCollapse>(['after-answer', 'keep-open', 'manual']);
const LINK_PREFERENCES = new Set<LinkPreference>(['external', 'window']);
const RADIUS_STYLES = new Set<RadiusStyle>(['square', 'compact', 'standard', 'soft']);
const EXTENSION_PLACEMENTS = new Set<ExtensionPlacement>(['both', 'chip', 'footer', 'hidden']);
const TERMINAL_CURSOR_STYLES = new Set<TerminalCursorStyle>(['bar', 'block', 'underline']);
const MAX_MEDIA_FIELD_LENGTH = 4_096;

function cloneDefaults(): Preferences {
  return {
    ...DEFAULT_PREFERENCES,
    shortcuts: { ...DEFAULT_SHORTCUTS },
  };
}

function clampNumber(
  value: unknown,
  fallback: number,
  min: number,
  max: number,
): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value)));
}

/** 保留两位小数：行高这类步进不是整数的偏好不能四舍五入到整数。 */
function clampDecimal(
  value: unknown,
  fallback: number,
  min: number,
  max: number,
): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value * 100) / 100));
}

function normalizePalette(value: unknown): PalettePreference {
  return PALETTE_PRESETS.some((preset) => preset.id === value)
    ? value as PalettePreference
    : DEFAULT_PREFERENCES.palette;
}

function normalizeBackgroundMedia(value: unknown): BackgroundMedia | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const media = value as Partial<BackgroundMedia>;
  if (media.kind !== 'image' && media.kind !== 'video') return null;
  const url = typeof media.url === 'string' ? media.url.trim() : '';
  const name = typeof media.name === 'string' ? media.name.trim() : '';
  const mime = typeof media.mime === 'string' ? media.mime.trim() : '';
  if (
    !url
    || url.length > MAX_MEDIA_FIELD_LENGTH
    || !url.startsWith('pi-media://background/')
    || !name
    || name.length > MAX_MEDIA_FIELD_LENGTH
    || !mime
    || mime.length > MAX_MEDIA_FIELD_LENGTH
  ) return null;
  const bytes = typeof media.bytes === 'number'
    && Number.isSafeInteger(media.bytes)
    && media.bytes >= 0
    ? media.bytes
    : 0;
  return {
    kind: media.kind,
    url,
    name,
    mime,
    bytes,
  };
}

/** Validate every persisted field and return a fresh JSON-safe preference object. */
export function normalizePreferences(value: unknown): Preferences {
  const source = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Partial<Preferences>
    : {};
  return {
    theme: THEMES.has(source.theme as ThemePreference)
      ? source.theme as ThemePreference
      : DEFAULT_PREFERENCES.theme,
    palette: normalizePalette(source.palette),
    fontSize: clampNumber(
      source.fontSize,
      DEFAULT_PREFERENCES.fontSize,
      12,
      18,
    ),
    terminalFontSize: clampNumber(
      source.terminalFontSize,
      DEFAULT_PREFERENCES.terminalFontSize,
      11,
      20,
    ),
    terminalTheme: typeof source.terminalTheme === 'string' && source.terminalTheme.length <= 64
      ? source.terminalTheme
      : DEFAULT_PREFERENCES.terminalTheme,
    terminalFontFamily: typeof source.terminalFontFamily === 'string' && source.terminalFontFamily.length <= 120
      ? source.terminalFontFamily
      : DEFAULT_PREFERENCES.terminalFontFamily,
    terminalLineHeight: clampDecimal(
      source.terminalLineHeight,
      DEFAULT_PREFERENCES.terminalLineHeight,
      1,
      1.8,
    ),
    terminalCursorStyle: TERMINAL_CURSOR_STYLES.has(source.terminalCursorStyle as TerminalCursorStyle)
      ? source.terminalCursorStyle as TerminalCursorStyle
      : DEFAULT_PREFERENCES.terminalCursorStyle,
    terminalShellIntegration: typeof source.terminalShellIntegration === 'boolean'
      ? source.terminalShellIntegration
      : DEFAULT_PREFERENCES.terminalShellIntegration,
    stepDisplay: STEP_DISPLAYS.has(source.stepDisplay as StepDisplay)
      ? source.stepDisplay as StepDisplay
      : DEFAULT_PREFERENCES.stepDisplay,
    stepCollapse: STEP_COLLAPSES.has(source.stepCollapse as StepCollapse)
      ? source.stepCollapse as StepCollapse
      : DEFAULT_PREFERENCES.stepCollapse,
    showCodeView: typeof source.showCodeView === 'boolean'
      ? source.showCodeView
      : DEFAULT_PREFERENCES.showCodeView,
    linkOpen: LINK_PREFERENCES.has(source.linkOpen as LinkPreference)
      ? source.linkOpen as LinkPreference
      : DEFAULT_PREFERENCES.linkOpen,
    radiusStyle: RADIUS_STYLES.has(source.radiusStyle as RadiusStyle)
      ? source.radiusStyle as RadiusStyle
      : DEFAULT_PREFERENCES.radiusStyle,
    backgroundMedia: normalizeBackgroundMedia(source.backgroundMedia),
    backgroundOpacity: clampNumber(
      source.backgroundOpacity,
      DEFAULT_PREFERENCES.backgroundOpacity,
      0,
      100,
    ),
    backgroundBlur: clampNumber(
      source.backgroundBlur,
      DEFAULT_PREFERENCES.backgroundBlur,
      0,
      100,
    ),
    backgroundSurfaceOpacity: clampNumber(
      source.backgroundSurfaceOpacity,
      DEFAULT_PREFERENCES.backgroundSurfaceOpacity,
      0,
      100,
    ),
    backgroundInsideVisibility: clampNumber(
      source.backgroundInsideVisibility,
      DEFAULT_PREFERENCES.backgroundInsideVisibility,
      0,
      100,
    ),
    shortcuts: normalizeShortcuts(source.shortcuts) as Record<string, string>,
    extensionPlacements: normalizeExtensionPlacements(source.extensionPlacements),
  };
}

/**
 * 只保存非默认的落点：both 等于「没用过这个设置」，不写进存储，
 * 这样以后再给扩展加落点时，老用户不会因为一条空记录被锁在旧行为上。
 */
function normalizeExtensionPlacements(value: unknown): Record<string, ExtensionPlacement> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([key, item]) => key.length > 0 && item !== 'both' && EXTENSION_PLACEMENTS.has(item as ExtensionPlacement))
      .map(([key, item]) => [key, item as ExtensionPlacement]),
  );
}

function browserStorage(): KeyValueStorage | null {
  try {
    return typeof globalThis.localStorage === 'undefined'
      ? null
      : globalThis.localStorage;
  } catch {
    return null;
  }
}

/**
 * 圆角风格到各组件的像素预设。
 * tag/control/card/panel 分别对应标签、输入控件、卡片、浮层面板，
 * round 是胶囊类元素（999 表示完全圆角）。App 会把这些值写成 CSS 变量。
 */
export const RADIUS_PRESETS: Record<RadiusStyle, { tag: number; control: number; card: number; panel: number; round: number }> = {
  square: { tag: 0, control: 0, card: 0, panel: 0, round: 0 },
  compact: { tag: 3, control: 6, card: 9, panel: 12, round: 999 },
  standard: { tag: 4, control: 8, card: 12, panel: 16, round: 999 },
  soft: { tag: 6, control: 10, card: 16, panel: 22, round: 999 },
};

/** 最近一次生效的偏好；供 React 树外的工具函数同步读取。 */
let activePreferences = DEFAULT_PREFERENCES;

/**
 * 从 localStorage 读取偏好，并与默认值合并。
 *
 * 每个字段都经过类型与取值校验。读取到非法 JSON 或需要纠正的值时，会把
 * 规范化结果最佳努力写回一次；缺失、合法且规范的值不会产生写操作。
 */
export function loadPreferences(
  storage: KeyValueStorage | null = browserStorage(),
): Preferences {
  if (!storage) return cloneDefaults();
  let raw: string | null;
  try {
    raw = storage.getItem(STORAGE_KEY);
  } catch {
    return cloneDefaults();
  }
  if (raw === null) return cloneDefaults();

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = undefined;
  }
  const normalized = normalizePreferences(parsed);
  const canonical = JSON.stringify(normalized);
  if (canonical !== raw) {
    try { storage.setItem(STORAGE_KEY, canonical); } catch {
      // Corrupt storage still degrades safely when the browser refuses writes.
    }
  }
  return normalized;
}

/**
 * 持久化偏好。
 * 隐私模式或存储配额不足时 localStorage 会抛错，这里静默忽略：
 * 偏好只在本次会话生效，不影响主流程。
 */
export function savePreferences(
  preferences: Preferences,
  storage: KeyValueStorage | null = browserStorage(),
): void {
  if (!storage) return;
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(normalizePreferences(preferences)));
  } catch {
    // 存储不可用（隐私模式或配额不足）时，偏好仅在当前会话生效。
  }
}

/** 更新模块级偏好缓存；应在每次偏好变化且保存后调用。 */
export function setActivePreferences(preferences: Preferences): void {
  activePreferences = normalizePreferences(preferences);
}

/** 读取模块级偏好缓存，供 Markdown 等非 React 上下文使用。 */
export function getActivePreferences(): Preferences {
  return activePreferences;
}

/**
 * 把主题偏好解析成实际配色。
 * system 通过 matchMedia 读取当前系统外观；返回的只可能是 light / dark。
 */
export function resolveTheme(theme: ThemePreference): 'light' | 'dark' {
  if (theme === 'system') return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  return theme;
}
