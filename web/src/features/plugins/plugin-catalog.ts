import type { PluginMarketItem, StudioPluginSummary } from '../../types/global';

export type PluginCatalogEntry = {
  item: PluginMarketItem | StudioPluginSummary;
  installed?: StudioPluginSummary;
};

/** A source filter selects that source's version. The full directory also includes local-only installs. */
export function pluginCatalogEntries(listings: readonly PluginMarketItem[], installed: readonly StudioPluginSummary[], includeLocal: boolean) {
  const installs = new Map(installed.map(plugin => [plugin.id, plugin]));
  const byId = new Map<string, PluginCatalogEntry>();
  for (const item of listings) {
    if (!byId.has(item.id)) byId.set(item.id, { item, installed: installs.get(item.id) });
  }
  if (includeLocal) {
    for (const item of installed) {
      if (!byId.has(item.id)) byId.set(item.id, { item, installed: item });
    }
  }
  return [...byId.values()].sort((a, b) => a.item.name.localeCompare(b.item.name, 'zh-CN') || a.item.id.localeCompare(b.item.id));
}

export function matchesPluginQuery({ item, installed }: PluginCatalogEntry, query: string) {
  if (!query) return true;
  const listing = 'sourceId' in item ? item : undefined;
  return [
    item.id, item.name, item.publisher, item.description, item.category,
    listing?.summary, listing?.sourceName, ...(listing?.keywords ?? []),
    ...(listing?.provides.mcpNames ?? []), ...(listing?.provides.skillNames ?? []), ...(listing?.provides.cliNames ?? []),
    installed?.name, installed?.publisher, installed?.description, installed?.category,
    ...(installed?.provides.mcp ?? []).map(server => server.name),
    ...(installed?.provides.skills ?? []).flatMap(skill => [skill.name, skill.path]),
    ...(installed?.provides.cli ?? []).flatMap(cli => [cli.id, cli.name]),
    ...(installed?.provides.extension?.tools ?? []),
  ].join('\n').toLowerCase().includes(query);
}
