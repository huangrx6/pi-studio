import type { PalettePreference, RadiusStyle, ThemePreference } from './preferences';

export type NativeAppearancePreferences = {
  theme: ThemePreference;
  palette: PalettePreference;
  radiusStyle: RadiusStyle;
};

export function nativeAppearanceKey(preferences: NativeAppearancePreferences): string {
  return JSON.stringify([
    preferences.theme,
    preferences.palette,
    preferences.radiusStyle,
  ]);
}

/**
 * Native appearance only depends on three fields. Slider and reading-preference
 * updates must not repeat the SQLite/native-window IPC on every input event.
 */
export function nativeAppearanceChange(
  previousKey: string,
  preferences: NativeAppearancePreferences,
): { key: string; changed: boolean } {
  const key = nativeAppearanceKey(preferences);
  return { key, changed: key !== previousKey };
}
