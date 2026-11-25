import type { ExtensionSettingsPage, ExtensionSummarySlot, ExtensionUiItem, ExtensionUiSnapshot } from '../../types/extension-types';
import { ExtensionSlot, type ExtensionNotice } from './ExtensionSlot';
import { ExtensionStatusIcon } from './ExtensionStatusIcon';

export type ExtensionSurfaceContext = {
  surface: ExtensionUiSnapshot;
  cwd?: string;
  sessionId?: string;
  modelRef?: string;
  onOpenSettings?: (page?: ExtensionSettingsPage) => void;
  onSendPrompt?: (text: string, submit: boolean) => void;
  onNotify?: (notice: ExtensionNotice) => void;
};

const labels = {
  'status.chip': '顶栏扩展状态',
  'composer.above': '输入框上方扩展状态',
  'composer.below': '输入框下方扩展状态',
};

export function ExtensionSummaries({
  items, slot, onOpenPanel, surface, ...context
}: ExtensionSurfaceContext & {
  items: ExtensionUiItem[];
  slot: ExtensionSummarySlot;
  onOpenPanel: (panelId: string) => void;
}) {
  if (!items.length) return null;
  return <div className={`extension-summaries is-${slot.replace('.', '-')}`} role="group" aria-label={labels[slot]}>
    {items.map(item => {
      const target = surface.items.find(panel => panel.slot === 'panel.side'
        && panel.extensionId === item.extensionId && panel.contributionId === item.details);
      const content = <>
        <ExtensionStatusIcon item={item} />
        <span className="extension-summary-content">
          {item.content.length > 0 ? <ExtensionSlot
            {...context} slot={slot} snapshot={surface} selectedItemId={item.id} presentation="compact"
          /> : item.title}
        </span>
      </>;
      return target
        ? <button key={item.id} type="button" className="extension-summary-item" title={item.title}
            aria-label={`打开 ${item.title} 详情`} onClick={() => onOpenPanel(target.id)}>{content}</button>
        : <div key={item.id} className="extension-summary-item" aria-label={item.title}>{content}</div>;
    })}
  </div>;
}
