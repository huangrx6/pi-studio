import type { ExtensionHostItem, ExtensionSummarySlot, ExtensionUiItem, ExtensionUiSlot } from '../../types/extension-types';
import { QUOTA_EXTENSION_ID } from '../../types/provider-quota.ts';
import type { ExtensionPlacement } from '../../shared/preferences';
import type { StatusPanel } from '../../shared/extension-appearance';

export const KEEP_AWAKE_EXTENSION_ID = 'builtin:studio-keep-awake';

const summaryPositions = {
  'status.chip': 'statusbar',
  'composer.above': 'above',
  'composer.below': 'below',
} as const satisfies Record<ExtensionSummarySlot, ExtensionPlacement>;

export type ConfigurablePanel = StatusPanel & {
  title: string;
  slots: ExtensionSummarySlot[];
};

const placementOptions: Array<{ value: ExtensionPlacement; label: string }> = [
  { value: 'above', label: '输入框上方' },
  { value: 'below', label: '输入框下方' },
  { value: 'statusbar', label: '底部状态栏' },
  { value: 'hidden', label: '隐藏摘要' },
];

export function isSummarySlot(slot: ExtensionUiSlot): slot is ExtensionSummarySlot {
  return Object.hasOwn(summaryPositions, slot);
}

export function placementOptionsFor(slots: readonly ExtensionUiSlot[]) {
  const positions = new Set<ExtensionPlacement>(['hidden']);
  for (const slot of slots) {
    if (isSummarySlot(slot)) positions.add(summaryPositions[slot]);
  }
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
    if (!slots.length && panel.slot !== 'tool.view' && panel.slot !== 'status.detail') return [];
    return [{
      id: panelContributionId(item.scope, manifest.id, panel.id),
      title: panel.title,
      slot: panel.slot,
      slots,
      icon: panel.icon,
      color: panel.color,
      ...(panel.slot === 'tool.view' && item.iconDataUrl ? { iconDataUrl: item.iconDataUrl } : {}),
    }];
  });
}

export function placementFor(
  placements: Readonly<Record<string, ExtensionPlacement>> | undefined,
  id: string,
  slots: readonly ExtensionUiSlot[],
): ExtensionPlacement {
  const stored = placements?.[id];
  const options = placementOptionsFor(slots);
  if (stored && options.some(option => option.value === stored)) return stored;
  if (slots.includes('status.chip')) {
    return 'statusbar';
  }
  return options[0].value;
}

export function placementForItem(
  placements: Readonly<Record<string, ExtensionPlacement>> | undefined,
  item: ExtensionUiItem,
): ExtensionPlacement {
  return placementFor(placements, item.id, item.slots ?? [item.slot]);
}

/** Resolve each contribution once for the selected conversation and its model source. */
export function conversationExtensionPositions(
  items: readonly ExtensionUiItem[],
  placements: Readonly<Record<string, ExtensionPlacement>>,
  sessionId: string | undefined,
  turnActive: boolean,
) {
  const inline: Record<'above' | 'below' | 'statusbar', ExtensionUiItem[]> = {
    above: [], below: [], statusbar: [],
  };
  for (const item of items) {
    if (!(item.slots ?? [item.slot]).some(isSummarySlot)) continue;
    if (!sessionId && item.extensionId !== QUOTA_EXTENSION_ID && item.extensionId !== KEEP_AWAKE_EXTENSION_ID) continue;
    if (item.visibility === 'while-active' && !turnActive) continue;
    const position = placementForItem(placements, item);
    if (position !== 'hidden') inline[position].push(item);
  }
  return {
    aboveItems: inline.above,
    belowItems: inline.below,
    statusBarItems: inline.statusbar,
    globalStatusBarItems: inline.statusbar.filter(item => item.extensionId === KEEP_AWAKE_EXTENSION_ID),
  };
}
