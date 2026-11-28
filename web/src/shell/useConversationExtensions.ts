import { useEffect, useMemo, useRef, useState } from 'react';
import { useExtensionUiSnapshot } from '../features/extensions/use-extension-ui';
import { orderConversationExtensionItems } from '../features/conversation/conversation-extension-order';
import { conversationExtensionPositions, isSummarySlot } from '../features/extensions/extension-placement';
import { QUOTA_EXTENSION_ID } from '../types/provider-quota';
import type { ExtensionPlacement } from '../shared/preferences';
import type { ExtensionUiItem } from '../types/extension-types';

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
  const { snapshot: discovered, ready } = useExtensionUiSnapshot(cwd);
  const [order, setOrder] = useState<string[] | null>();
  const [orderAttempt, setOrderAttempt] = useState(0);
  const [savingOrder, setSavingOrder] = useState(false);
  const saveInProgress = useRef(false);

  useEffect(() => {
    let disposed = false;
    void window.piApi.conversationExtensionUiPreferences()
      .then(saved => { if (!disposed) setOrder(saved?.globalOrder ?? null); })
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
      if (isSummarySlot(item.slot) && !byExtension.has(item.extensionId)) byExtension.set(item.extensionId, item);
    }
    return [...byExtension.values()];
  }, [orderedItems]);

  const panels = surface.items.filter(item => item.slot === 'tool.view' || item.slot === 'status.detail');
  const toolPanels = panels.filter(item => item.slot === 'tool.view');
  const statusPanels = panels.filter(item => item.slot === 'status.detail');
  const positions = useMemo(() => conversationExtensionPositions(
    surface.items, extensionPlacements, sessionId, turnActive,
  ), [surface.items, extensionPlacements, sessionId, turnActive]);

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

  return {
    ready: ready && order !== undefined,
    surface,
    panels,
    toolPanels,
    statusPanels,
    ...positions,
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
