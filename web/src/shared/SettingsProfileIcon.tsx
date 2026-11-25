import { useId, useState, type ReactNode } from 'react';
import { Check, ChevronDown } from 'lucide-react';
import catalog from '../../../assets/settings/profile-icons.json' with { type: 'json' };
import type { ProfileIcon, ProfileIconGroup } from '../types/profile-icon';
import './styles/settings-profile-icon.css';

const shapes = Object.keys(catalog.shapes) as ProfileIcon['shape'][];
const backgrounds: ReadonlyArray<{ ink?: NonNullable<ProfileIcon['ink']>; label: string }> = [
  { label: '跟随主题' },
  ...Object.entries(catalog.inks).map(([ink, { label }]) => ({ ink: ink as NonNullable<ProfileIcon['ink']>, label })),
];
const illustrations = import.meta.glob<string>('./assets/profile-icons/*.webp', { eager: true, import: 'default' });
const builtinIcons: Record<ProfileIconGroup, Record<string, ProfileIcon>> = {
  tools: {
    'main-default': { shape: 'baseline' },
    'temporary-default': { shape: 'inset' },
  },
  permissions: {
    'strict-ask': { shape: 'baseline' },
    'smart-default': { shape: 'inset' },
    'full-access': { shape: 'stagger' },
  },
  harness: {
    'studio-coding': { shape: 'baseline' },
    'studio-temporary': { shape: 'inset' },
  },
};

// Keep the original ID-based assignments when adding picker options.
const automaticShapes = ['inset', 'stagger', 'ascending', 'descending', 'foundation'] as const;

export function automaticProfileIcon(group: ProfileIconGroup, id: string): ProfileIcon {
  const builtins = builtinIcons[group];
  if (Object.hasOwn(builtins, id)) return builtins[id];
  let hash = 0;
  for (const character of id) hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  return { shape: automaticShapes[hash % automaticShapes.length] };
}

export function SettingsProfileMark({ group, icon }: { group: ProfileIconGroup; icon: ProfileIcon }) {
  const { asset } = catalog.shapes[icon.shape][group];
  return <span className="settings-profile-icon" aria-hidden="true" data-shape={icon.shape}
    style={icon.ink ? { backgroundColor: catalog.inks[icon.ink].color } : undefined}>
    <img src={illustrations[`./assets/profile-icons/${asset}.webp`]} alt="" draggable={false} />
  </span>;
}

export function SettingsProfileIdentity({ group, value, automatic, onChange, children }: {
  group: ProfileIconGroup;
  value?: ProfileIcon | null;
  automatic: ProfileIcon;
  onChange: (value: ProfileIcon | null) => void;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const icon = value ?? automatic;
  return <div className="profile-identity-grid">
    <div className="profile-identity-field">
      <span>方案图标</span>
      <button type="button" className="profile-icon-trigger settings-row-link" aria-label="更换方案图标"
        aria-expanded={open} aria-controls={open ? id : undefined} onClick={() => setOpen(!open)}>
        <SettingsProfileMark group={group} icon={icon} />
        <span>更换</span><ChevronDown className="settings-row-link-indicator" aria-hidden="true" />
      </button>
    </div>
    {children}
    {open && <div id={id} className="profile-icon-picker">
      <fieldset className="profile-shape-field"><legend>图案</legend>
        <div className="profile-shape-choices">{shapes.map(shape =>
          <label key={shape} className="profile-shape-choice">
            <input type="radio" className="sr-only" name={id + '-shape'} value={shape} checked={icon.shape === shape}
              onChange={() => onChange({ ...icon, shape })} />
            <span className="profile-shape-preview">
              <SettingsProfileMark group={group} icon={{ ...icon, shape }} />
              {icon.shape === shape && <span className="profile-shape-check" aria-hidden="true"><Check /></span>}
            </span>
            <span>{catalog.shapes[shape][group].title}</span>
          </label>)}</div>
      </fieldset>
      <fieldset><legend>底色</legend>
        <div className="profile-background-choices">{backgrounds.map(({ ink, label }) =>
          <label key={ink ?? 'theme'} className="profile-background-choice">
            <input type="radio" className="sr-only" name={id + '-background'} value={ink ?? 'theme'} checked={icon.ink === ink}
              onChange={() => onChange(ink ? { shape: icon.shape, ink } : { shape: icon.shape })} />
            <span className="profile-background-swatch" aria-hidden="true" data-transparent={ink === 'transparent' || undefined}
              style={ink ? { backgroundColor: catalog.inks[ink].color } : undefined}>
              {icon.ink === ink && <span className="profile-shape-check"><Check /></span>}
            </span>
            <span>{label}</span>
          </label>)}</div>
      </fieldset>
      <button className="settings-text-button" type="button" disabled={!value}
        onClick={() => onChange(null)}>{value ? '恢复自动匹配' : '已自动匹配'}</button>
    </div>}
  </div>;
}
