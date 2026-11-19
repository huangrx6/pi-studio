import { Accordion } from '../../shared/Accordion';
import { ChevronRight } from 'lucide-react';
import type { ExtensionPlacement } from '../../shared/preferences';
import type { ExtensionHostItem } from '../../types/extension-types';
import { InstalledExtensionCard } from './InstalledExtensionCard';
import type { ChangePanelAppearance } from './ExtensionAppearancePicker';
import './styles/extension-lists.css';

type InstalledExtensionsSectionProps = {
  items: ExtensionHostItem[];
  busy: boolean;
  placements?: Record<string, ExtensionPlacement>;
  onPlacementChange?: (contributionId: string, placement: ExtensionPlacement) => void;
  onAppearanceChange?: ChangePanelAppearance;
  onOpenDetail: (item: ExtensionHostItem) => void;
  onToggle: (item: ExtensionHostItem, enabled: boolean) => void;
  onDelete: (id: string, name: string) => void;
};

/** User extensions stay visible; built-in capabilities remain available behind one quiet disclosure. */
export function InstalledExtensionsSection({ items, busy, placements, onPlacementChange, onAppearanceChange, onOpenDetail, onToggle, onDelete }: InstalledExtensionsSectionProps) {
  const installed = items.filter((item) => item.scope !== 'builtin');
  const builtins = items.filter((item) => item.scope === 'builtin');
  return <>
    {installed.length > 0 && <section className="extension-list-section installed-extension-section">
      <div className="extension-list-heading"><h2>已安装</h2></div>
      <div className="extension-list installed-extension-grid">
        {installed.map((item) => <InstalledExtensionCard
          key={`${item.scope}:${item.id}`}
          item={item}
          busy={busy}
          placements={placements}
          onPlacementChange={onPlacementChange}
          onAppearanceChange={onAppearanceChange}
          onOpenDetail={onOpenDetail}
          onToggle={onToggle}
          onDelete={onDelete}
        />)}
      </div>
    </section>}
    {builtins.length > 0 && <Accordion
      className="extension-list-section builtin-extension-section"
      summary="内置能力"
      badge={builtins.length}
      description="Pi Studio 自带，可查看和单独启停"
      summaryClassName="builtin-extension-summary"
      // Open when something is off so users arriving from usage/settings can re-enable it quickly.
      defaultOpen={builtins.some((item) => !item.enabled)}
    >
      <div className="extension-list installed-extension-grid">
        {builtins.map((item) => <InstalledExtensionCard
          key={`${item.scope}:${item.id}`}
          item={item}
          busy={busy}
          compact
          placements={placements}
          onPlacementChange={onPlacementChange}
          onAppearanceChange={onAppearanceChange}
          onOpenDetail={onOpenDetail}
          onToggle={onToggle}
          onDelete={onDelete}
        />)}
      </div>
    </Accordion>}
    {items.length === 0 && <section className="extension-list-section installed-extension-section">
      <div className="extension-list-heading"><h2>已安装</h2></div>
      <div className="settings-empty">还没有安装扩展</div>
    </section>}
  </>;
}
