import type { ExtensionSettingsPage, ExtensionSummarySlot, ExtensionUiItem, ExtensionUiSnapshot } from '../../types/extension-types';
import { ExtensionSlot, type ExtensionNotice } from './ExtensionSlot';
import { QUOTA_EXTENSION_ID } from '../../types/provider-quota';
import { ProviderQuotaInline } from '../models/ProviderQuotaView';
import { ExtensionStatusIcon } from './ExtensionStatusIcon';
import { KEEP_AWAKE_EXTENSION_ID } from './extension-placement';

export type ExtensionSurfaceContext = {
  surface: ExtensionUiSnapshot;
  cwd?: string;
  sessionId?: string;
  modelRef?: string;
  onOpenSettings?: (page?: ExtensionSettingsPage) => void;
  onSendPrompt?: (text: string, submit: boolean) => void;
  onNotify?: (notice: ExtensionNotice) => void;
};

export type ExtensionSummaryContext = ExtensionSurfaceContext & {
  quotaSource?: { id: string; name: string };
  onOpenPanel: (panelId: string) => void;
};

const labels = {
  'status.chip': '底部扩展状态',
  'composer.above': '输入框上方扩展状态',
  'composer.below': '输入框下方扩展状态',
};

export function ExtensionSummaries({
  items, slot, placement, quotaSource, onOpenPanel, openPanelId, surface, ...context
}: ExtensionSummaryContext & {
  items: ExtensionUiItem[];
  placement?: 'statusbar';
  slot: ExtensionSummarySlot;
  openPanelId?: string;
}) {
  if (!items.length) return null;
  return <div className={`extension-summaries is-${placement ?? slot.replace('.', '-')}`} role="group" aria-label={placement === 'statusbar' ? '底部扩展状态' : labels[slot]}>
    {items.map(item => {
      const global = item.extensionId === KEEP_AWAKE_EXTENSION_ID;
      const target = surface.items.find(panel => (panel.slot === 'status.detail' || panel.slot === 'tool.view')
        && panel.extensionId === item.extensionId && panel.contributionId === item.details);
      const opensPopover = target?.slot === 'status.detail';
      const content = <>
        <ExtensionStatusIcon item={item} />
        <span className="extension-summary-content">
          {item.extensionId === QUOTA_EXTENSION_ID && quotaSource ? <ProviderQuotaInline key={quotaSource.id} {...quotaSource} />
            : item.content.length > 0 ? <ExtensionSlot
            {...context} {...(global && { cwd: undefined, sessionId: undefined, modelRef: undefined })}
            slot={slot} snapshot={surface} selectedItemId={item.id} presentation="compact"
          /> : item.title}
        </span>
      </>;
      return target
        ? <button key={item.id} type="button" className="extension-summary-item" title={item.title}
            data-global-status={global || undefined} data-extension-detail={target.id} aria-haspopup={opensPopover ? 'dialog' : undefined}
            aria-expanded={opensPopover ? target.id === openPanelId : undefined}
            aria-label={`打开 ${item.title} 详情`} onClick={() => onOpenPanel(target.id)}>{content}</button>
        : <div key={item.id} className="extension-summary-item" aria-label={item.title}>{content}</div>;
    })}
  </div>;
}
