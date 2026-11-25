import { useEffect, useMemo, useRef, useState } from 'react';
import { useExtensionUiSnapshot } from '../features/extensions/use-extension-ui';
import { orderConversationExtensionItems } from '../features/conversation/conversation-extension-order';
import { isSummarySlot, placementForItem } from '../features/extensions/extension-placement';
import { QUOTA_EXTENSION_ID } from '../types/provider-quota';
import type { ExtensionPlacement } from '../shared/preferences';
import type { ExtensionUiItem } from '../types/extension-types';

export type WorkbenchExtension = {
  panels: ExtensionUiItem[];
  summary?: ExtensionUiItem;
};

export function useConversationExtensions({
  cwd,
  sessionId,
  sourceQuotaEnabled,
  turnActive,
  extensionPlacements,
}: {
  cwd?: string;
  sessionId?: string;
  sourceQuotaEnabled: boolean;
  turnActive: boolean;
  extensionPlacements: Record<string, ExtensionPlacement>;
}) {
  const discovered = useExtensionUiSnapshot(cwd);
  const [order, setOrder] = useState<string[] | null>();
  const [orderAttempt, setOrderAttempt] = useState(0);
  const [savingOrder, setSavingOrder] = useState(false);
  const saveInProgress = useRef(false);

  useEffect(() => {
    let disposed = false;
    void window.piApi.conversationExtensionUiPreferences()
      .then(saved => { if (!disposed) setOrder(saved.globalOrder); })
      .catch(() => { if (!disposed) setOrder(null); });
    return () => { disposed = true; };
  }, [orderAttempt]);

  const orderedItems = useMemo(
    () => orderConversationExtensionItems(discovered.items, order ?? []),
    [discovered, order],
  );
  const surface = useMemo(() => ({
    ...discovered,
    items: orderedItems.filter(item => item.extensionId !== QUOTA_EXTENSION_ID || sourceQuotaEnabled),
  }), [discovered, orderedItems, sourceQuotaEnabled]);
  const orderableItems = useMemo(() => {
    const byExtension = new Map<string, ExtensionUiItem>();
    for (const item of orderedItems) {
      if (item.slot !== 'settings.panel' && !byExtension.has(item.extensionId)) byExtension.set(item.extensionId, item);
    }
    return [...byExtension.values()];
  }, [orderedItems]);

  const panels = surface.items.filter(item => item.slot === 'panel.side');
  const summaries = sessionId ? surface.items.filter(item =>
    (item.slots ?? [item.slot]).some(isSummarySlot)
  ) : [];
  const placed = summaries.map(item => ({
    item,
    placement: placementForItem(extensionPlacements, item),
    showInline: item.visibility !== 'while-active' || turnActive,
  }));
  const grouped = new Map<string, WorkbenchExtension>();
  for (const panel of panels) {
    const group = grouped.get(panel.extensionId);
    if (group) group.panels.push(panel);
    else grouped.set(panel.extensionId, { panels: [panel] });
  }
  for (const { item, placement, showInline } of placed) {
    if (placement === 'hidden') continue;
    // The metrics data source also exposes the latest completed request in the picker.
    if (!showInline && item.extensionId !== 'builtin:studio-metrics') continue;
    const group = grouped.get(item.extensionId);
    if (group && !group.summary) group.summary = item;
  }
  const groups = [...grouped.values()];

  async function saveOrder(globalOrder: string[]) {
    if (saveInProgress.current) return;
    saveInProgress.current = true;
    setSavingOrder(true);
    try {
      const saved = await window.piApi.saveConversationExtensionUiPreferences({ globalOrder });
      setOrder(saved.globalOrder);
    } finally {
      saveInProgress.current = false;
      setSavingOrder(false);
    }
  }

  const inPosition = (placement: ExtensionPlacement) => placed
    .filter(entry => entry.showInline && entry.placement === placement).map(entry => entry.item);
  return {
    surface,
    panels,
    groups,
    headerItems: inPosition('header').slice(0, 2),
    aboveItems: inPosition('above'),
    belowItems: inPosition('below'),
    order,
    orderableItems,
    saveOrder,
    savingOrder,
    retryOrder: () => {
      setOrder(undefined);
      setOrderAttempt(attempt => attempt + 1);
    },
  };
}
