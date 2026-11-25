import { ChevronRight } from 'lucide-react';
import { pluginOwnershipSourceLine } from '../../shared/plugin-ownership.ts';
import type { ExtensionHostItem } from '../../types/extension-types';
import { ExtensionStatusIcon } from './ExtensionStatusIcon';
import { configurablePanels } from './extension-placement';
import { extensionScopeLabel, extensionStateLabel, extensionStateTone } from './extension-presentation';

export function InstalledExtensionCard({ item, onOpenDetail }: {
  item: ExtensionHostItem;
  onOpenDetail: (item: ExtensionHostItem) => void;
}) {
  const panels = configurablePanels(item);
  const mark = panels.find(panel => panel.slot === 'panel.side') ?? panels[0];
  const source = item.scope === 'builtin' ? 'Pi Studio 内置'
    : pluginOwnershipSourceLine(item) || item.installation?.publisher || item.manifest?.publisher || item.manifest?.author;
  const meta = [`v${item.version}`, item.scope !== 'builtin' && extensionScopeLabel(item.scope)].filter(Boolean).join(' · ');
  const state = extensionStateLabel(item);
  return <article className="installed-extension-card" aria-label={item.name}>
    <button type="button" className="extension-card-open" aria-label={`打开 ${item.name} 设置`}
      aria-haspopup="dialog" onClick={() => onOpenDetail(item)}>
      <span className="extension-card-mark" aria-hidden="true"><ExtensionStatusIcon item={{
        ...(mark ?? { id: item.id, icon: 'layers', color: 'accent' }), iconDataUrl: item.iconDataUrl,
      }} /></span>
      <span className="extension-card-identity">
        <strong title={item.name}>{item.name}</strong>
        <small>{meta}</small>
      </span>
      <span className="extension-card-state" data-tone={item.enabled ? extensionStateTone(item) : 'off'}
        title={item.blockedReason || state}>{state}</span>
      {item.manifest?.description && <span className="extension-card-description">{item.manifest.description}</span>}
      <span className="extension-card-footer">
        <span className="extension-card-source" title={source || undefined}>{source}</span>
        <span className="extension-card-settings" aria-hidden="true"><span>配置</span><ChevronRight /></span>
      </span>
    </button>
  </article>;
}
