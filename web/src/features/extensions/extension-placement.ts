/**
 * 扩展落点的用户偏好。
 *
 * 扩展在 manifest 里声明自己能落在哪些位置（`slot` 或 `slots`），用户只决定
 * 最终出现在哪一处：两处、只在顶栏、只在输入框下、隐藏。偏好按 panel 的
 * contribution id 保存，作用域是全局的——同一扩展的所有会话表现一致。
 */
import type { ExtensionHostItem } from '../../types/extension-types';
import type { ExtensionPlacement } from '../../shared/preferences';

export type PlaceablePanel = {
  /** panel 的 contribution id，与运行时 UI 快照里的 item.id 一致。 */
  id: string;
  /** 该 panel 声明的落点，只保留可配置的 chip / footer。 */
  slots: Array<'status.chip' | 'conversation.footer'>;
};

export const EXTENSION_PLACEMENT_OPTIONS: Array<{ value: ExtensionPlacement; label: string; hint: string }> = [
  { value: 'both', label: '两处', hint: '顶栏与输入框下都显示' },
  { value: 'chip', label: '顶栏', hint: '只在顶栏显示图标入口' },
  { value: 'footer', label: '输入框', hint: '只在输入框下方显示一行状态' },
  { value: 'hidden', label: '隐藏', hint: '保留扩展，但不在会话里显示' },
];

const CONFIGURABLE_SLOTS = ['status.chip', 'conversation.footer'] as const;

/** contribution id 与主进程 `contributionId()` 的拼法保持一致。 */
export function panelContributionId(scope: string, manifestId: string, panelId: string): string {
  return `${scope}:${manifestId}/${panelId}`;
}

/**
 * 该扩展里声明了**至少两个**可配置落点的 panel。
 *
 * 只声明一处时「两处 / 只在顶栏 / 只在输入框下」三种取值等价，选择器没有意义；
 * 想彻底关掉这个入口，用扩展本身的启停。
 */
export function placeablePanels(item: ExtensionHostItem): PlaceablePanel[] {
  const manifestId = item.manifest?.id || item.id;
  return (item.manifest?.contributes?.panels || []).flatMap((panel) => {
    const declared = Array.isArray(panel.slots) && panel.slots.length > 0 ? panel.slots : [panel.slot];
    const slots = CONFIGURABLE_SLOTS.filter((slot) => declared.includes(slot));
    if (slots.length < 2) return [];
    return [{ id: panelContributionId(item.scope, manifestId, panel.id), slots }];
  });
}

/** 缺省（没有记录、或记录为 both）按扩展声明的全部落点渲染。 */
export function placementFor(
  placements: Record<string, ExtensionPlacement> | undefined,
  contributionId: string,
): ExtensionPlacement {
  const value = placements?.[contributionId];
  return value === 'chip' || value === 'footer' || value === 'hidden' ? value : 'both';
}

/** 某个落点是否应该渲染。 */
export function placementAllowsSlot(
  placement: ExtensionPlacement,
  slot: 'status.chip' | 'conversation.footer',
): boolean {
  if (placement === 'hidden') return false;
  if (placement === 'chip') return slot === 'status.chip';
  if (placement === 'footer') return slot === 'conversation.footer';
  return true;
}
