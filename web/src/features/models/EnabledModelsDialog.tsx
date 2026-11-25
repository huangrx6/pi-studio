import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Check, ChevronLeft, ChevronRight, Layers3, Search, X } from 'lucide-react';
import { DetailDialog } from '../../shared/DetailDialog';
import type { ModelOption } from '../../types/model-types';
import type { ModelSettingsActions } from './model-settings-types';
import { ModelCapabilities } from './ModelCapabilities';

export const ENABLED_MODELS_PAGE_SIZE = 24;
export function EnabledModelsDialog({ enabledModels, modelById, defaultId, view, busy, defaultBusy, actions, onClose }: {
  enabledModels: string[]; modelById: Map<string, ModelOption>; defaultId: string; view: 'all' | 'provider'; busy: boolean;
  defaultBusy: boolean; actions: ModelSettingsActions; onClose: () => void;
}) {
  const [query, setQuery] = useState('');
  const [requestedPage, setPage] = useState(0);
  const scroller = useRef<HTMLDivElement>(null);
  const needle = query.trim().toLocaleLowerCase();
  const matches = useMemo(() => {
    const list = enabledModels.map(id => {
      const model = modelById.get(id);
      return { id, model, name: model?.name || id, provider: model?.providerName || id.split('/')[0], providerId: model?.provider || id.split('/')[0] };
    }).filter(item => !needle || `${item.name} ${item.id} ${item.provider}`.toLocaleLowerCase().includes(needle));
    return list.sort((a, b) => (view === 'provider' ? a.provider.localeCompare(b.provider) || a.providerId.localeCompare(b.providerId) : 0) || a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  }, [enabledModels, modelById, needle, view]);
  const totalPages = Math.max(1, Math.ceil(matches.length / ENABLED_MODELS_PAGE_SIZE));
  const page = Math.min(requestedPage, totalPages - 1);
  const start = page * ENABLED_MODELS_PAGE_SIZE;
  const visible = matches.slice(start, start + ENABLED_MODELS_PAGE_SIZE);
  useLayoutEffect(() => { if (scroller.current) scroller.current.scrollTop = 0; }, [page, needle, view]);
  return <DetailDialog label="已启用模型" className={`enabled-models-dialog${enabledModels.length <= 6 ? ' is-compact' : ''}`} onClose={onClose}>{close => <>
    <header className="detail-header"><div className="detail-heading"><span className="detail-icon"><Layers3 /></span>
      <div><h2>已启用模型</h2><p>{enabledModels.length} 个模型</p></div>
    </div><button type="button" className="icon-button" aria-label="关闭已启用模型" onClick={close}><X /></button></header>
    <div className="enabled-models-toolbar">
      <label className="model-list-search"><Search aria-hidden="true" /><input autoFocus type="search" aria-label="搜索已启用模型" placeholder="搜索模型名称、ID 或来源…" value={query} onChange={e => { setQuery(e.target.value); setPage(0); }} /></label>
      <div className="settings-segments model-settings-view" role="group" aria-label="模型查看方式">
        {(['all', 'provider'] as const).map(mode => <button key={mode} type="button" aria-pressed={mode === view} onClick={() => { actions.onModelViewChange(mode); setPage(0); }}>{mode === 'all' ? '全部' : '按来源'}</button>)}
      </div>
    </div>
    <div className="enabled-models-results" ref={scroller}>
      {visible.map((item, i) => <div key={item.id}>
        {view === 'provider' && visible[i - 1]?.providerId !== item.providerId && <h3>{item.provider}</h3>}
        <div className="model-settings-enabled-row" data-enabled-model-id={item.id}>
          <div className="model-settings-enabled-identity"><strong>{item.name}</strong><code title={item.id}>{item.id}</code></div>
          {item.model && <ModelCapabilities item={item.model} />}
          <div className="enabled-models-actions">
            {item.id === defaultId ? <span className="enabled-model-default"><Check />默认</span>
              : <button type="button" className="settings-text-button" disabled={busy || defaultBusy} aria-label={`设 ${item.name} 为默认模型`} onClick={() => actions.onSelectDefaultModel(item.id)}>设为默认</button>}
            <button type="button" className="icon-button" disabled={busy} aria-label={`移除模型 ${item.name}`} title="从已启用模型中移除" onClick={() => actions.onSetEnabled(enabledModels.filter(id => id !== item.id))}><X /></button>
          </div>
        </div>
      </div>)}
      {!visible.length && <p className="model-directory-empty">{needle ? '没有匹配的模型。' : '还没有启用模型。'}</p>}
    </div>
    <footer className="model-directory-pages"><span role="status">{matches.length ? `${start + 1}–${start + visible.length} / ${matches.length} 个模型` : '0 个模型'}</span>
      {totalPages > 1 && <><button type="button" className="icon-button" aria-label="上一页模型" disabled={page === 0} onClick={() => setPage(page - 1)}><ChevronLeft /></button>
        <button type="button" className="icon-button" aria-label="下一页模型" disabled={page + 1 >= totalPages} onClick={() => setPage(page + 1)}><ChevronRight /></button></>}
    </footer>
  </>}</DetailDialog>;
}
