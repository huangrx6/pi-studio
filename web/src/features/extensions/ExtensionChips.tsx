/**
 * 顶栏状态 chip。
 *
 * 扩展用 `status.chip` 声明一个图标入口：图标旁最多带一段单行摘要，
 * 悬停或键盘聚焦时展开同一份 compact 内容，点击打开它自己的
 * `conversation.detail` 面板。host 不解释内容，只负责布局与路由。
 */
import { ExtensionStatusIcon } from './ExtensionStatusIcon';
import { ExtensionSlot } from './ExtensionSlot';
import type { ExtensionUiItem, ExtensionUiSnapshot } from '../../types/extension-types';

const MAX_CHIPS = 3;

export type ExtensionChipEntry = { item: ExtensionUiItem; targetId: string };

export function ExtensionChips({
  chips,
  surface,
  cwd,
  sessionId,
  modelRef,
  onOpenChip,
  onOpenSettings,
  onSendPrompt,
  onNotify,
}: {
  chips: ExtensionChipEntry[];
  surface: ExtensionUiSnapshot;
  cwd?: string;
  sessionId?: string;
  modelRef?: string;
  onOpenChip: (chip: ExtensionChipEntry) => void;
  onOpenSettings?: (page?: Parameters<NonNullable<React.ComponentProps<typeof ExtensionSlot>['onOpenSettings']>>[0]) => void;
  onSendPrompt?: (text: string, submit: boolean) => void;
  onNotify?: React.ComponentProps<typeof ExtensionSlot>['onNotify'];
}) {
  if (chips.length === 0) return null;
  return <div className="extension-chips">
    {chips.slice(0, MAX_CHIPS).map((chip) => {
      return <div className="extension-chip-anchor" key={chip.item.id}>
        <button
          type="button"
          className="icon-button extension-chip"
          aria-label={chip.item.title}
          title={chip.item.title}
          onClick={() => onOpenChip(chip)}
        >
          <ExtensionStatusIcon item={chip.item} />
        </button>
        {/* 悬停与键盘聚焦共用同一张浮层；内容由扩展自己声明。 */}
        <div className="extension-chip-popover" role="group" aria-label={chip.item.title}>
          <header className="extension-chip-popover-head">
            <ExtensionStatusIcon item={chip.item} />
            <strong>{chip.item.title}</strong>
          </header>
          <div className="extension-chip-popover-body">
            <ExtensionSlot
              slot="status.chip"
              presentation="compact"
              snapshot={surface}
              selectedItemId={chip.item.id}
              cwd={cwd}
              sessionId={sessionId}
              modelRef={modelRef}
              onOpenSettings={onOpenSettings}
              onSendPrompt={onSendPrompt}
              onNotify={onNotify}
            />
          </div>
          <button type="button" className="extension-chip-more" onClick={() => onOpenChip(chip)}>打开详情</button>
        </div>
      </div>;
    })}
  </div>;
}
