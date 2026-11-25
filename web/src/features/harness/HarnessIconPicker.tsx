import { useId } from 'react';
import { Check } from 'lucide-react';
import catalog from '../../../../assets/settings/harness-profile-icons.json' with { type: 'json' };
import type { HarnessProfileIcon } from '../../types/harness-types';
import { HarnessProfileMark } from './HarnessProfileMark';
import './styles/harness-icon-picker.css';

const shapes = Object.keys(catalog.shapes) as HarnessProfileIcon['shape'][];
const inks = Object.keys(catalog.inks) as HarnessProfileIcon['ink'][];

export function HarnessIconPicker({ id, icon, automatic, onChange }: {
  id: string; icon: HarnessProfileIcon; automatic: boolean; onChange: (value: HarnessProfileIcon | null) => void;
}) {
  const group = useId();
  return <div id={id} className="harness-icon-picker">
    <fieldset><legend>图案</legend>
      <div className="harness-shape-choices">{shapes.map(shape =>
        <label key={shape} className="harness-shape-choice">
          <input type="radio" className="sr-only" name={group + '-shape'} value={shape} checked={icon.shape === shape}
            onChange={() => onChange({ ...icon, shape })} />
          <HarnessProfileMark icon={{ ...icon, shape }} /><span>{catalog.shapes[shape].label}</span>
        </label>)}</div>
    </fieldset>
    <fieldset><legend>颜色</legend>
      <div className="harness-ink-choices">{inks.map(ink =>
        <label key={ink} className="harness-ink-choice" data-ink={ink} title={catalog.inks[ink]}>
          <input type="radio" className="sr-only" name={group + '-ink'} value={ink} checked={icon.ink === ink}
            aria-label={catalog.inks[ink]} onChange={() => onChange({ ...icon, ink })} />
          <span className="harness-ink-dot">{icon.ink === ink && <Check aria-hidden="true" />}</span>
        </label>)}</div>
    </fieldset>
    <button className="settings-text-button harness-icon-auto" type="button" disabled={automatic}
      onClick={() => onChange(null)}>{automatic ? '已自动匹配' : '恢复自动匹配'}</button>
  </div>;
}
