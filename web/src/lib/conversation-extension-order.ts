import type {
  ConversationExtensionLayout,
  ConversationExtensionUiPreferences,
  ExtensionUiItem,
} from '../types/extension-types';

export const DEFAULT_CONVERSATION_EXTENSION_UI_PREFERENCES: ConversationExtensionUiPreferences = {
  version: 1,
  layout: 'grid',
  globalOrder: [],
  sessionOrders: {},
};

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string')
    : [];
}

export function normalizeConversationExtensionUiPreferences(
  value: unknown,
): ConversationExtensionUiPreferences {
  if (!value || typeof value !== 'object') return DEFAULT_CONVERSATION_EXTENSION_UI_PREFERENCES;
  const candidate = value as Partial<ConversationExtensionUiPreferences>;
  const sessionOrders: Record<string, string[]> = {};
  if (candidate.sessionOrders && typeof candidate.sessionOrders === 'object') {
    for (const [sessionId, order] of Object.entries(candidate.sessionOrders)) {
      if (sessionId && Array.isArray(order)) sessionOrders[sessionId] = stringList(order);
    }
  }
  return {
    version: 1,
    layout: candidate.layout === 'list' ? 'list' : 'grid',
    globalOrder: stringList(candidate.globalOrder),
    sessionOrders,
  };
}

export type ConversationExtensionUiPatch = {
  layout?: ConversationExtensionLayout;
  globalOrder?: string[];
  sessionId?: string;
  sessionOrder?: string[] | null;
};

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

export function activeExtensionOrder(
  preferences: ConversationExtensionUiPreferences,
  sessionId?: string,
): string[] {
  if (sessionId && preferences.sessionOrders[sessionId]?.length) {
    return preferences.sessionOrders[sessionId];
  }
  return preferences.globalOrder;
}

export function hasSessionExtensionOrder(
  preferences: ConversationExtensionUiPreferences,
  sessionId?: string,
): boolean {
  return Boolean(sessionId && preferences.sessionOrders[sessionId]?.length);
}

/**
 * User order is grouped by extension, so a footer and its detail card always
 * move together. Manifest order remains the stable fallback within a group.
 */
export function orderConversationExtensionItems(
  items: ExtensionUiItem[],
  preferences: ConversationExtensionUiPreferences,
  sessionId?: string,
): ExtensionUiItem[] {
  const order = activeExtensionOrder(preferences, sessionId);
  const rank = new Map(order.map((extensionId, index) => [extensionId, index]));
  const sourceRank = new Map(items.map((item, index) => [item.id, index]));
  const firstExtensionRank = new Map<string, number>();
  for (const [index, item] of items.entries()) {
    if (!firstExtensionRank.has(item.extensionId)) {
      firstExtensionRank.set(item.extensionId, index);
    }
  }
  return [...items].sort((left, right) => {
    const leftRank = rank.get(left.extensionId);
    const rightRank = rank.get(right.extensionId);
    if (leftRank !== undefined || rightRank !== undefined) {
      if (leftRank === undefined) return 1;
      if (rightRank === undefined) return -1;
      if (leftRank !== rightRank) return leftRank - rightRank;
    }
    if (left.extensionId === right.extensionId && left.sourceOrder !== right.sourceOrder) {
      return left.sourceOrder - right.sourceOrder;
    }
    if (left.extensionId !== right.extensionId && order.length === 0) {
      return (firstExtensionRank.get(left.extensionId) || 0)
        - (firstExtensionRank.get(right.extensionId) || 0);
    }
    return (sourceRank.get(left.id) || 0) - (sourceRank.get(right.id) || 0);
  });
}

export function applyConversationExtensionUiPatch(
  preferences: ConversationExtensionUiPreferences,
  patch: ConversationExtensionUiPatch,
): ConversationExtensionUiPreferences {
  const next: ConversationExtensionUiPreferences = {
    ...preferences,
    sessionOrders: { ...preferences.sessionOrders },
  };
  if (patch.layout) next.layout = patch.layout;
  if (patch.globalOrder) next.globalOrder = uniqueStrings(patch.globalOrder);
  if (patch.sessionId && Object.hasOwn(patch, 'sessionOrder')) {
    if (patch.sessionOrder === null || patch.sessionOrder?.length === 0) {
      delete next.sessionOrders[patch.sessionId];
    } else if (patch.sessionOrder) {
      next.sessionOrders[patch.sessionId] = uniqueStrings(patch.sessionOrder);
    }
  }
  return next;
}
