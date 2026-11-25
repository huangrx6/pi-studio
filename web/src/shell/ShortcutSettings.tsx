/** Configure application shortcuts without trapping keyboard or composition input. */
import { useEffect, useId, useRef, useState } from 'react';
import { RotateCcw } from 'lucide-react';
import { SettingsPageHeader } from '../shared/SettingsPageHeader';
import { useSettingsToast } from '../shared/SettingsToast';
import type { Preferences } from '../shared/preferences';
import {
  DEFAULT_SHORTCUTS,
  SHORTCUT_ACTIONS,
  comboFromEvent,
  formatShortcut,
  formatShortcutParts,
  normalizeShortcuts,
  shortcutConflict,
} from '../shared/shortcuts.ts';
import './styles/shortcut-settings.css';

type ShortcutAction = (typeof SHORTCUT_ACTIONS)[number];

function conflictMessage(bindings: Record<string, string>, actionId: string, combo: string) {
  const owner = shortcutConflict(bindings, actionId, combo);
  if (!owner) return '';
  const label = SHORTCUT_ACTIONS.find(action => action.id === owner)?.label ?? owner;
  return `${formatShortcut(combo)} 已被「${label}」占用`;
}

export function ShortcutSettings({ preferences, onChange }: {
  preferences: Preferences;
  onChange: <K extends keyof Preferences>(key: K, value: Preferences[K]) => void;
}) {
  const showToast = useSettingsToast();
  const shortcuts = normalizeShortcuts(preferences.shortcuts);
  const [recording, setRecording] = useState<string | null>(null);
  const [status, setStatus] = useState('');
  const recordingButton = useRef<HTMLButtonElement | null>(null);
  const page = useRef<HTMLDivElement>(null);
  const helpId = useId();
  const customActions = SHORTCUT_ACTIONS.filter(action => shortcuts[action.id] !== action.default);

  function cancelRecording() {
    recordingButton.current = null;
    setRecording(null);
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
          showToast('请使用带修饰键的有效组合。', 'error');
        }
        return;
      }
      const message = conflictMessage(shortcuts, recording, combo);
      if (message) {
        showToast(message, 'error');
        return;
      }
      active = false;
      recordingButton.current = null;
      setRecording(null);
      setStatus(`已将「${SHORTCUT_ACTIONS.find((action) => action.id === recording)?.label}」设为 ${formatShortcut(combo)}。`);
      onChange('shortcuts', { ...shortcuts, [recording]: combo });
    };
    const onPointer = (event: PointerEvent) => {
      const button = recordingButton.current;
      const target = event.target as Node;
      if (!button?.contains(target) && !Array.from(button?.labels ?? []).some(label => label.contains(target))) cancel();
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
  }, [recording, preferences.shortcuts, onChange, showToast]);

  function focusBinding(id: string) {
    page.current?.querySelector<HTMLButtonElement>(`[data-shortcut-id="${id}"]`)?.focus();
  }

  function resetOne(action: ShortcutAction) {
    const message = conflictMessage(shortcuts, action.id, action.default);
    if (message) {
      showToast(`${message}，请先修改该项。`, 'error');
      return;
    }
    setStatus(`已将「${action.label}」恢复为默认 ${formatShortcut(action.default)}。`);
    onChange('shortcuts', { ...shortcuts, [action.id]: action.default });
    focusBinding(action.id);
  }

  function resetAll() {
    recordingButton.current = null;
    setRecording(null);
    setStatus('已恢复默认快捷键。');
    onChange('shortcuts', { ...DEFAULT_SHORTCUTS });
    const lastCustom = customActions.at(-1);
    if (lastCustom) focusBinding(lastCustom.id);
  }

  function renderShortcut(action: ShortcutAction) {
    const combo = shortcuts[action.id];
    const isCustom = combo !== action.default;
    const isRecording = recording === action.id;
    const hint = isRecording ? 'Esc 取消，Tab 下一项' : '';
    const bindingId = `${helpId}-${action.id}`;
    const hintId = `${bindingId}-hint`;
    return <li className="shortcut-row" key={action.id}>
      <label className="shortcut-label" htmlFor={bindingId}>
        <span>{action.label}</span>
        {hint && <small id={hintId}>{hint}</small>}
      </label>
      <div className="shortcut-controls">
        {isCustom && !isRecording && <button type="button" className="shortcut-reset-one"
          aria-label={`将「${action.label}」恢复为默认`} title={`恢复为 ${formatShortcut(action.default)}`}
          onClick={() => resetOne(action)}>
          <RotateCcw aria-hidden="true" />
        </button>}
        <button type="button" id={bindingId} className={`shortcut-key${isCustom ? ' is-custom' : ''}`} data-shortcut-id={action.id}
          aria-label={`${action.label}：${formatShortcut(combo)}，${isRecording ? '正在录制，点击取消' : '点击录制新组合'}`}
          aria-pressed={isRecording} aria-describedby={hint ? `${helpId} ${hintId}` : helpId}
          onBlur={() => { if (isRecording) cancelRecording(); }}
          onClick={event => {
            if (isRecording) { cancelRecording(); return; }
            recordingButton.current = event.currentTarget;
            setRecording(action.id);
            setStatus(`正在录制「${action.label}」。按下新组合，Esc 取消，Tab 下一项。`);
          }}>
          {isRecording ? <span className="shortcut-record-prompt">按下新组合…</span>
            : <span className="shortcut-keys" aria-hidden="true">
              {formatShortcutParts(combo).map((part, index) => <kbd key={index}>{part}</kbd>)}
            </span>}
        </button>
      </div>
    </li>;
  }

  return <div className="settings-preference-page shortcut-settings" ref={page}>
    <SettingsPageHeader title="快捷键" iconPosition="end"
      meta={<span id={helpId}>点选右侧按键，按下带修饰键的新组合即可保存。</span>}
      icon={<svg className="shortcut-keyboard-mark" viewBox="0 0 32 32" fill="none" stroke="currentColor"
        strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
        <rect x="1" y="6.5" width="30" height="19" rx="3.5" />
        <path d="M6 12h1m4 0h1m4 0h1M6 16.5h1m4 0h1m4 0h1M9 21h7" />
        <path stroke="var(--accent)" d="M26 13v5h-5m2.5-2.5L21 18l2.5 2.5" />
      </svg>} />
    <p className="sr-only" role="status" aria-atomic="true">{status}</p>
    <div className="settings-preference-groups">
      <ul className="settings-preference-card shortcut-bindings" aria-label="快捷键绑定">
        {SHORTCUT_ACTIONS.map(renderShortcut)}
      </ul>
      {customActions.length > 0 && <div className="shortcut-footer">
        <span>已自定义 {customActions.length} 项</span>
        <button type="button" className="secondary-button" title="恢复所有快捷键的默认值" onClick={resetAll}>
          <RotateCcw aria-hidden="true" />恢复默认
        </button>
      </div>}
    </div>
  </div>;
}
