import { ChevronRight } from 'lucide-react';
import type { ExtensionPlacement } from '../../shared/preferences';
import type { ExtensionHostItem } from '../../types/extension-types';
import { InstalledExtensionCard } from './InstalledExtensionCard';
import './extension-lists.css';

type InstalledExtensionsSectionProps = {
  items: ExtensionHostItem[];
  busy: boolean;
  placements?: Record<string, ExtensionPlacement>;
  onPlacementChange?: (contributionId: string, placement: ExtensionPlacement) => void;
  onOpenDetail: (item: ExtensionHostItem) => void;
  onToggle: (item: ExtensionHostItem, enabled: boolean) => void;
  onDelete: (id: string, name: string) => void;
};

/** User extensions stay visible; built-in capabilities remain available behind one quiet disclosure. */
export function InstalledExtensionsSection({ items, busy, placements, onPlacementChange, onOpenDetail, onToggle, onDelete }: InstalledExtensionsSectionProps) {
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
          onOpenDetail={onOpenDetail}
          onToggle={onToggle}
          onDelete={onDelete}
        />)}
      </div>
    </section>}
    {builtins.length > 0 && <details className="extension-list-section builtin-extension-section">
      <summary className="builtin-extension-summary">
        <span className="builtin-extension-summary-main">
          <ChevronRight aria-hidden="true" />
          <strong>内置能力</strong>
          <span className="count-badge">{builtins.length}</span>
        </span>
        <small>Pi Studio 自带，可查看和单独启停</small>
      </summary>
      <div className="extension-list installed-extension-grid">
        {builtins.map((item) => <InstalledExtensionCard
          key={`${item.scope}:${item.id}`}
          item={item}
          busy={busy}
          compact
          placements={placements}
          onPlacementChange={onPlacementChange}
          onOpenDetail={onOpenDetail}
          onToggle={onToggle}
          onDelete={onDelete}
        />)}
      </div>
    </details>}
    {items.length === 0 && <section className="extension-list-section installed-extension-section">
      <div className="extension-list-heading"><h2>已安装</h2></div>
      <div className="settings-empty">还没有安装扩展</div>
    </section>}
  </>;
}
