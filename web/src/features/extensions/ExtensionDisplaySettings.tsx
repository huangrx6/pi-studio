import type { Preferences } from '../../shared/preferences';
import type { ExtensionHostItem } from '../../types/extension-types';
import { ExtensionAppearancePicker, type ChangePanelAppearance } from './ExtensionAppearancePicker';
import {
  configurablePanels,
  panelContributionId,
  placementFor,
  placementOptionsFor,
  type ConfigurablePanel,
} from './extension-placement';

type DisplayPreferences = Pick<Preferences, 'extensionPlacements' | 'extensionAppearances'>;
type DisplayPanelEntry = { panel: ConfigurablePanel; companionIds: string[] };

/**
 * When a summary panel (e.g. `status.chip`) links directly to a side panel with the
 * exact same title via `details`, present one unified appearance control and keep both
 * panel IDs in sync instead of rendering two duplicate "图标与配色" rows.
 */
function resolveDisplayPanels(item: ExtensionHostItem): DisplayPanelEntry[] {
  const panels = configurablePanels(item);
  const rawPanels = item.manifest?.contributes?.panels ?? [];
  const manifestId = item.manifest?.id;
  if (!manifestId || panels.length <= 1) {
    return panels.map(panel => ({ panel, companionIds: [] }));
  }
  const byId = new Map(panels.map(panel => [panel.id, panel]));
  const absorbed = new Set<string>();
  const companions = new Map<string, string[]>();
  for (const raw of rawPanels) {
    if (!raw.details) continue;
    const summaryId = panelContributionId(item.scope, manifestId, raw.id);
    const detailId = panelContributionId(item.scope, manifestId, raw.details);
    const summary = byId.get(summaryId);
    const detail = byId.get(detailId);
    if (summary && detail && detail.slot === 'panel.side' && summary.title === detail.title) {
      absorbed.add(detailId);
      companions.set(summaryId, [...(companions.get(summaryId) ?? []), detailId]);
    }
  }
  return panels
    .filter(panel => !absorbed.has(panel.id))
    .map(panel => ({ panel, companionIds: companions.get(panel.id) ?? [] }));
}

export function ExtensionDisplaySettings({ item, preferences, onChange }: {
  item: ExtensionHostItem;
  preferences: DisplayPreferences;
  onChange: <K extends keyof DisplayPreferences>(key: K, value: Preferences[K]) => void;
}) {
  const entries = resolveDisplayPanels(item);
  if (!entries.length) return null;
  const updateAppearance = (ids: string[]): ChangePanelAppearance => (_id, override) => {
    const next = { ...preferences.extensionAppearances };
    for (const id of ids) {
      if (override) next[id] = override;
      else delete next[id];
    }
    onChange('extensionAppearances', next);
  };
  return <section className="extension-display-settings" aria-label="界面显示">
    <h3>界面显示</h3>
    <div className="extension-display-panels">
      {entries.map(({ panel, companionIds }) => {
        const showName = entries.length > 1 || panel.title !== item.name;
        const current = placementFor(preferences.extensionPlacements, panel.id, panel.slots, item.id);
        const appearanceLabel = showName
          ? `${panel.title} · ${panel.slot === 'panel.side' ? '工作台图标与配色' : '图标与配色'}`
          : undefined;
        return <div className="extension-display-panel" key={panel.id}>
          {panel.slots.length > 0 && <div className="extension-display-placement">
            <span>{showName ? `${panel.title} · 显示位置` : '显示位置'}</span>
            <div className="settings-segments extension-placement-options" role="group" aria-label={`${panel.title} 显示位置`}>
              {placementOptionsFor(panel.slots, item.id).map(({ value, label }) => <button key={value} type="button" aria-pressed={current === value}
                onClick={() => onChange('extensionPlacements', { ...preferences.extensionPlacements, [panel.id]: value })}>{label}</button>)}
            </div>
          </div>}
          <ExtensionAppearancePicker
            panel={panel}
            label={appearanceLabel}
            onChange={updateAppearance([panel.id, ...companionIds])}
          />
        </div>;
      })}
    </div>
  </section>;
}
