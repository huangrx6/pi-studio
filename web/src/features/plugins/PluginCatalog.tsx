import { Check, Download, FileCode2, Folder, Layers3, PackageOpen, Plug, Search, Terminal } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Accordion } from '../../shared/Accordion';
import { LoadingState } from '../../shared/LoadingState';
import { PackageIcon } from '../../shared/PackageIcon';
import { Select } from '../../shared/Select';
import type { PluginMarketItem, PluginMarketSnapshot, StudioPluginSummary } from '../../types/global';
import { pluginResourceBadges, type PluginResourceBadge } from './PluginDetails';
import { matchesPluginQuery, pluginCatalogEntries, type PluginCatalogEntry } from './plugin-catalog';

const RESOURCE_ICON: Record<PluginResourceBadge['kind'], typeof Plug> = {
  mcp: Plug,
  skills: FileCode2,
  cli: Terminal,
  extension: Layers3,
};

type CardActions = {
  busy: boolean;
  catalogUnavailable: boolean;
  onOpen: (entry: PluginCatalogEntry) => void;
  onInstall: (item: PluginMarketItem, origin: HTMLButtonElement) => void;
  onToggle: (plugin: StudioPluginSummary) => void;
};

function PluginPackageCard({ entry, busy, catalogUnavailable, onOpen, onInstall, onToggle }: CardActions & { entry: PluginCatalogEntry }) {
  const { item, installed } = entry;
  const listing = 'sourceId' in item ? item : undefined;
  const version = installed?.version || listing?.latestVersion;
  const description = listing?.summary || item.description || installed?.description;
  const resources = pluginResourceBadges(item.provides);
  const source = listing?.sourceName || '本机';
  const SourceIcon = listing ? Layers3 : Folder;
  return <li className={`plugin-package-card${installed ? ' is-installed' : ''}`}>
    <div className="plugin-card-heading">
      <span className="plugin-package-icon"><PackageIcon source={item.iconDataUrl || installed?.iconDataUrl} name={item.name} /></span>
      <div className="plugin-card-identity">
        <h2><button type="button" className="plugin-card-open settings-row-link" aria-label={`查看插件 ${item.name}`}
          disabled={busy} onClick={() => onOpen(entry)}>{item.name}</button></h2>
        <p>{[item.publisher || installed?.publisher, version && `v${version}`].filter(Boolean).join(' · ')}</p>
      </div>
      {installed && <span className="plugin-installed-status"><Check aria-hidden="true" />已安装</span>}
    </div>
    {description && <p className="plugin-card-description">{description}</p>}
    {resources.length > 0 && <ul className="plugin-card-resources" aria-label="附带资源">
      {resources.map(({ kind, label }) => {
        const BadgeIcon = RESOURCE_ICON[kind];
        return <li key={label} data-kind={kind}><BadgeIcon aria-hidden="true" /><span>{label}</span></li>;
      })}
    </ul>}
    <div className="plugin-card-footer">
      <span className="plugin-card-source" title={source}><SourceIcon aria-hidden="true" /><span>{source}</span></span>
      <div className="plugin-card-actions">
        {listing && (!installed || installed.version !== listing.latestVersion) && <button type="button" className="settings-outline"
          disabled={busy || catalogUnavailable} aria-label={installed ? `更换 ${item.name} 的版本` : `安装 ${item.name}`}
          onClick={event => onInstall(listing, event.currentTarget)}><Download aria-hidden="true" />{installed ? '更换版本' : '安装'}</button>}
        {installed && <button type="button" role="switch" aria-checked={installed.enabled} aria-label={`启用插件 ${item.name}`}
          title={installed.enabled ? '停用插件' : '启用插件'} className={`switch${installed.enabled ? ' is-on' : ''}`}
          disabled={busy} onClick={() => onToggle(installed)}><span /></button>}
      </div>
    </div>
  </li>;
}

export function PluginCatalog({ plugins, catalog, loading, error, preparing, ...actions }: CardActions & {
  plugins: readonly StudioPluginSummary[];
  catalog?: PluginMarketSnapshot;
  loading: boolean;
  error: string;
  preparing: boolean;
}) {
  const [query, setQuery] = useState('');
  const [source, setSource] = useState('');
  const [category, setCategory] = useState('');
  const sources = catalog?.sources.filter(item => item.enabled) ?? [];
  const selectedSource = sources.some(item => item.id === source) ? source : '';
  const directory = selectedSource ? catalog?.catalogs.find(item => item.source.id === selectedSource) : undefined;
  const listings = selectedSource ? directory?.plugins : catalog?.plugins;
  const entries = useMemo(() => pluginCatalogEntries(listings ?? [], plugins, !selectedSource), [listings, plugins, selectedSource]);
  const categories = [...new Set(entries.map(({ item }) => item.category).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'zh-CN'));
  const selectedCategory = categories.includes(category) ? category : '';
  const normalizedQuery = query.trim().toLowerCase();
  const visible = entries.filter(entry => (!selectedCategory || entry.item.category === selectedCategory) && matchesPluginQuery(entry, normalizedQuery));
  const filtered = Boolean(normalizedQuery || selectedCategory || selectedSource);
  const sourceErrors = catalog?.errors ?? [];
  const unreadable = Boolean(directory?.error || (!selectedSource && sourceErrors.length && !listings?.length));

  return <section className="plugin-catalog" aria-label="插件目录">
    <div className="plugin-catalog-filters" role="group" aria-label="目录筛选">
      <label className="plugin-catalog-search">
        <Search aria-hidden="true" />
        <input type="search" aria-label="搜索插件" placeholder="搜索插件名称、发布者或资源…" value={query}
          onChange={event => setQuery(event.target.value)} />
      </label>
      {sources.length > 1 && <Select label="按来源筛选" value={selectedSource} options={[
        { value: '', label: '全部来源' }, ...sources.map(item => ({ value: item.id, label: item.name })),
      ]} onChange={value => { setSource(value); setCategory(''); }} />}
      {categories.length > 1 && <Select label="按分类筛选" value={selectedCategory} options={[
        { value: '', label: '全部分类' }, ...categories.map(value => ({ value, label: value })),
      ]} onChange={setCategory} />}
    </div>
    {error && <p className="settings-error" role="alert">插件目录读取失败：{error}</p>}
    {preparing && <p className="plugin-catalog-feedback" role="status">正在准备安装预览…</p>}
    {loading && !catalog && <LoadingState variant="section">正在读取插件目录…</LoadingState>}
    {visible.length > 0 ? <ul className="plugin-card-grid" aria-label="插件卡片">
      {visible.map(entry => <PluginPackageCard key={entry.item.id} entry={entry} {...actions} />)}
    </ul> : !loading && !error && <div className="plugin-catalog-empty" role="status">
      {filtered ? <Search aria-hidden="true" /> : <PackageOpen aria-hidden="true" />}
      <p>{unreadable ? '插件源暂时无法读取。' : filtered ? '没有匹配的插件。' : '暂无可用插件'}</p>
      {filtered ? <button type="button" className="settings-text-button"
        onClick={() => { setSource(''); setCategory(''); setQuery(''); }}>清除筛选</button>
        : <small>{unreadable ? '可在插件源中检查来源，或刷新目录重试。' : '可以添加插件源，或从本地安装插件。'}</small>}
    </div>}
    {sourceErrors.length > 0 && <Accordion className="plugin-catalog-errors" summary="查看来源读取错误" badge={sourceErrors.length}>
      <ul>{sourceErrors.map(item => <li key={item.sourceId}>
        <strong>{sources.find(source => source.id === item.sourceId)?.name || item.sourceId}</strong><span>{item.message}</span>
      </li>)}</ul>
    </Accordion>}
  </section>;
}
