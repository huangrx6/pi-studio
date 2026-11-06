/** Configure application shortcuts without trapping keyboard or composition input. */
import { useEffect, useId, useRef, useState } from 'react';
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
import './shortcut-settings.css';

export function ShortcutSettings({ preferences, onChange }: {
  preferences: Preferences;
  onChange: <K extends keyof Preferences>(key: K, value: Preferences[K]) => void;
}) {
  const shortcuts = normalizeShortcuts(preferences.shortcuts) as Record<string, string>;
  const [recording, setRecording] = useState<string | null>(null);
  const [conflict, setConflict] = useState('');
  const [status, setStatus] = useState('');
  const recordingButton = useRef<HTMLButtonElement | null>(null);
  const helpId = useId();
  const statusId = useId();
  const hasCustomShortcuts = SHORTCUT_ACTIONS.some((action) => shortcuts[action.id] !== action.default);

  function cancelRecording() {
    recordingButton.current = null;
    setRecording(null);
    setConflict('');
    setStatus('已取消录制，快捷键未更改。');
  }

  useEffect(() => {
    if (!recording) return undefined;
    // Close synchronously as well as in React state: two keys dispatched in the
    // same browser task must never save twice before the effect is cleaned up.
    let active = true;
    const cancel = () => {
      if (!active) return;
      active = false;
      cancelRecording();
    };
    const onKey = (event: KeyboardEvent) => {
      if (!active || !recordingButton.current) return;
      if (event.isComposing || event.keyCode === 229) return;
      // Keep native Tab navigation, but never dispatch an application shortcut
      // while recording (including another listener on this capture target).
      event.stopImmediatePropagation();
      if (event.key === 'Tab') { cancel(); return; }
      event.preventDefault();
      if (event.key === 'Escape') { cancel(); return; }
      if (event.repeat) return;
      const combo = comboFromEvent(event);
      if (!combo) {
        if (!['Control', 'Meta', 'Alt', 'Shift'].includes(event.key)) {
          setConflict('请使用带修饰键的有效组合。');
        }
        return;
      }
      const other = shortcutConflict(shortcuts, recording, combo);
      if (other) {
        const label = SHORTCUT_ACTIONS.find((action) => action.id === other)?.label ?? other;
        setConflict(`${formatShortcut(combo)} 已被「${label}」占用`);
        return;
      }
      active = false;
      recordingButton.current = null;
      setConflict('');
      setRecording(null);
      setStatus(`已将「${SHORTCUT_ACTIONS.find((action) => action.id === recording)?.label}」设为 ${formatShortcut(combo)}。`);
      onChange('shortcuts', { ...shortcuts, [recording]: combo });
    };
    const onPointer = (event: PointerEvent) => {
      if (!recordingButton.current?.contains(event.target as Node)) cancel();
    };
    const onFocus = (event: FocusEvent) => {
      if (!recordingButton.current?.contains(event.target as Node)) cancel();
    };
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('pointerdown', onPointer, true);
    window.addEventListener('focusin', onFocus, true);
    window.addEventListener('blur', cancel);
    return () => {
      active = false;
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('pointerdown', onPointer, true);
      window.removeEventListener('focusin', onFocus, true);
      window.removeEventListener('blur', cancel);
    };
  }, [recording, preferences.shortcuts, onChange]);

  function reset() {
    recordingButton.current = null;
    setConflict('');
    setRecording(null);
    setStatus('已恢复默认快捷键。');
    onChange('shortcuts', { ...DEFAULT_SHORTCUTS });
  }

  return <div className="settings-sections shortcut-settings">
    <SettingsPageHeader icon={<Keyboard />} title="快捷键" actions={
      hasCustomShortcuts
        ? <button type="button" className="secondary-button" onClick={reset}><RotateCcw />恢复默认</button>
        : undefined
    } />
    <p className="shortcut-help" id={helpId}>选择按键后，按下带修饰键的新组合。Esc 取消，Tab 移至下一项。</p>
    <p className={`shortcut-status${conflict ? ' shortcut-conflict' : ''}`} id={statusId} role="status" aria-live="polite" aria-atomic="true">{conflict || status}</p>
    <div className="shortcut-list">
      {SHORTCUT_ACTIONS.map((action) => {
        const combo = shortcuts[action.id];
        const isDefault = combo === action.default;
        const isRecording = recording === action.id;
        return <div className="shortcut-row" key={action.id}>
          <span className="shortcut-label">
            <strong>{action.label}</strong>
            {action.hint && <small>{action.hint}</small>}
          </span>
          <button
            type="button"
            className={`shortcut-key ${isRecording ? 'is-recording' : ''} ${isDefault ? '' : 'is-custom'}`}
            aria-label={`${action.label}：${formatShortcut(combo)}，${isRecording ? '正在录制，点击取消' : '点击录制新组合'}`}
            aria-pressed={isRecording}
            aria-describedby={`${helpId} ${statusId}`}
            onBlur={() => { if (isRecording) cancelRecording(); }}
            onClick={(event) => {
              if (isRecording) { cancelRecording(); return; }
              recordingButton.current = event.currentTarget;
              setConflict('');
              setRecording(action.id);
              setStatus(`正在录制「${action.label}」，请按下新组合。`);
            }}
          >
            {isRecording ? '按下新组合…' : formatShortcut(combo)}
          </button>
        </div>;
      })}
    </div>
  </div>;
}
