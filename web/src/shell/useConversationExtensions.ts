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
import type { NotificationTone } from './NotificationCenter';
import type { AgentView } from './app-types';
import { errorText } from '../shared/error-text';
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
};

export function useConversationExtensions({
  cwd,
  sessionId,
  agentView,
  setAgentView,
  pushNotification,
  rememberMainScrollPosition,
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
      surface.items.filter((item) => (
        item.slot === 'conversation.header'
        || item.slot === 'conversation.detail'
        || item.slot === 'conversation.footer'
      )),
      preferences,
      sessionId,
    ),
    [preferences, sessionId, surface],
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
  const headerItems = useMemo(
    () => items.filter((item) => item.slot === 'conversation.header'),
    [items],
  );
  const footerItems = useMemo(
    () => items.filter((item) => item.slot === 'conversation.footer'),
    [items],
  );
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
    headerItems: headerItems as ExtensionUiItem[],
    detailItems: detailItems as ExtensionUiItem[],
    footerItems: footerItems as ExtensionUiItem[],
    hubItems: hubItems as ExtensionUiItem[],
    activeItem,
    hasSessionOrder: hasSessionExtensionOrder(preferences, sessionId),
    updateUi,
    openItem,
    openHub,
  };
}
