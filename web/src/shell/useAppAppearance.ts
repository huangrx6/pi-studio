import { useEffect, useRef, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import type { MenuBarPreference } from './app-types';
import { errorText } from '../shared/error-text';
import {
  RADIUS_PRESETS,
  loadPreferences,
  resolveTheme,
  savePreferences,
  setActivePreferences,
  type Preferences,
} from '../shared/preferences';
import { nativeAppearanceChange } from '../shared/appearance-sync';

type Setter<T> = Dispatch<SetStateAction<T>>;

export function useAppAppearance(setSettingsError: Setter<string | null>) {
  const [preferences, setPreferences] = useState<Preferences>(() => loadPreferences());
  const [backgroundBusy, setBackgroundBusy] = useState(false);
  const [backgroundError, setBackgroundError] = useState<string | null>(null);
  const [menuBarPreference, setMenuBarPreference] = useState<MenuBarPreference>({
    available: false,
    enabled: true,
    platform: '',
  });
  const [menuBarBusy, setMenuBarBusy] = useState(false);
  const nativeAppearanceKeyRef = useRef('');

  useEffect(() => {
    savePreferences(preferences);
    setActivePreferences(preferences);
    const root = document.documentElement;
    root.dataset.theme = resolveTheme(preferences.theme);
    root.dataset.palette = preferences.palette;
    const nativeAppearance = nativeAppearanceChange(nativeAppearanceKeyRef.current, preferences);
    if (nativeAppearance.changed) {
      nativeAppearanceKeyRef.current = nativeAppearance.key;
      void window.piApi.setAppearance(
        preferences.theme,
        preferences.palette,
        preferences.radiusStyle,
      ).catch(() => {
        // A later preference edit may retry the native projection. Renderer
        // appearance remains available in the meantime.
        if (nativeAppearanceKeyRef.current === nativeAppearance.key) {
          nativeAppearanceKeyRef.current = '';
        }
      });
    }
    root.style.setProperty('--chat-font-size', `${preferences.fontSize}px`);
    const radii = RADIUS_PRESETS[preferences.radiusStyle] || RADIUS_PRESETS.standard;
    root.style.setProperty('--radius-tag', `${radii.tag}px`);
    root.style.setProperty('--radius-control', `${radii.control}px`);
    root.style.setProperty('--radius-card', `${radii.card}px`);
    root.style.setProperty('--radius-panel', `${radii.panel}px`);
    root.style.setProperty('--radius-round', `${radii.round}px`);
    if (preferences.theme !== 'system') return;
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => { root.dataset.theme = media.matches ? 'dark' : 'light'; };
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, [preferences]);

  useEffect(() => {
    let active = true;
    void window.piApi.menuBarSettings()
      .then((settings) => { if (active && settings) setMenuBarPreference(settings); })
      .catch(() => { /* Menu-bar support is optional in browser-only development. */ });
    return () => { active = false; };
  }, []);

  function updatePreference<K extends keyof Preferences>(key: K, value: Preferences[K]) {
    setPreferences((current) => ({ ...current, [key]: value }));
  }

  async function chooseBackground() {
    setBackgroundBusy(true);
    setBackgroundError(null);
    try {
      const media = await window.piApi.chooseBackgroundMedia({
        replaceUrl: preferences.backgroundMedia?.url,
      });
      if (media) updatePreference('backgroundMedia', media);
    } catch (error) {
      setBackgroundError(errorText(error));
    } finally {
      setBackgroundBusy(false);
    }
  }

  async function removeBackground() {
    const media = preferences.backgroundMedia;
    if (!media) return;
    setBackgroundBusy(true);
    setBackgroundError(null);
    updatePreference('backgroundMedia', null);
    try {
      await window.piApi.removeBackgroundMedia(media.url);
    } catch (error) {
      setBackgroundError(errorText(error));
    } finally {
      setBackgroundBusy(false);
    }
  }

  async function changeMenuBarVisibility(enabled: boolean) {
    if (menuBarBusy || !menuBarPreference.available) return;
    const previous = menuBarPreference;
    setMenuBarBusy(true);
    setMenuBarPreference((current) => ({ ...current, enabled }));
    try {
      const next = await window.piApi.setMenuBarVisible(enabled);
      if (next) setMenuBarPreference(next);
    } catch (error) {
      setMenuBarPreference(previous);
      setSettingsError(errorText(error));
    } finally {
      setMenuBarBusy(false);
    }
  }

  function handleBackgroundUnavailable(url: string) {
    setPreferences((current) => (
      current.backgroundMedia?.url === url
        ? { ...current, backgroundMedia: null }
        : current
    ));
    setBackgroundError('背景文件已不可用，请重新选择。');
    void window.piApi.removeBackgroundMedia(url).catch(() => {});
  }

  return {
    preferences,
    backgroundBusy,
    backgroundError,
    menuBarPreference,
    menuBarBusy,
    updatePreference,
    chooseBackground,
    removeBackground,
    changeMenuBarVisibility,
    handleBackgroundUnavailable,
  };
}
