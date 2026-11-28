import { pluginOwnershipSourceLine } from '../../shared/plugin-ownership.ts';
import type { ExtensionHostItem } from '../../types/extension-types';
import { ExtensionStatusIcon } from './ExtensionStatusIcon';
import { configurablePanels } from './extension-placement';
import { extensionScopeLabel, extensionStateLabel, extensionStateTone } from './extension-presentation';

function extensionCapabilitySummary(item: ExtensionHostItem): string {
  const contributes = item.manifest?.contributes;
  if (!contributes) return '';
  const parts: string[] = [];
  if (contributes.tools?.length) parts.push(`${contributes.tools.length} 工具`);
  if (contributes.panels?.length) parts.push(`${contributes.panels.length} 面板`);
  if (contributes.commands?.length) parts.push(`${contributes.commands.length} 命令`);
  return parts.slice(0, 2).join(' · ');
}

export function InstalledExtensionCard({ item, onOpenDetail }: {
  item: ExtensionHostItem;
  onOpenDetail: (item: ExtensionHostItem) => void;
}) {
  const isBuiltin = item.scope === 'builtin';
  const panels = configurablePanels(item);
  const mark = panels.find(panel => (panel.slot === 'tool.view' || panel.slot === 'status.detail')) ?? panels[0];
  const source = isBuiltin ? 'Pi Studio 内置'
    : pluginOwnershipSourceLine(item) || item.installation?.publisher || item.manifest?.publisher || item.manifest?.author;
  const meta = [`v${item.version}`, !isBuiltin && extensionScopeLabel(item.scope)].filter(Boolean).join(' · ');
  const state = extensionStateLabel(item);
  const capabilities = extensionCapabilitySummary(item);
  return <article className="installed-extension-card" data-scope={item.scope} aria-label={item.name}>
    <button type="button" className="extension-card-open" aria-label={`打开 ${item.name} 设置`}
      aria-haspopup="dialog" onClick={() => onOpenDetail(item)}>
      <span className="extension-card-head">
        {!isBuiltin && <span className="extension-card-mark" aria-hidden="true"><ExtensionStatusIcon item={{
          ...(mark ?? { id: item.id, icon: 'layers', color: 'neutral' }), iconDataUrl: item.iconDataUrl,
        }} /></span>}
        <span className="extension-card-identity">
          <strong title={item.name}>{item.name}</strong>
          <small>{meta}</small>
        </span>
        <span className="extension-card-state" data-tone={item.enabled ? extensionStateTone(item) : 'off'}
          title={item.blockedReason || state}>{state}</span>
      </span>
      {item.manifest?.description && <span className="extension-card-description">{item.manifest.description}</span>}
      <span className="extension-card-footer">
        <span className="extension-card-source" title={source || undefined}>{source}</span>
        {capabilities && <span className="extension-card-capabilities">{capabilities}</span>}
      </span>
    </button>
  </article>;
}
