export type ThemePreference = 'light' | 'dark' | 'system';
export type StepDisplay = 'compact' | 'standard' | 'detailed';
export type StepCollapse = 'after-answer' | 'keep-open' | 'manual';
export type LinkPreference = 'external' | 'window';
export type BusyPreference = 'queue' | 'steer';
export type PerformancePreference = 'simple' | 'detailed';
export type RadiusStyle = 'square' | 'compact' | 'standard' | 'soft';

export type Preferences = {
  theme: ThemePreference;
  fontSize: number;
  stepDisplay: StepDisplay;
  stepCollapse: StepCollapse;
  showCodeView: boolean;
  linkOpen: LinkPreference;
  busySend: BusyPreference;
  performance: PerformancePreference;
  radiusStyle: RadiusStyle;
};

const STORAGE_KEY = 'pi-studio:preferences';
export const DEFAULT_PREFERENCES: Preferences = {
  theme: 'light',
  fontSize: 14,
  stepDisplay: 'standard',
  stepCollapse: 'after-answer',
  showCodeView: false,
  linkOpen: 'external',
  busySend: 'queue',
  performance: 'detailed',
  radiusStyle: 'standard',
};

export const RADIUS_PRESETS: Record<RadiusStyle, { tag: number; control: number; card: number; panel: number; round: number }> = {
  square: { tag: 0, control: 0, card: 0, panel: 0, round: 0 },
  compact: { tag: 3, control: 6, card: 9, panel: 12, round: 999 },
  standard: { tag: 4, control: 8, card: 12, panel: 16, round: 999 },
  soft: { tag: 6, control: 10, card: 16, panel: 22, round: 999 },
};

let activePreferences = DEFAULT_PREFERENCES;

export function loadPreferences(): Preferences {
  try {
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
    return { ...DEFAULT_PREFERENCES, ...stored, fontSize: Number(stored.fontSize) || DEFAULT_PREFERENCES.fontSize };
  } catch {
    return DEFAULT_PREFERENCES;
  }
}

export function savePreferences(preferences: Preferences): void {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(preferences)); } catch { /* storage unavailable */ }
}

export function setActivePreferences(preferences: Preferences): void {
  activePreferences = preferences;
}

export function getActivePreferences(): Preferences {
  return activePreferences;
}

export function resolveTheme(theme: ThemePreference): 'light' | 'dark' {
  if (theme === 'system') return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  return theme;
}
