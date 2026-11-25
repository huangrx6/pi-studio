import type { ExtensionUiItem } from '../../types/extension-types';

/** Summaries and panels of one extension move together. */
export function orderConversationExtensionItems(items: ExtensionUiItem[], order: readonly string[]): ExtensionUiItem[] {
  const extensionIds = new Set([...order, ...items.map(item => item.extensionId)]);
  const rank = new Map([...extensionIds].map((id, index) => [id, index]));
  return [...items].sort((left, right) => (
    rank.get(left.extensionId)! - rank.get(right.extensionId)!
    || left.sourceOrder - right.sourceOrder
  ));
}

export function moveConversationExtension(
  order: readonly string[],
  visibleIds: string[],
  extensionId: string,
  offset: -1 | 1,
): string[] {
  const index = visibleIds.indexOf(extensionId);
  const neighbor = visibleIds[index + offset];
  if (index < 0 || !neighbor) return [...order];

  // Keep ranks for extensions from workspaces that are not currently open.
  const nextOrder = [...new Set([...order, ...visibleIds])];
  const from = nextOrder.indexOf(extensionId);
  const to = nextOrder.indexOf(neighbor);
  [nextOrder[from], nextOrder[to]] = [nextOrder[to], nextOrder[from]];
  return nextOrder;
}
