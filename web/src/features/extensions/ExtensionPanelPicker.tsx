import { useMemo, useRef, useState } from 'react';
import { ChevronRight, Search, Settings, X } from 'lucide-react';
import { ExtensionSlot } from './ExtensionSlot';
import { ExtensionStatusIcon } from './ExtensionStatusIcon';
import type { ExtensionSurfaceContext } from './ExtensionSummaries';
import type { WorkbenchExtension } from '../../shell/useConversationExtensions';
import { QUOTA_EXTENSION_ID } from '../../types/provider-quota';
import { ProviderQuotaSummary } from '../models/ProviderQuotaView';
import {
  EXTENSION_PICKER_SEARCH_THRESHOLD,
  filterExtensionPickerEntries,
} from './extension-picker-model';
import './styles/extension-picker.css';

export type ExtensionPanelPickerProps = ExtensionSurfaceContext & {
  groups: WorkbenchExtension[];
  quotaSource?: { id: string; name: string };
  onOpenPanel: (panelId: string) => void;
  onManage: () => void;
};

export function ExtensionPanelPicker({
  groups, quotaSource, onOpenPanel, onManage, surface, ...context
}: ExtensionPanelPickerProps) {
  const [query, setQuery] = useState('');
  const searchRef = useRef<HTMLInputElement>(null);
  const searchable = groups.length >= EXTENSION_PICKER_SEARCH_THRESHOLD;
  const activeQuery = searchable ? query : '';
  const entries = useMemo(
    () => filterExtensionPickerEntries(groups, activeQuery, Boolean(quotaSource)),
    [groups, activeQuery, quotaSource],
  );
  const filtering = Boolean(activeQuery.trim());

  return <div className="extension-panel-picker">
    {searchable && <div className="extension-picker-search" role="search" aria-label="筛选扩展">
      <Search className="extension-picker-search-icon" aria-hidden="true" />
      <input
        ref={searchRef}
        type="search"
        aria-label="搜索扩展"
        placeholder={`搜索 ${groups.length} 个扩展…`}
        value={query}
        onChange={event => setQuery(event.target.value)}
        onKeyDown={event => {
          if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
          if (event.key === 'Escape' && query) {
            event.preventDefault();
            event.stopPropagation();
            setQuery('');
          } else if (event.key === 'Enter' && entries.length > 0) {
            event.preventDefault();
            onOpenPanel(entries[0].primaryPanel.id);
          }
        }}
      />
      {query && <button
        type="button"
        className="extension-picker-search-clear"
        aria-label="清除搜索"
        title="清除搜索"
        onClick={() => { setQuery(''); searchRef.current?.focus(); }}
      ><X aria-hidden="true" /></button>}
    </div>}

    <div className="extension-picker-scroll">
      {!groups.length && <p className="extension-picker-empty">当前工作区没有可打开的扩展面板。</p>}
      {groups.length > 0 && entries.length === 0 && <div className="extension-picker-empty-filter" role="status">
        <p className="extension-picker-empty">没有匹配的扩展。</p>
        <button
          type="button"
          className="extension-picker-clear-link"
          onClick={() => { setQuery(''); searchRef.current?.focus(); }}
        >清除筛选</button>
      </div>}

      {entries.map(({ group: { panels, summary }, primaryPanel: panel, extraPanels }) => {
        const quota = summary && panel.extensionId === QUOTA_EXTENSION_ID ? quotaSource : undefined;

        return <article key={panel.extensionId} className="extension-picker-card" aria-label={panel.extensionName}>
          <header className="extension-picker-card-head">
            <span className="extension-picker-icon"><ExtensionStatusIcon item={summary ?? panel} /></span>
            <h3 title={panel.extensionName}>{panel.extensionName}</h3>
            <button
              type="button"
              className="extension-picker-details"
              aria-label={`查看 ${panel.extensionName} 详情`}
              onClick={() => onOpenPanel(panel.id)}
            >
              详情 <ChevronRight className="extension-picker-arrow" aria-hidden="true" />
            </button>
          </header>
          {quota ? <div className="extension-picker-summary-body"><ProviderQuotaSummary key={quota.id} {...quota} /></div>
            : summary?.content.length ? <div className="extension-picker-summary-body"><ExtensionSlot {...context} snapshot={surface} slot={summary.slot} selectedItemId={summary.id} presentation="compact" /></div>
              : panel.description && <p className="extension-picker-description" title={panel.description}>{panel.description}</p>}
          {extraPanels.length > 0 && <div className="extension-picker-subpanels" role="group" aria-label={`${panel.extensionName} 面板`}>
            {panels.map(item => <button
              key={item.id}
              type="button"
              className="extension-picker-subpanel"
              title={item.description || item.title}
              onClick={() => onOpenPanel(item.id)}
            >{item.title}</button>)}
          </div>}
        </article>;
      })}
    </div>

    <footer className="extension-picker-footer">
      <button type="button" className="extension-picker-manage" onClick={onManage}>
        <span className="extension-picker-icon"><Settings aria-hidden="true" /></span>
        <span>管理扩展</span>
        {searchable && <span className="extension-picker-count" aria-live="polite">
          {filtering ? `${entries.length}/${groups.length}` : groups.length}
        </span>}
        <ChevronRight className="extension-picker-arrow" aria-hidden="true" />
      </button>
    </footer>
  </div>;
}
