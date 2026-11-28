import { ArrowUpRight, Download, PackageOpen, Search } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Accordion } from '../../shared/Accordion';
import { LoadingIndicator, LoadingState } from '../../shared/LoadingState';
import { PackageIcon } from '../../shared/PackageIcon';
import { Select } from '../../shared/Select';
import type { PluginMarketItem, PluginMarketSnapshot, StudioPluginSummary } from '../../types/global';
import { pluginResourceBadges } from './PluginDetails';
import { matchesPluginQuery, pluginCatalogEntries, type PluginCatalogEntry } from './plugin-catalog';

type InstallFilter = 'all' | 'installed' | 'available';

type CardActions = {
  busy: boolean;
  preparingId: string;
  catalogUnavailable: boolean;
  openablePanels?: ReadonlyMap<string, string>;
  onOpenApp?: (panelId: string) => void;
  onOpen: (entry: PluginCatalogEntry) => void;
  onInstall: (item: PluginMarketItem, origin: HTMLButtonElement) => void;
  onToggle: (plugin: StudioPluginSummary) => void;
};

function PluginPackageCard({
  entry,
  busy,
  preparingId,
  catalogUnavailable,
  openablePanels,
  onOpenApp,
  onOpen,
  onInstall,
  onToggle,
}: CardActions & { entry: PluginCatalogEntry }) {
  const { item, installed } = entry;
  const listing = 'sourceId' in item ? item : undefined;
  const preparing = preparingId === item.id;
  const version = installed?.version || listing?.latestVersion;
  const description = listing?.summary || item.description || installed?.description;
  const resources = pluginResourceBadges(item.provides);
  const resourceSummary = resources.map(badge => badge.label).join(' · ');
  const source = listing?.sourceName || item.publisher || installed?.publisher || '本机';
  const openPanelId = installed?.enabled ? openablePanels?.get(item.id) : undefined;
  const canUpdate = Boolean(listing && installed && installed.version !== listing.latestVersion);
  return <li className={`plugin-package-card${installed ? ' is-installed' : ''}${installed && !installed.enabled ? ' is-disabled' : ''}`}>
    <div className="plugin-card-top">
      <span className="plugin-package-icon"><PackageIcon source={item.iconDataUrl || installed?.iconDataUrl} name={item.name} /></span>
      <div className="plugin-card-top-actions">
        {installed ? (
          <button type="button" role="switch" aria-checked={installed.enabled} aria-label={`启用插件 ${item.name}`}
            title={installed.enabled ? '停用插件' : '启用插件'} className={`switch${installed.enabled ? ' is-on' : ''}`}
            disabled={busy} onClick={() => onToggle(installed)}><span /></button>
        ) : listing ? (
          <button type="button" className="settings-save"
            disabled={busy || catalogUnavailable} aria-busy={preparing || undefined}
            aria-label={`安装 ${item.name}`}
            onClick={event => onInstall(listing, event.currentTarget)}>
            {preparing ? <LoadingIndicator /> : <Download aria-hidden="true" />}
            安装
          </button>
        ) : null}
      </div>
    </div>
    <div className="plugin-card-body">
      <div className="plugin-card-title-row">
        <h2><button type="button" className="plugin-card-open settings-row-link" aria-label={`查看插件 ${item.name}`}
          disabled={busy} onClick={() => onOpen(entry)}>{item.name}</button></h2>
        {version && <small>v{version}</small>}
      </div>
      {description && <p className="plugin-card-description">{description}</p>}
    </div>
    <div className="plugin-card-footer">
      <span className="plugin-card-meta" title={resourceSummary || source}>{resourceSummary || source}</span>
      <div className="plugin-card-footer-end">
        {openPanelId && onOpenApp ? (
          <button type="button" className="settings-outline plugin-card-launch"
            disabled={busy}
            aria-label={`打开 ${item.name}`}
            onClick={() => onOpenApp(openPanelId)}>
            <ArrowUpRight aria-hidden="true" />打开
          </button>
        ) : canUpdate && listing ? (
          <button type="button" className="settings-outline"
            disabled={busy || catalogUnavailable} aria-busy={preparing || undefined}
            aria-label={`更换 ${item.name} 的版本`}
            onClick={event => onInstall(listing, event.currentTarget)}>
            {preparing ? <LoadingIndicator /> : <Download aria-hidden="true" />}
            更换版本
          </button>
        ) : (
          <span className="plugin-card-source" title={source}>{source}</span>
        )}
      </div>
    </div>
  </li>;
}

export function PluginCatalog({ plugins, catalog, loading, error, showStatusFilter = false, ...actions }: CardActions & {
  plugins: readonly StudioPluginSummary[];
  catalog?: PluginMarketSnapshot;
  loading: boolean;
  error: string;
  showStatusFilter?: boolean;
}) {
  const [query, setQuery] = useState('');
  const [source, setSource] = useState('');
  const [category, setCategory] = useState('');
  const [installFilter, setInstallFilter] = useState<InstallFilter>('all');
  const sources = catalog?.sources.filter(item => item.enabled) ?? [];
  const selectedSource = sources.some(item => item.id === source) ? source : '';
  const directory = selectedSource ? catalog?.catalogs.find(item => item.source.id === selectedSource) : undefined;
  const listings = selectedSource ? directory?.plugins : catalog?.plugins;
  const entries = useMemo(() => pluginCatalogEntries(listings ?? [], plugins, !selectedSource), [listings, plugins, selectedSource]);
  const installedCount = useMemo(() => entries.filter(entry => Boolean(entry.installed)).length, [entries]);
  const availableCount = entries.length - installedCount;
  const categories = [...new Set(entries.map(({ item }) => item.category).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'zh-CN'));
  const selectedCategory = categories.includes(category) ? category : '';
  const normalizedQuery = query.trim().toLowerCase();
  const visible = entries.filter(entry => {
    if (showStatusFilter && installFilter === 'installed' && !entry.installed) return false;
    if (showStatusFilter && installFilter === 'available' && entry.installed) return false;
    return (!selectedCategory || entry.item.category === selectedCategory) && matchesPluginQuery(entry, normalizedQuery);
  });
  const filtered = Boolean(normalizedQuery || selectedCategory || selectedSource || (showStatusFilter && installFilter !== 'all'));
  const sourceErrors = catalog?.errors ?? [];
  const unreadable = Boolean(directory?.error || (!selectedSource && sourceErrors.length && !listings?.length));

  return <section className="plugin-catalog" aria-label="插件目录">
    <div className="plugin-catalog-filters" role="group" aria-label="目录筛选">
      {showStatusFilter && (
        <div className="plugin-status-tabs" role="tablist" aria-label="安装状态筛选">
          {([
            ['all', `全部 ${entries.length}`],
            ['installed', `已安装 ${installedCount}`],
            ['available', `未安装 ${availableCount}`],
          ] as const).map(([key, label]) => (
            <button
              key={key}
              type="button"
              role="tab"
              aria-selected={installFilter === key}
              className={`plugin-status-tab${installFilter === key ? ' is-active' : ''}`}
              onClick={() => setInstallFilter(key)}
            >
              {label}
            </button>
          ))}
        </div>
      )}
      <label className="plugin-catalog-search">
        <Search aria-hidden="true" />
        <input type="search" aria-label="搜索插件" placeholder="搜索插件名称、发布者或能力…" value={query}
          onChange={event => setQuery(event.target.value)} />
      </label>
      {sources.length > 1 && <Select label="按来源筛选" value={selectedSource} options={[
        { value: '', label: '全部来源' }, ...sources.map(item => ({ value: item.id, label: item.name })),
      ]} onChange={value => { setSource(value); setCategory(''); }} />}
      {categories.length > 1 && <Select label="按分类筛选" value={selectedCategory} options={[
        { value: '', label: '全部分类' }, ...categories.map(value => ({ value, label: value })),
      ]} onChange={setCategory} />}
      {!showStatusFilter && entries.length > 0 && (
        <span className="plugin-catalog-count">
          {filtered ? `${visible.length} / ${entries.length}` : `${entries.length} 个插件`}
        </span>
      )}
    </div>
    {error && <p className="settings-error" role="alert">插件目录读取失败：{error}</p>}
    {loading && !catalog && <div className="settings-loading-card"><LoadingState variant="section">正在读取插件目录…</LoadingState></div>}
    {visible.length > 0 ? <ul className="plugin-card-grid" aria-label="插件卡片">
      {visible.map(entry => <PluginPackageCard key={entry.item.id} entry={entry} {...actions} />)}
    </ul> : !loading && !error && <div className="plugin-catalog-empty" role="status">
      {filtered ? <Search aria-hidden="true" /> : <PackageOpen aria-hidden="true" />}
      <p>{unreadable ? '插件源暂时无法读取。' : filtered ? '没有匹配的应用或插件。' : '暂无可用插件'}</p>
      {filtered ? <button type="button" className="settings-text-button"
        onClick={() => { setSource(''); setCategory(''); setQuery(''); setInstallFilter('all'); }}>清除筛选</button>
        : <small>{unreadable ? '可在插件源中检查来源，或刷新目录重试。' : '可以添加插件源，或从本地安装插件。'}</small>}
    </div>}
    {sourceErrors.length > 0 && <Accordion className="plugin-catalog-errors" summary="查看来源读取错误" badge={sourceErrors.length}>
      <ul>{sourceErrors.map(item => <li key={item.sourceId}>
        <strong>{sources.find(source => source.id === item.sourceId)?.name || item.sourceId}</strong><span>{item.message}</span>
      </li>)}</ul>
    </Accordion>}
  </section>;
}
