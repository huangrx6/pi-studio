import { useRef, useState, type CSSProperties } from 'react';
import { isComposingKey, menuFocusIndex } from './keyboard-navigation';
import './styles/settings-tabs.css';

export function SettingsTabs<T extends string>({
  id, label, tabs, value, onChange,
}: {
  id: string;
  label: string;
  tabs: readonly { value: T; label: string }[];
  value: T;
  onChange: (value: T) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [focused, setFocused] = useState<T>();
  const selectedIndex = tabs.findIndex(tab => tab.value === value);

  return <div
    ref={ref}
    className="settings-tabs"
    role="tablist"
    aria-label={label}
    style={{ '--tab-count': tabs.length, '--active-tab': selectedIndex } as CSSProperties}
    onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setFocused(undefined); }}
    onKeyDown={(event) => {
      if (isComposingKey(event.nativeEvent)) return;
      const buttons = [...(ref.current?.querySelectorAll('button') ?? [])];
      const key = event.key === 'ArrowLeft' ? 'ArrowUp' : event.key === 'ArrowRight' ? 'ArrowDown' : event.key;
      if (event.key === 'ArrowUp' || event.key === 'ArrowDown') return;
      const next = menuFocusIndex(key, buttons.indexOf(document.activeElement as HTMLButtonElement), buttons.length, true);
      if (next !== null) {
        event.preventDefault();
        buttons[next]?.focus();
      }
    }}
  >
    {tabs.map(tab => <button
      id={`${id}-${tab.value}`}
      key={tab.value}
      type="button"
      role="tab"
      aria-selected={tab.value === value}
      aria-controls={`${id}-panel`}
      tabIndex={tab.value === (focused ?? value) ? 0 : -1}
      onFocus={() => setFocused(tab.value)}
      onClick={() => onChange(tab.value)}
    >{tab.label}</button>)}
  </div>;
}
