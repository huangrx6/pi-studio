import { useMemo, useState, type ReactNode } from 'react';
import { ChevronLeft, ChevronRight, Search } from 'lucide-react';

export function GitDirectory({ path }: { path: string }) {
  const separator = path.includes('/') ? '/' : '\\';
  const parts = path.split(separator).filter(Boolean);
  const short = path.length > 56 && parts.length > 3 ? ['…', ...parts.slice(-2)].join(separator) : path;
  return <span className="git-path" title={path}><bdi dir="ltr">{short}</bdi></span>;
}

export function GitSettingsList<T>({ items, label, placeholder, searchText, pageSize, children }: {
  items: T[]; label: string; placeholder: string; searchText: (item: T) => string; pageSize: number;
  children: (item: T) => ReactNode;
}) {
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(0);
  const searchable = items.length > pageSize;
  const term = searchable ? query.trim().toLowerCase() : '';
  const matches = useMemo(() => term ? items.filter(item => searchText(item).toLowerCase().includes(term)) : items, [items, term, searchText]);
  const lastPage = Math.max(0, Math.ceil(matches.length / pageSize) - 1);
  const current = Math.min(page, lastPage);
  const start = current * pageSize;
  return <>
    {searchable && <label className="git-list-search">
      <Search aria-hidden="true" />
      <input type="search" aria-label={placeholder} placeholder={placeholder} value={query}
        onChange={e => { setQuery(e.target.value); setPage(0); }} />
    </label>}
    {matches.length > 0 ? <ul className="git-settings-list" aria-label={label}>
      {matches.slice(start, start + pageSize).map(children)}
    </ul> : <p className="git-list-note" role="status">{term ? '没有匹配的' + label : '没有' + label}</p>}
    {lastPage > 0 && <div className="git-list-pages">
      <span role="status">{start + 1}–{Math.min(start + pageSize, matches.length)} / {matches.length}</span>
      <button type="button" className="icon-button" aria-label={'上一页' + label} disabled={!current} onClick={() => setPage(current - 1)}><ChevronLeft /></button>
      <button type="button" className="icon-button" aria-label={'下一页' + label} disabled={current === lastPage} onClick={() => setPage(current + 1)}><ChevronRight /></button>
    </div>}
  </>;
}
