import type { SkillCatalogItem, SkillHubSnapshot, SkillSource } from '../../types/global.d';

export type SkillSourceCatalog = SkillHubSnapshot['catalogs'][number] & { count: number };

export function skillSourceCatalogs(snapshot: SkillHubSnapshot | null): SkillSourceCatalog[] {
  if (!snapshot) return [];
  const catalogs = new Map(snapshot.catalogs.map(catalog => [catalog.source.id, catalog]));
  // A disabled or unreadable source still belongs in the overview.
  return snapshot.sources.map(source => {
    const catalog = catalogs.get(source.id);
    return { source, items: catalog?.items ?? [], diagnostics: catalog?.diagnostics ?? [], count: catalog?.items.length ?? source.itemCount };
  });
}

export function sourceTypeLabel(source: Pick<SkillSource, 'type'>) {
  return source.type === 'github' ? 'GitHub 仓库' : source.type === 'directory' ? '本地目录' : '技能目录（JSON）';
}

export function sourceStatusLabel(source: Pick<SkillSource, 'enabled' | 'lastError'>, count: number, refreshing: boolean) {
  if (!source.enabled) return '已停用';
  if (refreshing) return '正在读取…';
  if (source.lastError) return '读取失败';
  return `${count} 个技能`;
}

export function invocationLabel(value: SkillCatalogItem['invocation']) {
  return value === 'explicit' ? '仅 /skill 显式调用' : '模型可按描述发现';
}
