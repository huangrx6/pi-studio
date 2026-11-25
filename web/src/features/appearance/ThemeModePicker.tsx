import { Check } from 'lucide-react';
import type { ThemePreference } from '../../shared/preferences';
import './styles/theme-mode-picker.css';

const MODES = [
  { value: 'light', label: '浅色' },
  { value: 'dark', label: '深色' },
  { value: 'system', label: '跟随系统' },
] as const;

function WindowSample({ scheme }: { scheme: 'light' | 'dark' }) {
  return <span className="theme-sample-stage" data-scheme={scheme}>
    <span className="theme-sample-window">
      <span className="theme-sample-rail"><i /><i /><i /></span>
      <span className="theme-sample-chat"><i /><i /><i /><span className="theme-sample-composer" /></span>
    </span>
  </span>;
}

export function ThemeModePicker({ value, onChange }: {
  value: ThemePreference;
  onChange: (value: ThemePreference) => void;
}) {
  return <div className="theme-mode-picker" role="group" aria-label="界面模式">
    {MODES.map(mode => <button key={mode.value} type="button" className="theme-choice"
      aria-pressed={value === mode.value} onClick={() => onChange(mode.value)}>
      <span className="theme-choice-preview" aria-hidden="true">
        <WindowSample scheme={mode.value === 'dark' ? 'dark' : 'light'} />
        {mode.value === 'system' && <WindowSample scheme="dark" />}
      </span>
      <span className="theme-choice-caption">
        {mode.label}
        <span className="theme-choice-check" aria-hidden="true">{value === mode.value && <Check />}</span>
      </span>
    </button>)}
  </div>;
}
