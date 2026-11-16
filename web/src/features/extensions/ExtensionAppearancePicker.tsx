import { useContext, useId, useState } from 'react';
import { ChevronDown, RotateCcw } from 'lucide-react';
import { colorLabels, iconLabels, statusAppearance, type StatusAppearance, type StatusPanel } from '../../shared/extension-appearance';
import { ExtensionAppearanceContext, StatusGlyph } from './ExtensionStatusIcon';

export type ChangePanelAppearance = (id: string, override?: Partial<StatusAppearance>) => void;

export function ExtensionAppearancePicker({ panel, onChange }: {
  panel: StatusPanel & { title: string };
  onChange: ChangePanelAppearance;
}) {
  const [open, setOpen] = useState(false);
  const editorId = useId();
  const override = useContext(ExtensionAppearanceContext)[panel.id];
  const appearance = statusAppearance(panel, override);
  return <>
    <button className="extension-appearance-trigger" type="button" aria-label={`${panel.title} 图标与配色`}
      aria-expanded={open} aria-controls={open ? editorId : undefined} onClick={() => setOpen(!open)}>
      <StatusGlyph {...appearance} />图标与配色<ChevronDown aria-hidden="true" />
    </button>
    {open && <div id={editorId} className="extension-appearance-editor" role="group" aria-label={`${panel.title} 外观`}>
      <fieldset><legend>图标</legend><div className="extension-icon-choices">
        {(Object.keys(iconLabels) as StatusAppearance['icon'][]).map(icon =>
          <button key={icon} type="button" aria-pressed={appearance.icon === icon} aria-label={iconLabels[icon]} title={iconLabels[icon]}
            onClick={() => onChange(panel.id, { ...override, icon })}><StatusGlyph icon={icon} color="neutral" /></button>)}
      </div></fieldset>
      <fieldset><legend>主题配色 · {colorLabels[appearance.color]}</legend><div className="extension-color-choices">
        {(Object.keys(colorLabels) as StatusAppearance['color'][]).map(color =>
          <button key={color} type="button" aria-pressed={appearance.color === color} aria-label={colorLabels[color]} title={colorLabels[color]}
            onClick={() => onChange(panel.id, { ...override, color })}>
            <i aria-hidden="true" style={{ background: `var(--extension-icon-${color})` }} />
          </button>)}
      </div></fieldset>
      <div className="extension-appearance-preview">
        <span><small>预览</small><StatusGlyph {...appearance} /><strong>{panel.title}</strong></span>
        <button type="button" disabled={!override} onClick={() => onChange(panel.id)}><RotateCcw aria-hidden="true" />恢复默认</button>
      </div>
    </div>}
  </>;
}
