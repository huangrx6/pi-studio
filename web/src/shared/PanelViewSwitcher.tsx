import type { LucideIcon } from 'lucide-react';
import './styles/settings-segments.css';
import './styles/panel-view-switcher.css';

export function PanelViewSwitcher<T extends string>({ label, choices, value, onChange }: {
  label: string;
  choices: ReadonlyArray<readonly [T, string, LucideIcon]>;
  value: T;
  onChange: (value: T) => void;
}) {
  return <nav className="settings-segments panel-view-switcher" aria-label={label}>
    {choices.map(([key, title, Icon]) => <button key={key} type="button" aria-pressed={value === key}
      onClick={() => onChange(key)}><Icon aria-hidden="true" />{title}</button>)}
  </nav>;
}
