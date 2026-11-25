import {
  isPluginOwnedResource,
  pluginOwnershipLabel,
  type ResourceOwnershipFields,
} from '../../shared/plugin-ownership.ts';

export type McpOwnershipOrigin = 'plugin' | 'user' | 'builtin';

export type McpOwnershipFields = ResourceOwnershipFields & {
  origin?: McpOwnershipOrigin | string;
};

export type McpOwnershipGroup<T> = {
  /** Empty string means user-added / non-plugin. */
  ownerPluginId: string;
  label: string;
  servers: T[];
};

/** Group MCP rows for settings: user-added first, then plugin buckets by ownerPluginId. */
export function groupMcpServersByOwnership<T extends McpOwnershipFields & { name: string }>(
  servers: readonly T[],
): McpOwnershipGroup<T>[] {
  const user: T[] = [];
  const plugins = new Map<string, T[]>();

  for (const server of servers) {
    const ownerPluginId = typeof server.ownerPluginId === 'string' ? server.ownerPluginId.trim() : '';
    if (isPluginOwnedResource(server) && ownerPluginId) {
      const list = plugins.get(ownerPluginId) || [];
      list.push(server);
      plugins.set(ownerPluginId, list);
      continue;
    }
    user.push(server);
  }

  const groups: McpOwnershipGroup<T>[] = [];
  if (user.length || servers.length === 0) {
    groups.push({
      ownerPluginId: '',
      label: '用户添加',
      servers: user,
    });
  }

  for (const ownerPluginId of [...plugins.keys()].sort((a, b) => a.localeCompare(b, 'zh-CN'))) {
    groups.push({
      ownerPluginId,
      label: `插件 · ${pluginOwnershipLabel(ownerPluginId)}`,
      servers: plugins.get(ownerPluginId) || [],
    });
  }

  return groups;
}
