import { ChevronRight, Settings } from 'lucide-react';
import { ExtensionSlot } from './ExtensionSlot';
import { ExtensionStatusIcon } from './ExtensionStatusIcon';
import type { ExtensionSurfaceContext } from './ExtensionSummaries';
import type { WorkbenchExtension } from '../../shell/useConversationExtensions';
import { QUOTA_EXTENSION_ID } from '../../types/provider-quota';
import { ProviderQuotaSummary } from '../models/ProviderQuotaView';
import './styles/extension-picker.css';

export type ExtensionPanelPickerProps = ExtensionSurfaceContext & {
  groups: WorkbenchExtension[];
  quotaSource?: { id: string; name: string };
  onOpenPanel: (panelId: string) => void;
  onManage: () => void;
};

export function ExtensionPanelPicker({
  groups, quotaSource, onOpenPanel, onManage, surface, ...context
}: ExtensionPanelPickerProps) {
  return <div className="extension-panel-picker">
    {!groups.length && <p className="extension-picker-empty">当前工作区没有可打开的扩展面板。</p>}
    {groups.map(({ panels, summary }) => {
      const panel = panels.find(item => item.contributionId === summary?.details) ?? panels[0];
      const quota = summary && panel.extensionId === QUOTA_EXTENSION_ID ? quotaSource : undefined;
      return <article key={panel.extensionId} className="extension-picker-card" aria-label={panel.extensionName}>
        <header className="extension-picker-card-head">
          <span className="extension-picker-icon"><ExtensionStatusIcon item={summary ?? panel} /></span>
          <h3 title={panel.extensionName}>{panel.extensionName}</h3>
          <button type="button" className="extension-picker-details" aria-label={`查看 ${panel.extensionName} 详情`}
            onClick={() => onOpenPanel(panel.id)}>
            详情 <ChevronRight className="extension-picker-arrow" aria-hidden="true" />
          </button>
        </header>
        {quota ? <ProviderQuotaSummary key={quota.id} {...quota} />
          : summary?.content.length ? <ExtensionSlot {...context} snapshot={surface} slot={summary.slot} selectedItemId={summary.id} presentation="compact" />
            : panel.description && <p className="extension-picker-description" title={panel.description}>{panel.description}</p>}
      </article>;
    })}
    <footer className="extension-picker-footer">
      <button type="button" className="extension-picker-manage" onClick={onManage}>
        <span className="extension-picker-icon"><Settings aria-hidden="true" /></span>
        <span>管理扩展</span>
        <ChevronRight className="extension-picker-arrow" aria-hidden="true" />
      </button>
    </footer>
  </div>;
}
