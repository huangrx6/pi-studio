import { useContext, useId, useState } from 'react';
import { ChevronRight, RotateCcw } from 'lucide-react';
import { colorLabels, iconLabels, statusAppearance, statusIconDataUrl, type StatusAppearance, type StatusPanel } from '../../shared/extension-appearance';
import { PackageIcon } from '../../shared/PackageIcon';
import { ExtensionAppearanceContext, ExtensionStatusIcon, StatusGlyph } from './ExtensionStatusIcon';

export type ChangePanelAppearance = (id: string, override?: Partial<StatusAppearance>) => void;

export function ExtensionAppearancePicker({ panel, label, onChange }: {
  panel: StatusPanel & { title: string };
  label?: string;
  onChange: ChangePanelAppearance;
}) {
  const [open, setOpen] = useState(false);
  const editorId = useId();
  const override = useContext(ExtensionAppearanceContext)[panel.id];
  const appearance = statusAppearance(panel, override);
  const packageIcon = statusIconDataUrl(panel);
  const packageSelected = Boolean(statusIconDataUrl(panel, override));
  const colorLabel = packageSelected ? '插件原色' : colorLabels[appearance.color];
  const detailView = (panel.slot === 'tool.view' || panel.slot === 'status.detail');
  const action = detailView ? '视图图标与配色' : '图标与配色';
  return <>
    <button className="extension-appearance-trigger" type="button" aria-label={`${panel.title} ${action}`}
      aria-expanded={open} aria-controls={open ? editorId : undefined} onClick={() => setOpen(!open)}>
      <span>{label ?? action}</span>
      <span className="extension-appearance-value"><ExtensionStatusIcon item={panel} />{packageSelected ? '插件默认图标' : `${iconLabels[appearance.icon]} · ${colorLabel}`}</span>
      <ChevronRight aria-hidden="true" />
    </button>
    {open && <div id={editorId} className="extension-appearance-editor" role="group" aria-label={`${panel.title} ${detailView ? '视图外观' : '外观'}`}>
      <fieldset><legend>图标</legend><div className="extension-icon-choices">
        {packageIcon && <button type="button" aria-pressed={packageSelected} aria-label="插件默认图标" title="插件默认图标"
          onClick={() => onChange(panel.id, override?.color ? { color: override.color } : undefined)}>
          <PackageIcon source={packageIcon} fallback={false} />
        </button>}
        {(Object.keys(iconLabels) as StatusAppearance['icon'][]).map(icon =>
          <button key={icon} type="button" aria-pressed={!packageSelected && appearance.icon === icon} aria-label={iconLabels[icon]} title={iconLabels[icon]}
            onClick={() => onChange(panel.id, { ...override, icon })}><StatusGlyph icon={icon} color="neutral" /></button>)}
      </div></fieldset>
      <fieldset><legend>主题配色 · {colorLabel}</legend>{!packageSelected && <div className="extension-color-choices">
        {(Object.keys(colorLabels) as StatusAppearance['color'][]).map(color =>
          <button key={color} type="button" aria-pressed={appearance.color === color} aria-label={colorLabels[color]} title={colorLabels[color]}
            onClick={() => onChange(panel.id, { ...override, color })}>
            <i aria-hidden="true" style={{ background: `var(--extension-icon-${color})` }} />
          </button>)}
      </div>}</fieldset>
      <div className="extension-appearance-preview">
        <span><small>预览</small><ExtensionStatusIcon item={panel} /><strong>{panel.title}</strong></span>
        <button type="button" disabled={!override} onClick={() => onChange(panel.id)}><RotateCcw aria-hidden="true" />恢复默认</button>
      </div>
    </div>}
  </>;
}
