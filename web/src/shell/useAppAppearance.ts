import { useEffect, useRef, useState } from 'react';
import type { MenuBarPreference } from './app-types';
import { errorText } from '../shared/error-text';
import { useSettingsToast } from '../shared/SettingsToast';
import {
  applyWindowAppearance,
  loadPreferences,
  savePreferences,
  setActivePreferences,
  type Preferences,
} from '../shared/preferences';
import { nativeAppearanceChange } from '../shared/appearance-sync';

export function useAppAppearance() {
  const showToast = useSettingsToast();
  const [preferences, setPreferences] = useState<Preferences>(() => loadPreferences());
  const preferenceNotice = useRef<string>();
  const [backgroundBusy, setBackgroundBusy] = useState(false);
  const [menuBarPreference, setMenuBarPreference] = useState<MenuBarPreference>({
    available: false,
    enabled: true,
    platform: '',
  });
  const [menuBarBusy, setMenuBarBusy] = useState(false);
  const nativeAppearanceKeyRef = useRef('');

  useEffect(() => {
    const notice = preferenceNotice.current;
    preferenceNotice.current = undefined;
    const saved = savePreferences(preferences);
    if (notice) showToast(saved ? notice : '无法保存偏好，本次修改仅在当前窗口生效。', saved ? 'success' : 'error');
    setActivePreferences(preferences);
    const root = document.documentElement;
    applyWindowAppearance(preferences, root);
    const nativeAppearance = nativeAppearanceChange(nativeAppearanceKeyRef.current, preferences);
    if (nativeAppearance.changed) {
      nativeAppearanceKeyRef.current = nativeAppearance.key;
      void window.piApi.setAppearance(
        preferences.theme,
        preferences.palette,
        preferences.radiusStyle,
      ).catch((error) => {
        // A later preference edit may retry the native projection. Renderer
        // appearance remains available in the meantime.
        if (nativeAppearanceKeyRef.current === nativeAppearance.key) {
          nativeAppearanceKeyRef.current = '';
          if (notice && saved) showToast(`偏好已保存，窗口外观同步失败。${errorText(error)}`, 'error');
        }
      });
    }
    if (preferences.fontSize === null) root.style.removeProperty('--chat-font-size');
    else root.style.setProperty('--chat-font-size', `${preferences.fontSize}px`);
    if (preferences.theme !== 'system') return;
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => { root.dataset.theme = media.matches ? 'dark' : 'light'; };
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, [preferences, showToast]);

  useEffect(() => {
    let active = true;
    void window.piApi.menuBarSettings()
      .then((settings) => { if (active && settings) setMenuBarPreference(settings); })
      .catch(() => { /* Menu-bar support is optional in browser-only development. */ });
    return () => { active = false; };
  }, []);

  function updatePreference<K extends keyof Preferences>(key: K, value: Preferences[K]) {
    if (Object.is(preferences[key], value)) return;
    if (document.querySelector('.settings-overlay')) {
      preferenceNotice.current = key === 'backgroundMedia' && value === null ? '背景已移除' : '已保存';
    }
    setPreferences((current) => Object.is(current[key], value) ? current : { ...current, [key]: value });
  }

  async function chooseBackground() {
    setBackgroundBusy(true);
    try {
      const media = await window.piApi.chooseBackgroundMedia({
        replaceUrl: preferences.backgroundMedia?.url,
      });
      if (media) updatePreference('backgroundMedia', media);
    } catch (error) {
      showToast(errorText(error), 'error');
    } finally {
      setBackgroundBusy(false);
    }
  }

  async function removeBackground() {
    const media = preferences.backgroundMedia;
    if (!media) return;
    setBackgroundBusy(true);
    try {
      await window.piApi.removeBackgroundMedia(media.url);
      // Only clear the preference after the app-owned file is gone, so a failed
      // delete leaves the preview and settings in a recoverable state.
      updatePreference('backgroundMedia', null);
    } catch (error) {
      showToast(errorText(error), 'error');
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
      showToast('菜单栏设置已保存');
    } catch (error) {
      setMenuBarPreference(previous);
      showToast(errorText(error), 'error');
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
    showToast('背景文件已不可用，请重新选择。', 'error');
    void window.piApi.removeBackgroundMedia(url).catch(() => {});
  }

  return {
    preferences,
    backgroundBusy,
    menuBarPreference,
    menuBarBusy,
    updatePreference,
    chooseBackground,
    removeBackground,
    changeMenuBarVisibility,
    handleBackgroundUnavailable,
  };
}
