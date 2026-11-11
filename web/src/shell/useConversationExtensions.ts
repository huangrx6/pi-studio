import { useEffect, useMemo, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import { useExtensionUiSnapshot } from '../features/extensions/use-extension-ui';
import {
  DEFAULT_CONVERSATION_EXTENSION_UI_PREFERENCES,
  applyConversationExtensionUiPatch,
  hasSessionExtensionOrder,
  normalizeConversationExtensionUiPreferences,
  orderConversationExtensionItems,
} from '../features/conversation/conversation-extension-order';
import { placementAllowsSlot, placementForItem } from '../features/extensions/extension-placement';
import type { NotificationTone } from './NotificationCenter';
import type { AgentView } from './app-types';
import { errorText } from '../shared/error-text';
import type { ExtensionPlacement } from '../shared/preferences';
import type {
  ConversationExtensionOrderScope,
  ConversationExtensionUiPreferences,
  ExtensionUiItem,
} from '../types/extension-types';

type ConversationExtensionsOptions = {
  cwd?: string;
  sessionId?: string;
  agentView: AgentView;
  setAgentView: Dispatch<SetStateAction<AgentView>>;
  pushNotification: (message: string, tone?: NotificationTone) => void;
  rememberMainScrollPosition: () => void;
  /** 设置在设置页的全局落点偏好：panel contribution id → 落点。 */
  extensionPlacements?: Record<string, ExtensionPlacement>;
};

export function useConversationExtensions({
  cwd,
  sessionId,
  agentView,
  setAgentView,
  pushNotification,
  rememberMainScrollPosition,
  extensionPlacements,
}: ConversationExtensionsOptions) {
  const surface = useExtensionUiSnapshot(cwd);
  const [preferences, setPreferences] = useState<ConversationExtensionUiPreferences>(
    () => ({
      ...DEFAULT_CONVERSATION_EXTENSION_UI_PREFERENCES,
      sessionOrders: {},
    }),
  );
  const [orderScope, setOrderScope] = useState<ConversationExtensionOrderScope>('global');

  useEffect(() => {
    let disposed = false;
    if (!window.piApi.conversationExtensionUiPreferences) return;
    void window.piApi.conversationExtensionUiPreferences()
      .then((saved) => {
        if (!disposed) {
          setPreferences(normalizeConversationExtensionUiPreferences(saved));
        }
      })
      .catch(() => {
        // Extension presentation remains usable with declaration order defaults.
      });
    return () => {
      disposed = true;
    };
  }, []);

  useEffect(() => {
    setOrderScope('global');
  }, [sessionId]);

  const items = useMemo(
    () => orderConversationExtensionItems(
      surface.items.filter((item) => {
        if (item.slot === 'conversation.detail') return true;
        // 用户在设置里选的落点优先：隐藏、只在顶栏、只在输入框下，缺省按声明全部渲染。
        const placement = placementForItem(extensionPlacements, item);
        return (item.slots ?? [item.slot]).some((slot) => (
          (slot === 'status.chip' || slot === 'conversation.footer')
          && placementAllowsSlot(placement, slot)
        ));
      }),
      preferences,
      sessionId,
    ),
    [extensionPlacements, preferences, sessionId, surface],
  );
  const manifestDetailItems = useMemo(
    () => surface.items.filter((item) => item.slot === 'conversation.detail'),
    [surface],
  );
  const hubItems = useMemo(
    () => orderConversationExtensionItems(
      manifestDetailItems,
      preferences,
      orderScope === 'session' ? sessionId : undefined,
    ),
    [manifestDetailItems, orderScope, preferences, sessionId],
  );
  const detailItems = useMemo(
    () => items.filter((item) => item.slot === 'conversation.detail'),
    [items],
  );
  const footerItems = useMemo(
    () => items.filter((item) => (item.slots ?? [item.slot]).includes('conversation.footer')),
    [items],
  );
  // 顶栏 chip：details 指向本扩展的详情面板，点击时直接打开那一页。
  const chipItems = useMemo(() => items
    .filter((item) => (item.slots ?? [item.slot]).includes('status.chip'))
    // 与底部那条同样的兜底：落点设为「输入框」或「隐藏」时，顶栏不能再出现。
    .filter((item) => placementAllowsSlot(placementForItem(extensionPlacements, item), 'status.chip'))
    .map((item) => {
      const target = item.details
        ? manifestDetailItems.find((detail) => detail.extensionId === item.extensionId && detail.contributionId === item.details)
        : undefined;
      return { item, targetId: target?.id };
    })
    .filter((chip) => Boolean(chip.targetId))
    .slice(0, 3), [items, manifestDetailItems, extensionPlacements]);
  const activeItem = agentView.kind === 'extensions' && agentView.itemId
    ? detailItems.find((item) => item.id === agentView.itemId) ?? null
    : null;

  useEffect(() => {
    if (agentView.kind !== 'extensions' || !agentView.itemId) return;
    if (detailItems.some((item) => item.id === agentView.itemId)) return;
    setAgentView({ kind: 'extensions' });
  }, [agentView, detailItems, setAgentView]);

  async function updateUi(
    patch: Parameters<typeof applyConversationExtensionUiPatch>[1],
  ): Promise<boolean> {
    const previous = preferences;
    setPreferences((current) => applyConversationExtensionUiPatch(current, patch));
    try {
      const saved = await window.piApi.saveConversationExtensionUiPreferences(patch);
      setPreferences(normalizeConversationExtensionUiPreferences(saved));
      return true;
    } catch (error) {
      try {
        setPreferences(normalizeConversationExtensionUiPreferences(
          await window.piApi.conversationExtensionUiPreferences(),
        ));
      } catch {
        setPreferences(previous);
      }
      pushNotification(`扩展展示设置保存失败：${errorText(error)}`, 'error');
      return false;
    }
  }

  function openItem(itemId: string) {
    if (!detailItems.some((item) => item.id === itemId)) {
      pushNotification('这个扩展面板当前不可用。', 'warning');
      return;
    }
    rememberMainScrollPosition();
    setAgentView({ kind: 'extensions', itemId });
  }

  function openChip(chip: { item: ExtensionUiItem; targetId: string }) {
    openItem(chip.targetId);
  }

  function openHub() {
    if (detailItems.length === 0) return;
    rememberMainScrollPosition();
    setAgentView({ kind: 'extensions' });
  }

  return {
    surface,
    preferences,
    orderScope,
    setOrderScope,
    items: items as ExtensionUiItem[],
    detailItems: detailItems as ExtensionUiItem[],
    footerItems: footerItems as ExtensionUiItem[],
    chipItems: chipItems as Array<{ item: ExtensionUiItem; targetId: string }>,
    hubItems: hubItems as ExtensionUiItem[],
    activeItem,
    hasSessionOrder: hasSessionExtensionOrder(preferences, sessionId),
    updateUi,
    openItem,
    openChip,
    openHub,
  };
}
