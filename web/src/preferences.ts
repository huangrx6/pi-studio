/**
 * 渲染进程的偏好设置：类型、默认值、localStorage 持久化与主题解析。
 *
 * 状态流：App 用 useState 持有 Preferences；偏好变化时统一调用
 * savePreferences + setActivePreferences，并把主题、字号、圆角写成 CSS 变量。
 * 非 React 树里的代码（例如 Markdown 的链接渲染器）通过 getActivePreferences()
 * 读取同一份最新值，避免层层传 props。
 *
 * 与主进程的关系：本文件只写 localStorage，不直接走 IPC；原生窗口主题由 App
 * 调用 `window.piApi.setTheme` 同步给 electron 主进程（见 App.tsx 的偏好 effect）。
 */

/** 主题偏好；system 表示跟随 macOS 外观。 */
export type ThemePreference = 'light' | 'dark' | 'system';
/** 工作步骤（工具调用/思考）的展示密度。 */
export type StepDisplay = 'compact' | 'standard' | 'detailed';
/** 工作步骤的自动收起时机。 */
export type StepCollapse = 'after-answer' | 'keep-open' | 'manual';
/** 对话内网页链接的打开方式：系统浏览器或应用内窗口。 */
export type LinkPreference = 'external' | 'window';
/** 智能体繁忙时按 Enter / 点发送的行为：排队或插话引导。 */
export type BusyPreference = 'queue' | 'steer';
/** 全局圆角风格，映射到 RADIUS_PRESETS。 */
export type RadiusStyle = 'square' | 'compact' | 'standard' | 'soft';

/** 用户可调整的全部偏好。 */
export type Preferences = {
  /** 主题偏好。 */
  theme: ThemePreference;
  /** 对话正文字号（px），仅影响聊天内容。 */
  fontSize: number;
  /** 步骤展示密度。 */
  stepDisplay: StepDisplay;
  /** 步骤收起时机。 */
  stepCollapse: StepCollapse;
  /** 是否展示「代码工作视图」文件清单。 */
  showCodeView: boolean;
  /** 网页链接打开方式。 */
  linkOpen: LinkPreference;
  /** 繁忙时的发送行为。 */
  busySend: BusyPreference;
  /** 圆角风格。 */
  radiusStyle: RadiusStyle;
};

/** localStorage 键名；改动会导致旧用户偏好失效，需谨慎。 */
const STORAGE_KEY = 'pi-studio:preferences';

/** 首次启动或存储损坏时使用的默认偏好。 */
export const DEFAULT_PREFERENCES: Preferences = {
  theme: 'light',
  fontSize: 14,
  stepDisplay: 'standard',
  stepCollapse: 'after-answer',
  showCodeView: false,
  linkOpen: 'external',
  busySend: 'queue',
  radiusStyle: 'standard',
};

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
 * 这里刻意做了两层容错：JSON 解析失败（存储损坏）返回默认值；fontSize 用
 * Number() 归一化，非法值回落到默认字号，避免把 NaN 写进 CSS 变量。
 * 注意 store 中多余的键会被保留，方便回滚版本时仍能读到旧字段。
 */
export function loadPreferences(): Preferences {
  try {
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
    return { ...DEFAULT_PREFERENCES, ...stored, fontSize: Number(stored.fontSize) || DEFAULT_PREFERENCES.fontSize };
  } catch {
    // 返回副本，避免调用方原地修改污染共享的默认值。
    return { ...DEFAULT_PREFERENCES };
  }
}

/**
 * 持久化偏好。
 * 隐私模式或存储配额不足时 localStorage 会抛错，这里静默忽略：
 * 偏好只在本次会话生效，不影响主流程。
 */
export function savePreferences(preferences: Preferences): void {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(preferences)); } catch { /* 存储不可用（隐私模式或配额不足）时静默忽略 */ }
}

/** 更新模块级偏好缓存；应在每次偏好变化且保存后调用。 */
export function setActivePreferences(preferences: Preferences): void {
  activePreferences = preferences;
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
