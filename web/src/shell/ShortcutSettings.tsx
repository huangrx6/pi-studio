/**
 * 快捷键设置：列出可配置的动作，录制新组合，检测冲突并可一键恢复默认。
 *
 * 录制时只接受带修饰键的组合（否则会劫持日常输入）；已被其他动作占用的组
 * 合直接提示冲突，不写入偏好。
 */
import { useEffect, useState } from 'react';
import { Keyboard, RotateCcw } from 'lucide-react';
import { SettingsPageHeader } from '../shared/SettingsPageHeader';
import type { Preferences } from '../shared/preferences';
import {
  DEFAULT_SHORTCUTS,
  SHORTCUT_ACTIONS,
  comboFromEvent,
  formatShortcut,
  normalizeShortcuts,
  shortcutConflict,
} from '../shared/shortcuts.mjs';

export function ShortcutSettings({ preferences, onChange }: {
  preferences: Preferences;
  onChange: <K extends keyof Preferences>(key: K, value: Preferences[K]) => void;
}) {
  const shortcuts = normalizeShortcuts(preferences.shortcuts) as Record<string, string>;
  const [recording, setRecording] = useState<string | null>(null);
  const [conflict, setConflict] = useState('');

  useEffect(() => {
    if (!recording) return undefined;
    const onKey = (event: KeyboardEvent) => {
      event.preventDefault();
      event.stopPropagation();
      if (event.key === 'Escape') { setRecording(null); setConflict(''); return; }
      const combo = comboFromEvent(event);
      if (!combo) return;
      const other = shortcutConflict(shortcuts, recording, combo);
      if (other) {
        const label = SHORTCUT_ACTIONS.find((action) => action.id === other)?.label ?? other;
        setConflict(`${formatShortcut(combo)} 已被「${label}」占用`);
        return;
      }
      setConflict('');
      setRecording(null);
      onChange('shortcuts', { ...shortcuts, [recording]: combo });
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [recording, shortcuts, onChange]);

  function reset() {
    setConflict('');
    setRecording(null);
    onChange('shortcuts', { ...DEFAULT_SHORTCUTS });
  }

  return <div className="settings-sections shortcut-settings">
    <SettingsPageHeader icon={<Keyboard />} title="快捷键" />
    <section className="settings-card">
      <div className="settings-card-head">
        <div>
          <h2>全局快捷键</h2>
          <p className="settings-card-hint">点击右侧按键开始录制，按下新的组合即可替换；Esc 取消。</p>
        </div>
        <button type="button" className="secondary-button" onClick={reset}><RotateCcw />恢复默认</button>
      </div>
      {conflict && <p className="shortcut-conflict" role="status">{conflict}</p>}
      <div className="shortcut-list">
        {SHORTCUT_ACTIONS.map((action) => {
          const combo = shortcuts[action.id];
          const isDefault = combo === action.default;
          return <div className="shortcut-row" key={action.id}>
            <span className="shortcut-label">
              <strong>{action.label}</strong>
              {action.hint && <small>{action.hint}</small>}
            </span>
            <button
              type="button"
              className={`shortcut-key ${recording === action.id ? 'is-recording' : ''} ${isDefault ? '' : 'is-custom'}`}
              aria-label={`${action.label}：${formatShortcut(combo)}，点击录制新组合`}
              onClick={() => { setConflict(''); setRecording(recording === action.id ? null : action.id); }}
            >
              {recording === action.id ? '按下新组合…' : formatShortcut(combo)}
            </button>
          </div>;
        })}
      </div>
    </section>
  </div>;
}
