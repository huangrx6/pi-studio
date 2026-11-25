/**
 * Shared ownership labels for MCP / Skill / Extension rows that came from a plugin package.
 */

export type ResourceOwnershipFields = {
  ownerPluginId?: string;
  origin?: string;
  managed?: boolean;
  userOverride?: boolean;
};

/** Prefer the last dotted segment so long ids stay scannable in dense lists. */
export function pluginOwnershipLabel(ownerPluginId: string | undefined | null): string {
  const id = typeof ownerPluginId === 'string' ? ownerPluginId.trim() : '';
  if (!id) return '插件';
  const tail = id.includes('.') ? id.split('.').filter(Boolean).at(-1) : id;
  return tail || id;
}

export function isPluginOwnedResource(item: ResourceOwnershipFields | null | undefined): boolean {
  if (!item) return false;
  const origin = typeof item.origin === 'string' ? item.origin.trim() : '';
  const ownerPluginId = typeof item.ownerPluginId === 'string' ? item.ownerPluginId.trim() : '';
  return origin === 'plugin' && Boolean(ownerPluginId);
}

/** Short badge for list rows, e.g.「插件托管 · toolkit-starter」. */
export function pluginOwnershipBadge(item: ResourceOwnershipFields | null | undefined): string {
  if (!isPluginOwnedResource(item)) return '';
  const label = pluginOwnershipLabel(item?.ownerPluginId);
  const managed = item?.managed ? '插件托管' : '插件附带';
  const override = item?.userOverride ? ' · 已改配置' : '';
  return `${managed} · ${label}${override}`;
}

export function pluginOwnershipSourceLine(item: ResourceOwnershipFields | null | undefined): string {
  if (!isPluginOwnedResource(item)) return '';
  return `来自插件 · ${pluginOwnershipLabel(item?.ownerPluginId)}`;
}
