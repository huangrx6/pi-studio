import { Accordion } from '../../shared/Accordion';
import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronRight, FileCode2, Folder, Globe2, Layers3, Search, X } from 'lucide-react';
import type { SkillCatalogItem } from '../../types/global.d';
import { DetailDialog } from '../../shared/DetailDialog';
import { SettingsResourceCard, SettingsResourceCardIcon, SettingsResourceCardMain } from '../../shared/SettingsResourceCard';
import { invocationLabel, sourceTypeLabel, type SkillSourceCatalog } from './skill-catalog';

const SKILL_PAGE_SIZE = 24;

function CatalogSkillCard({ item, showSource, onSelect }: {
  item: SkillCatalogItem;
  showSource: boolean;
  onSelect: (item: SkillCatalogItem) => void;
}) {
  return <SettingsResourceCard className="skill-hub-item">
    <SettingsResourceCardMain className="skill-hub-item-main" ariaLabel={`查看技能 ${item.name}`} onClick={() => onSelect(item)}>
      <span className="skill-hub-item-heading">
        <SettingsResourceCardIcon><FileCode2 /></SettingsResourceCardIcon>
        <span className="skill-hub-item-name">
          <strong title={item.name}>{item.name}</strong>
          {showSource && <small title={item.sourceName}>{item.sourceName}</small>}
        </span>
        {item.version && <small className="skill-hub-version" title={item.version}>v{item.version}</small>}
      </span>
      {item.description && <span className="skill-hub-item-description">{item.description}</span>}
      <span className="skill-hub-item-meta">
        <span>{invocationLabel(item.invocation)}</span>
        {item.resourceCount != null && <span>{item.resourceCount} 个资源</span>}
        <span>~{item.promptTokens} tokens/请求</span>
      </span>
      <span className="skill-hub-item-footer">
        <span className={`skill-hub-state ${item.updateAvailable ? 'is-update' : item.installed ? 'is-installed' : ''}`}>
          {item.updateAvailable ? '可更新' : item.installed ? '已安装' : '可安装'}
          {item.installed && item.installedVersion && ` · v${item.installedVersion}`}
        </span>
        <span className="skill-hub-preview-action">{item.updateAvailable ? '查看更新' : item.installed ? '查看详情' : '预览安装'}<ChevronRight aria-hidden="true" /></span>
      </span>
    </SettingsResourceCardMain>
  </SettingsResourceCard>;
}

export function SkillCatalogDialog({ catalog, catalogs, error, refreshing, onRefresh, onManage, onSelect, onClose }: {
  catalog?: SkillSourceCatalog;
  catalogs: SkillSourceCatalog[];
  error: string;
  refreshing: boolean;
  onRefresh: () => void;
  onManage: () => void;
  onSelect: (item: SkillCatalogItem) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState('');
  const [visibleCount, setVisibleCount] = useState(SKILL_PAGE_SIZE);
  const search = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const source = catalog?.source;
  const items = useMemo(() => catalog ? catalog.items : catalogs.flatMap(entry => entry.items), [catalog, catalogs]);
  const needle = query.trim().toLocaleLowerCase();
  const matches = useMemo(() => needle ? items.filter(item =>
    `${item.name} ${item.description} ${item.sourceName}`.toLocaleLowerCase().includes(needle)
  ) : items, [items, needle]);
  const installed = items.filter(item => item.installed).length;
  const Icon = !source ? Layers3 : source.type === 'directory' ? Folder : Globe2;
  const diagnostics = catalog?.diagnostics.filter(entry => entry.message !== source?.lastError) ?? [];

  useEffect(() => { search.current?.focus({ preventScroll: true }); }, []);

  function changeQuery(value: string) {
    setQuery(value);
    setVisibleCount(SKILL_PAGE_SIZE);
    if (list.current) list.current.scrollTop = 0;
  }

  function clearSearch() {
    changeQuery('');
    search.current?.focus();
  }

  return <DetailDialog className="skill-catalog-dialog" onClose={onClose}>
    <header className="detail-header">
      <div className="detail-heading">
        <span className="detail-icon is-skill"><Icon aria-hidden="true" /></span>
        <div className="skill-catalog-heading">
          <h2>{source?.name ?? '全部技能'}</h2>
          <p>{source ? sourceTypeLabel(source) : `${catalogs.length} 个技能源`} · {items.length} 个技能{installed > 0 && ` · ${installed} 个已安装`}</p>
        </div>
      </div>
      <button type="button" className="icon-button" aria-label="关闭技能目录" onClick={onClose}><X /></button>
    </header>
    <div className="skill-catalog-toolbar">
      <div className="skill-hub-search">
        <Search aria-hidden="true" />
        <input ref={search} aria-label="搜索技能" placeholder={source ? '搜索此源中的技能…' : '搜索全部技能源…'} value={query} onChange={event => changeQuery(event.target.value)} />
        {query && <button type="button" aria-label="清除技能搜索" onClick={clearSearch}><X /></button>}
      </div>
      {source && <code title={source.location}>{source.location}</code>}
      {needle && <span role="status">{matches.length} 个匹配</span>}
    </div>
    <div className="skill-catalog-results" ref={list}>
      {(error || source?.lastError) && <div className="skill-catalog-feedback" role="alert">
        <span>{error || source?.lastError}</span>
        <button type="button" className="settings-outline" onClick={onRefresh} disabled={refreshing}>重新读取</button>
      </div>}
      {diagnostics.length > 0 && <Accordion className="skill-hub-diagnostics" summary="目录提示" badge={diagnostics.length}>

        {diagnostics.map((entry, index) => <div key={`${entry.path}:${index}`}><code>{entry.path}</code><span>{entry.message}</span></div>)}
      </Accordion>}
      {source?.enabled === false ? <div className="skill-catalog-empty">
        <p>此技能源已停用。</p><button type="button" className="settings-outline" onClick={onManage}>管理源</button>
      </div> : matches.length > 0 ? <>
        <div className="skill-hub-grid">
          {matches.slice(0, visibleCount).map(item => <CatalogSkillCard key={item.id} item={item} showSource={!source} onSelect={onSelect} />)}
        </div>
        {matches.length > visibleCount && <button type="button" className="settings-outline skill-hub-more" onClick={() => setVisibleCount(count => count + SKILL_PAGE_SIZE)}>
          显示更多（还有 {matches.length - visibleCount} 个）
        </button>}
      </> : needle ? <div className="skill-catalog-empty">
        <p>没有匹配“{query.trim()}”的技能。</p><button type="button" className="settings-outline" onClick={clearSearch}>清除搜索</button>
      </div> : !(source?.lastError || error) && <div className="skill-catalog-empty"><p>{source ? '这个源还没有可浏览的技能。' : '当前没有可浏览的技能。'}</p></div>}
    </div>
  </DetailDialog>;
}
