import type { ExtensionHostItem, ExtensionSummarySlot, ExtensionUiItem, ExtensionUiSlot } from '../../types/extension-types';
import { QUOTA_EXTENSION_ID } from '../../types/provider-quota.ts';
import type { ExtensionPlacement } from '../../shared/preferences';
import type { StatusPanel } from '../../shared/extension-appearance';

const summaryPositions = {
  'status.chip': 'header',
  'composer.above': 'above',
  'composer.below': 'below',
} as const satisfies Record<ExtensionSummarySlot, ExtensionPlacement>;

export type ConfigurablePanel = StatusPanel & {
  title: string;
  slots: ExtensionSummarySlot[];
};

const placementOptions: Array<{ value: ExtensionPlacement; label: string }> = [
  { value: 'header', label: '顶栏' },
  { value: 'above', label: '输入框上方' },
  { value: 'below', label: '输入框下方' },
  { value: 'menu', label: '扩展菜单' },
  { value: 'hidden', label: '隐藏摘要' },
];

export function isSummarySlot(slot: ExtensionUiSlot): slot is ExtensionSummarySlot {
  return Object.hasOwn(summaryPositions, slot);
}

export function placementOptionsFor(slots: readonly ExtensionUiSlot[], extensionId?: string) {
  const positions = new Set<ExtensionPlacement>(['hidden']);
  for (const slot of slots) {
    if (isSummarySlot(slot) && extensionId !== QUOTA_EXTENSION_ID) positions.add(summaryPositions[slot]);
  }
  if (slots.includes('status.chip')) positions.add('menu');
  return placementOptions.filter(option => positions.has(option.value));
}

export function panelContributionId(scope: string, extensionId: string, panelId: string): string {
  return `${scope}:${extensionId}/${panelId}`;
}

export function configurablePanels(item: ExtensionHostItem): ConfigurablePanel[] {
  const manifest = item.manifest;
  if (!manifest) return [];
  return (manifest.contributes?.panels ?? []).flatMap(panel => {
    const slots = (panel.slots ?? [panel.slot]).filter(isSummarySlot);
    if (!slots.length && panel.slot !== 'panel.side') return [];
    return [{
      id: panelContributionId(item.scope, manifest.id, panel.id),
      title: panel.title,
      slot: panel.slot,
      slots,
      icon: panel.icon,
      color: panel.color,
      ...(panel.slot === 'panel.side' && item.iconDataUrl ? { iconDataUrl: item.iconDataUrl } : {}),
    }];
  });
}

export function placementFor(
  placements: Readonly<Record<string, ExtensionPlacement>> | undefined,
  id: string,
  slots: readonly ExtensionUiSlot[],
  extensionId: string,
): ExtensionPlacement {
  const stored = placements?.[id];
  const options = placementOptionsFor(slots, extensionId);
  if (stored && options.some(option => option.value === stored)) return stored;
  if (slots.includes('status.chip')) return 'menu';
  return options[0].value;
}

export function placementForItem(
  placements: Readonly<Record<string, ExtensionPlacement>> | undefined,
  item: ExtensionUiItem,
): ExtensionPlacement {
  return placementFor(placements, item.id, item.slots ?? [item.slot], item.extensionId);
}
