import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, ChevronLeft, ChevronRight, Cpu, Layers3, Pencil, Plus, Search, Trash2, X } from 'lucide-react';
import { LoadingIndicator, LoadingState } from '../../shared/LoadingState';
import { SettingsPageHeader } from '../../shared/SettingsPageHeader';
import { Select } from '../../shared/Select';
import { InfoHint } from '../../shared/InfoHint';
import { ENABLED_MODELS_PAGE_SIZE, EnabledModelsDialog } from './EnabledModelsDialog';
import { ModelCapabilities } from './ModelCapabilities';
import { ProviderIcon } from './ProviderIcon';
import { ProviderQuotaDialog } from './ProviderQuotaView';
import { thinkingLabels, type ThinkingLevel } from '../../types/model-types';
import { discoverySelection, MODEL_CATALOG_PAGE_SIZE, modelCatalogPage } from './model-settings-catalog.ts';
import type { ModelProvider, ModelSettingsActions, ModelSettingsProps, ProviderCatalogState, ProviderDiscoveryState, ProviderModelInfo } from './model-settings-types';
import './styles/model-settings.css';

export type { ModelSettingsActions, ModelSettingsProps } from './model-settings-types';

function ProviderDiscovery({ provider, catalog, discovery, busy, recoveryPending, actions }: { provider: ModelProvider; catalog: ProviderModelInfo[]; discovery: ProviderDiscoveryState; busy: boolean; recoveryPending: boolean; actions: ModelSettingsActions }) {
  const selectionDisabled = busy || recoveryPending || Boolean(discovery.importing);
  const selection = useMemo(() => discoverySelection(discovery.models || [], catalog, discovery.selected || []), [discovery.models, discovery.selected, catalog]);
  return <div className={`provider-discovery-panel ${discovery.error ? 'is-error' : ''}`}>
    <div className="provider-discovery-head">
      <div>{discovery.loading ? <LoadingState>正在读取模型列表…</LoadingState>
        : <strong role="status">{discovery.error ? '模型发现失败' : `发现 ${discovery.models?.length || 0} 个模型`}</strong>}
        {discovery.endpoint && <code title={discovery.endpoint}>{discovery.endpoint}</code>}
        {discovery.error && <p role="alert">{discovery.error}</p>}
        {!discovery.loading && !discovery.error && discovery.imported !== undefined && <p role="status">已添加并启用 {discovery.imported} 个模型。</p>}
      </div>
      <button type="button" className="icon-button" aria-label="关闭模型发现结果" title="关闭" disabled={discovery.importing} onClick={() => actions.onDismissDiscovery(provider.id)}><X /></button>
    </div>
    {!discovery.loading && !discovery.error && (discovery.models?.length ? <>
      <div className="provider-discovery-toolbar"><span>已选 {selection.selectedMissing.length} 个未添加模型</span><button type="button" className="settings-text-button" disabled={!selection.missing.length || selectionDisabled} onClick={() => actions.onDiscoverySelection(provider.id, selection.allMissingSelected ? [] : selection.missing.map((item) => item.id))}>{selection.allMissingSelected ? '清空选择' : '全选未添加'}</button></div>
      <div className="provider-discovery-list" role="group" aria-label={`${provider.name} 可添加模型`}>
        {(discovery.models || []).map((item) => {
          const added = selection.addedIds.has(item.id);
          const checked = added || selection.selectedIds.has(item.id);
          return <label className={`provider-discovery-option ${added ? 'is-added' : ''}`} key={item.id}>
            <input type="checkbox" checked={checked} disabled={added || selectionDisabled} aria-label={`${added ? '已添加模型' : '选择模型'} ${item.name}`} onChange={(event) => actions.onDiscoverySelection(provider.id, event.target.checked ? [...new Set([...(discovery.selected || []), item.id])] : (discovery.selected || []).filter((id) => id !== item.id))} />
            <span><strong>{item.name}</strong>{item.id !== item.name && <code>{item.id}</code>}</span>{added && <small>已添加</small>}
          </label>;
        })}
      </div>
      <div className="provider-discovery-footer"><span>{selection.missing.length ? `${selection.missing.length} 个模型尚未添加` : '接口返回的模型都已添加'}</span><button type="button" className="settings-save" disabled={!selection.selectedMissing.length || selectionDisabled} onClick={() => actions.onImportModels(provider.id, selection.selectedMissing)}>{discovery.importing && <LoadingIndicator />}{discovery.importing ? '正在添加…' : selection.selectedMissing.length ? `添加所选 ${selection.selectedMissing.length} 个` : '请选择模型'}</button></div>
    </> : <p className="model-settings-empty">接口返回了空列表。</p>)}
  </div>;
}

function ProviderCatalog({ provider, catalog, state, discovery, query, enabledModels, busy, recoveryPending, actions }: { provider: ModelProvider; catalog?: ProviderModelInfo[]; state?: ProviderCatalogState; discovery?: ProviderDiscoveryState; query: string; enabledModels: string[]; busy: boolean; recoveryPending: boolean; actions: ModelSettingsActions }) {
  const [pagination, setPagination] = useState({ query, limit: MODEL_CATALOG_PAGE_SIZE });
  const limit = pagination.query === query ? pagination.limit : MODEL_CATALOG_PAGE_SIZE;
  const page = useMemo(() => modelCatalogPage(catalog || [], query, limit), [catalog, query, limit]);
  const enabled = useMemo(() => new Set(enabledModels), [enabledModels]);
  const list = useRef<HTMLDivElement>(null);
  const focusNewItem = useRef<number | null>(null);
  useLayoutEffect(() => {
    if (focusNewItem.current === null) return;
    const node = list.current?.querySelectorAll<HTMLElement>('[data-model-id]')[focusNewItem.current];
    focusNewItem.current = null;
    node?.querySelector<HTMLInputElement>('input[type="checkbox"]')?.focus({ preventScroll: true });
    node?.scrollIntoView({ block: 'nearest', behavior: 'instant' });
  }, [page.items]);
  return <div className="provider-model-panel">
    <div className="provider-model-head"><h3>对话模型目录 <InfoHint label="获取模型使用配置的模型列表地址；留空时自动尝试来源的 /models 接口。" /></h3><div className="model-settings-actions">
      <button type="button" className="settings-outline" disabled={discovery?.loading || discovery?.importing || busy} onClick={() => actions.onDiscoverProvider(provider.id)}>{discovery?.loading && <LoadingIndicator />}获取模型</button>
      <button type="button" className="settings-add-button" disabled={busy} onClick={() => actions.onOpenModelEditor(provider.id)}>添加模型</button>
    </div></div>
    <div className="provider-model-search"><input className="model-search" aria-label={`搜索 ${provider.name} 的模型`} value={query} onChange={(event) => actions.onModelQueryChange(event.target.value)} placeholder="搜索名称或模型 ID…" /></div>
    {discovery && <ProviderDiscovery provider={provider} catalog={catalog || []} discovery={discovery} busy={busy} recoveryPending={recoveryPending} actions={actions} />}
    {(state?.loading || (catalog === undefined && !state?.error)) && <LoadingState>正在加载模型…</LoadingState>}
    {state?.error && <div className="model-settings-catalog-error"><p role="alert">{state.error}</p><button type="button" className="settings-text-button" disabled={state.loading} onClick={() => actions.onReloadProvider(provider.id)}>重新加载模型目录</button></div>}
    {catalog !== undefined && <>
      <div ref={list} className="provider-model-list" role="list" aria-label={`${provider.name} 模型目录`}>
        {page.items.map((item) => <div className="provider-model-row" data-model-id={item.id} role="listitem" key={item.id}>
          <label className="provider-model-check"><input type="checkbox" aria-label={`${enabled.has(item.id) ? '停用' : '启用'}模型 ${item.name}`} disabled={busy || recoveryPending} checked={enabled.has(item.id)} onChange={(event) => actions.onSetEnabled(event.target.checked ? [...new Set([...enabledModels, item.id])] : enabledModels.filter((id) => id !== item.id))} /></label>
          <div className="provider-model-identity"><strong>{item.name}</strong><code title={item.model}>{item.model}</code>{item.origin === 'override' && <small>已覆盖内置参数</small>}</div>
          <ModelCapabilities item={item} />
          <div className="provider-model-row-actions"><button type="button" className="icon-button" aria-label={`编辑模型 ${item.name}`} title={item.origin === 'builtin' ? '覆盖内置模型参数' : '编辑模型'} disabled={busy} onClick={() => actions.onOpenModelEditor(provider.id, item)}><Pencil /></button>{item.deletable && <button type="button" className="icon-button resource-delete" disabled={busy || recoveryPending} aria-label={`${item.origin === 'override' ? '恢复' : '删除'}模型 ${item.name}`} title={item.origin === 'override' ? '恢复内置参数' : '删除模型'} onClick={() => actions.onDeleteModel(provider.id, item)}><Trash2 /></button>}</div>
        </div>)}
      </div>
      {!page.total && <p className="model-settings-empty">{catalog.length ? '没有匹配的模型。' : '暂无模型，可获取模型或手动添加。'}</p>}
      {page.total > 0 && <div className="model-settings-pagination"><span role="status">已显示 {page.items.length} / {page.total} 个模型</span>{page.remaining > 0 && <button type="button" className="settings-text-button" onClick={() => { focusNewItem.current = page.items.length; setPagination({ query, limit: limit + MODEL_CATALOG_PAGE_SIZE }); }}>加载更多模型</button>}</div>}
    </>}
  </div>;
}

/** Rendering and local paging only. App owns scoped settings, IPC and editors. */
export function ModelSettings({ providers, quotaAvailable, models, enabledModels, defaultModelSelection, defaultModelBusy, settingsBusy, recoveryPending = false, providerModels, providerCatalogState, providerDiscovery, expandedProvider, modelView, modelQuery, actions }: ModelSettingsProps) {
  const modelById = useMemo(() => new Map(models.map((item) => [item.id, item])), [models]);
  const [enabledOpen, setEnabledOpen] = useState(false);
  const [quotaProviderId, setQuotaProviderId] = useState('');
  const quotaProvider = quotaAvailable && providers.find(provider => provider.id === quotaProviderId && provider.enabled && provider.quotaEnabled);
  const [sourceQuery, setSourceQuery] = useState('');
  const [sourcePage, setSourcePage] = useState(0);
  const needle = sourceQuery.trim().toLocaleLowerCase();
  const matchingSources = useMemo(() => providers.filter(source => `${source.name} ${source.id}`.toLocaleLowerCase().includes(needle)), [providers, needle]);
  const sourcePageSize = 6;
  const lastPage = Math.max(0, Math.ceil(matchingSources.length / sourcePageSize) - 1);
  const page = Math.min(sourcePage, lastPage);
  const visibleSources = matchingSources.slice(page * sourcePageSize, (page + 1) * sourcePageSize);
  const previousExpanded = useRef(expandedProvider);
  useEffect(() => {
    if (expandedProvider && previousExpanded.current !== expandedProvider) {
      const position = matchingSources.findIndex(source => source.id === expandedProvider);
      if (position >= 0) setSourcePage(Math.floor(position / sourcePageSize));
      else {
        setSourceQuery('');
        setSourcePage(Math.max(0, Math.floor(providers.findIndex(source => source.id === expandedProvider) / sourcePageSize)));
      }
    }
    previousExpanded.current = expandedProvider;
  }, [expandedProvider, matchingSources, providers]);
  const useModelDirectory = enabledModels.length > ENABLED_MODELS_PAGE_SIZE;
  const defaultOptions = useMemo(() => useModelDirectory ? [] : [...new Set([defaultModelSelection.modelRef, ...enabledModels].filter(Boolean))].map((id) => {
    const model = modelById.get(id);
    return { value: id, label: model?.name || (id === defaultModelSelection.modelRef ? defaultModelSelection.label : '') || id, description: `${model?.providerName || model?.provider || id.split('/')[0]} · ${id}` };
  }), [useModelDirectory, defaultModelSelection.modelRef, defaultModelSelection.label, enabledModels, modelById]);
  const thinkingOptions = defaultModelSelection.thinkingLevels.map((level) => ({ value: level, label: thinkingLabels[level], description: level === 'default' ? '跟随模型和 Pi 的默认推理等级' : `固定使用 ${thinkingLabels[level]}` }));
  if (providers.length === 0) return <div className="settings-sections model-settings">
    <SettingsPageHeader icon={<Cpu />} title="模型配置" meta={<span>连接模型来源并管理对话模型</span>} />
    <section className="model-settings-first-run" aria-labelledby="model-first-run-heading">
      <div>
        <h2 id="model-first-run-heading">连接一个模型来源</h2>
        <p>添加模型来源后，即可启用模型并选择新对话的默认模型。</p>
      </div>
      <button type="button" className="settings-add-button" disabled={settingsBusy} onClick={actions.onAddProvider}>
        <Plus />添加模型来源
      </button>
    </section>
  </div>;
  return <div className="settings-sections model-settings">
    <SettingsPageHeader icon={<Cpu />} title="模型配置" meta={<span>连接模型来源并管理对话模型</span>} actions={<button type="button" className="settings-add-button" disabled={settingsBusy} onClick={actions.onAddProvider}>添加模型来源</button>} />
    <section className="model-settings-section model-default-card" aria-labelledby="model-default-heading"><div className="model-settings-section-heading"><div><h2 id="model-default-heading">新对话默认</h2><p>只影响新对话，当前会话保持原设置。</p></div>{defaultModelBusy && <LoadingState>同步中</LoadingState>}</div>
      {useModelDirectory || defaultOptions.length > 0 ? <div className="model-settings-default-fields">
        <label><span>默认模型</span>{useModelDirectory
          ? <button type="button" className="pi-select-trigger" aria-label="新对话默认模型" aria-haspopup="dialog" disabled={defaultModelBusy} onClick={() => setEnabledOpen(true)}>
            <span className="pi-select-value">{defaultModelSelection.label || defaultModelSelection.modelRef || '选择模型'}</span><ChevronDown className="pi-select-chevron" aria-hidden="true" />
          </button>
          : <Select label="新对话默认模型" value={defaultModelSelection.modelRef} options={defaultOptions} disabled={defaultModelBusy || !enabledModels.length} onChange={actions.onSelectDefaultModel} />}</label>
        <label><span>默认思考强度</span><Select label="新对话默认思考强度" value={defaultModelSelection.thinkingLevel} options={thinkingOptions} disabled={defaultModelBusy || !enabledModels.length || defaultModelSelection.unavailable || thinkingOptions.length <= 1} onChange={(level) => actions.onSelectDefaultThinking(level as ThinkingLevel)} /></label>
      </div> : <p className="model-settings-empty">在模型来源中启用一个模型。</p>}
      {defaultModelSelection.unavailable && <p className="model-settings-unavailable" role="status">{defaultModelSelection.unavailableReason || '默认模型暂不可用，请选择其他已启用模型。'}</p>}
      <div className="model-enabled-summary">
        <Layers3 aria-hidden="true" /><span>已启用模型 <strong>{enabledModels.length}</strong></span>
        <button type="button" className="settings-text-button" disabled={!enabledModels.length} onClick={() => setEnabledOpen(true)}>查看全部模型<ChevronRight aria-hidden="true" /></button>
      </div>
    </section>
    <section className="model-settings-section" aria-labelledby="model-providers-heading"><div className="model-settings-section-heading"><h2 id="model-providers-heading">模型来源 <span>{providers.length}</span></h2>
      {(providers.length > sourcePageSize || sourceQuery) && <label className="model-list-search"><Search aria-hidden="true" /><input aria-label="搜索模型来源" placeholder="搜索来源…" value={sourceQuery} onChange={e => { setSourceQuery(e.target.value); setSourcePage(0); }} /></label>}
    </div>
    <div className="model-provider-directory">
      {visibleSources.map((provider) => {
        const enabled = provider.enabled !== false;
        const status = !enabled ? '已停用' : provider.authConfigured === false ? '未配置凭据' : provider.mode === 'oauth' ? 'OAuth' : provider.mode === 'env' ? '环境变量' : 'API Key';
        return <section className="model-settings-provider" data-provider-id={provider.id} key={provider.id} aria-label={`模型来源 ${provider.name}`}>
          <div className="model-settings-provider-heading"><ProviderIcon provider={provider.id} name={provider.name} icon={provider.icon} size={30} /><div className="model-settings-provider-identity"><h3>{provider.name}</h3><p><code>{provider.id}</code><span>{provider.models} 个对话模型</span>{Boolean(provider.mediaModelCount) && <span>{provider.mediaModelCount} 个媒体模型</span>}<span className={!enabled || provider.authConfigured === false ? 'is-attention' : ''}>{status}</span></p>{provider.mode === 'env' && <p>{provider.envAvailable ? '环境变量已设置' : '环境变量未设置'}{provider.envName && <> · <code>{provider.envName}</code></>}</p>}</div>
            <div className="model-settings-actions"><button type="button" className="settings-text-button" aria-label={`${provider.authConfigured === false ? '配置连接' : '编辑'} ${provider.name}`} disabled={settingsBusy} onClick={() => actions.onEditProvider(provider.id)}>{provider.authConfigured === false ? '配置连接' : '编辑'}</button><button type="button" className="settings-text-button" disabled={!enabled} aria-expanded={expandedProvider === provider.id} onClick={() => actions.onManageProvider(provider.id)}>{expandedProvider === provider.id ? '收起' : '管理模型'}</button>{quotaAvailable && provider.quotaEnabled && <button type="button" className="settings-text-button" disabled={!enabled} aria-label={`查看 ${provider.name} 额度`} onClick={() => setQuotaProviderId(provider.id)}>查看额度</button>}<button type="button" className={`switch ${enabled ? 'is-on' : ''}`} role="switch" aria-checked={enabled} disabled={settingsBusy || recoveryPending} aria-label={`${enabled ? '停用' : '启用'}模型来源 ${provider.name}`} onClick={() => actions.onToggleProvider(provider, !enabled)}><span /></button><button type="button" className="icon-button resource-delete" disabled={settingsBusy || recoveryPending} aria-label={`删除模型来源 ${provider.name}`} title="删除来源" onClick={() => actions.onDeleteProvider(provider)}><Trash2 /></button></div>
          </div>
          {expandedProvider === provider.id && <ProviderCatalog provider={provider} catalog={providerModels[provider.id]} state={providerCatalogState[provider.id]} discovery={providerDiscovery[provider.id]} query={modelQuery} enabledModels={enabledModels} busy={settingsBusy} recoveryPending={recoveryPending} actions={actions} />}
        </section>;
      })}
      {!matchingSources.length && <p className="model-settings-empty">没有匹配的来源。</p>}
    </div>
      {lastPage > 0 && <div className="model-directory-pages"><span role="status">第 {page + 1} / {lastPage + 1} 页</span><button type="button" className="icon-button" aria-label="上一页来源" disabled={!page} onClick={() => setSourcePage(page - 1)}><ChevronLeft /></button><button type="button" className="icon-button" aria-label="下一页来源" disabled={page >= lastPage} onClick={() => setSourcePage(page + 1)}><ChevronRight /></button></div>}
    </section>
    {enabledOpen && <EnabledModelsDialog enabledModels={enabledModels} modelById={modelById} defaultId={defaultModelSelection.modelRef}
      view={modelView} busy={settingsBusy || recoveryPending} defaultBusy={defaultModelBusy} actions={actions} onClose={() => setEnabledOpen(false)} />}
    {quotaProvider && <ProviderQuotaDialog key={quotaProvider.id} id={quotaProvider.id} name={quotaProvider.name} onClose={() => setQuotaProviderId('')} />}
  </div>;
}
