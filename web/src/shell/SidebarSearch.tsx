import { Search, X } from 'lucide-react';
import { Select } from '../shared/Select';
import type { SidebarSessionFilter } from './sidebar-filter';
import './sidebar-search.css';

export function SidebarSearch({ query, filter, onQueryChange, onFilterChange, onClose }: {
  query: string;
  filter: SidebarSessionFilter;
  onQueryChange: (value: string) => void;
  onFilterChange: (value: SidebarSessionFilter) => void;
  onClose: () => void;
}) {
  return <div className="sidebar-search-panel">
    <div className="workspace-search">
      <Search aria-hidden="true" />
      <input autoFocus type="search" aria-label="搜索工作区或会话" placeholder="搜索工作区或会话…" value={query}
        onChange={event => onQueryChange(event.target.value)}
        onKeyDown={event => {
          if (event.key !== 'Escape' || event.nativeEvent.isComposing) return;
          event.preventDefault();
          event.stopPropagation();
          if (query) onQueryChange('');
          else if (filter !== 'all') onFilterChange('all');
          else onClose();
        }} />
      {query && <button type="button" className="icon-button" aria-label="清除搜索" onClick={event => {
        onQueryChange('');
        event.currentTarget.parentElement?.querySelector('input')?.focus();
      }}><X /></button>}
    </div>
    <Select label="会话筛选" value={filter} onChange={value => onFilterChange(value as SidebarSessionFilter)} options={[
      { value: 'all', label: '全部会话' },
      { value: 'running', label: '运行中' },
      { value: 'pinned', label: '已置顶' },
    ]} />
  </div>;
}
