import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ChevronDown, ChevronLeft, ChevronRight, Ellipsis, Pencil, Plus, Search, Trash2, X } from 'lucide-react';
import { ActionMenu, type MenuAction } from '../../shared/ActionMenu';
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
    {discovery && <ProviderDiscovery provider={provider} catalog={catalog || []} discovery={discovery} busy={busy || catalog === undefined || Boolean(state?.loading)} recoveryPending={recoveryPending} actions={actions} />}
    {(state?.loading || (catalog === undefined && !state?.error)) && <LoadingState>正在加载模型…</LoadingState>}
    {state?.error && <div className="model-settings-catalog-error"><p role="alert">{state.error}</p><button type="button" className="settings-text-button" disabled={state.loading} onClick={() => actions.onReloadProvider(provider.id)}>重新加载模型目录</button></div>}
    {catalog !== undefined && <>
      <div ref={list} className="provider-model-list" role="list" aria-label={`${provider.name} 模型目录`}>
        {page.items.map((item) => <div className="provider-model-row" data-model-id={item.id} role="listitem" key={item.id}>
          <label className="provider-model-choice">
            <span className="provider-model-check"><input type="checkbox" aria-label={`${enabled.has(item.id) ? '停用' : '启用'}模型 ${item.name}`} disabled={busy || recoveryPending} checked={enabled.has(item.id)} onChange={(event) => actions.onSetEnabled(event.target.checked ? [...new Set([...enabledModels, item.id])] : enabledModels.filter((id) => id !== item.id))} /></span>
            <span className="provider-model-identity"><strong>{item.name}</strong><code title={item.model}>{item.model}</code>{item.origin === 'override' && <small>已覆盖内置参数</small>}</span>
          </label>
          <ModelCapabilities item={item} />
          <div className="provider-model-row-actions"><button type="button" className="icon-button" aria-label={`编辑模型 ${item.name}`} title={item.origin === 'builtin' ? '覆盖内置模型参数' : '编辑模型'} disabled={busy} onClick={() => actions.onOpenModelEditor(provider.id, item)}><Pencil /></button>{item.deletable && <button type="button" className="icon-button resource-delete" disabled={busy || recoveryPending} aria-label={`${item.origin === 'override' ? '恢复' : '删除'}模型 ${item.name}`} title={item.origin === 'override' ? '恢复内置参数' : '删除模型'} onClick={() => actions.onDeleteModel(provider.id, item)}><Trash2 /></button>}</div>
        </div>)}
      </div>
      {!page.total && <p className="model-settings-empty">{catalog.length ? '没有匹配的模型。' : '暂无模型，可获取模型或手动添加。'}</p>}
      {page.total > 0 && <div className="model-settings-pagination"><span role="status">已显示 {page.items.length} / {page.total} 个模型</span>{page.remaining > 0 && <button type="button" className="settings-text-button" onClick={() => { focusNewItem.current = page.items.length; setPagination({ query, limit: limit + MODEL_CATALOG_PAGE_SIZE }); }}>加载更多模型</button>}</div>}
    </>}
  </div>;
}

function ModelSourceRow({ provider, expanded, busy, recoveryPending, quotaAvailable, actions, onQuota, children }: {
  provider: ModelProvider; expanded: boolean; busy: boolean; recoveryPending: boolean; quotaAvailable: boolean;
  actions: ModelSettingsActions; onQuota: () => void; children: ReactNode;
}) {
  const catalogId = useId();
  const [menu, setMenu] = useState<{ anchor: HTMLButtonElement; x: number; y: number } | null>(null);
  const enabled = provider.enabled !== false;
  const needsAuth = provider.authConfigured === false;
  const status = !enabled ? '已停用' : needsAuth ? '未配置凭据' : provider.mode === 'oauth' ? 'OAuth' : provider.mode === 'env' ? '环境变量' : 'API Key';
  const statusTone = !enabled ? 'is-muted' : needsAuth ? 'is-warn' : 'is-ready';
  const edit = () => actions.onEditProvider(provider.id);
  const editLabel = needsAuth ? '配置连接' : '编辑连接';
  const items: MenuAction[] = [{ label: editLabel, disabled: busy, run: edit }];
  if (quotaAvailable && provider.quotaEnabled) items.push({ label: '查看额度', disabled: !enabled, run: onQuota });
  items.push({ label: '删除来源', destructive: true, disabled: busy || recoveryPending, run: () => actions.onDeleteProvider(provider) });

  function openMenu(anchor: HTMLButtonElement) {
    const bounds = anchor.getBoundingClientRect();
    setMenu({ anchor, x: bounds.right, y: bounds.bottom + 4 });
  }

  return <section className="model-settings-provider" data-provider-id={provider.id} aria-label={`模型来源 ${provider.name}`}>
    <div className="model-settings-provider-heading">
      <span className="model-source-avatar" aria-hidden="true">
        <ProviderIcon provider={provider.id} name={provider.name} icon={provider.icon} size={24} />
      </span>
      <div className="model-settings-provider-identity">
        <div className="model-source-title-row">
          <h3><button type="button" className="model-source-name settings-row-link" disabled={busy} onClick={edit}
            aria-label={`${needsAuth ? '配置连接' : '编辑'} ${provider.name}`} title={editLabel}>{provider.name}</button></h3>
          <span className={`model-source-status-pill ${statusTone}`}>{status}</span>
        </div>
        <p className="model-source-meta">
          <button type="button" className="model-source-manage settings-row-link" disabled={!enabled}
            aria-label={`${provider.models} 个对话模型，${provider.name}，${expanded ? '收起目录' : '管理模型'}`} aria-expanded={expanded}
            aria-controls={expanded ? catalogId : undefined} title={expanded ? '收起模型目录' : '管理模型'}
            onClick={() => actions.onManageProvider(provider.id)}>
            {provider.models} 个对话模型<ChevronRight className="settings-row-link-indicator" aria-hidden="true" />
          </button>
          <code>{provider.id}</code>
          {Boolean(provider.mediaModelCount) && <span>{provider.mediaModelCount} 个媒体模型</span>}
        </p>
        {provider.mode === 'env' && <p>{provider.envAvailable ? '环境变量已设置' : '环境变量未设置'}{provider.envName && <> · <code>{provider.envName}</code></>}</p>}
      </div>
      <div className="model-source-actions">
        <button type="button" className={`switch ${enabled ? 'is-on' : ''}`} role="switch" aria-checked={enabled}
          disabled={busy || recoveryPending} aria-label={`${enabled ? '停用' : '启用'}模型来源 ${provider.name}`}
          onClick={() => actions.onToggleProvider(provider, !enabled)}><span /></button>
        <button type="button" className="icon-button model-source-more" aria-label={`${provider.name} 的更多操作`}
          title="更多操作" aria-haspopup="menu" aria-expanded={Boolean(menu)}
          onKeyDown={event => { if (event.key === 'ArrowDown') { event.preventDefault(); openMenu(event.currentTarget); } }}
          onClick={event => { if (menu) setMenu(null); else openMenu(event.currentTarget); }}><Ellipsis aria-hidden="true" /></button>
      </div>
    </div>
    {expanded && <div id={catalogId}>{children}</div>}
    {menu && <ActionMenu {...menu} className="model-source-menu" align="end" items={items} onClose={() => setMenu(null)} />}
  </section>;
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
  const addSource = <button type="button" className={providers.length ? 'settings-outline model-add-source' : 'settings-add-button model-add-source'}
    disabled={settingsBusy} onClick={actions.onAddProvider}><Plus aria-hidden="true" />添加模型来源</button>;

  return <div className="settings-preference-page model-settings">
    <SettingsPageHeader title="模型配置" iconPosition="end" meta={<span>连接模型来源，管理可用的对话模型。</span>}
      icon={<svg viewBox="0 0 32 32" fill="none" stroke="currentColor" strokeLinejoin="round" strokeLinecap="round" aria-hidden="true">
        <path d="m2.5 10 13.5-7 13.5 7L16 17zM2.5 16l13.5 7 13.5-7M2.5 22l13.5 7 13.5-7" />
        <path d="m12.5 10 3.5-1.8 3.5 1.8-3.5 1.8z" stroke="var(--accent)" />
      </svg>} />
    <div className="settings-preference-groups">
      {providers.length === 0 ? <section className="settings-preference-card model-first-run" aria-labelledby="model-first-run-heading">
        <div><h2 id="model-first-run-heading">连接一个模型来源</h2>
          <p>添加模型来源后，即可启用模型并选择新对话的默认模型。</p></div>
        {addSource}
      </section> : <>
        <section className="settings-preference-card model-default-card" aria-labelledby="model-default-heading">
          <div className="model-section-heading">
            <div><h2 id="model-default-heading">新对话默认</h2><p>仅用于之后创建的对话。</p></div>
            {defaultModelBusy && <LoadingState>同步中</LoadingState>}
          </div>
          {useModelDirectory || defaultOptions.length > 0 ? <div className="model-settings-default-fields">
            <label><span>默认模型</span>{useModelDirectory
              ? <button type="button" className="pi-select-trigger" aria-label="新对话默认模型" aria-haspopup="dialog"
                disabled={defaultModelBusy} onClick={() => setEnabledOpen(true)}>
                <span className="pi-select-value">{defaultModelSelection.label || defaultModelSelection.modelRef || '选择模型'}</span>
                <ChevronDown className="pi-select-chevron" aria-hidden="true" />
              </button>
              : <Select label="新对话默认模型" value={defaultModelSelection.modelRef} options={defaultOptions}
                disabled={defaultModelBusy || !enabledModels.length} onChange={actions.onSelectDefaultModel} />}</label>
            <label><span>默认思考强度</span><Select label="新对话默认思考强度" value={defaultModelSelection.thinkingLevel}
              options={thinkingOptions} disabled={defaultModelBusy || !enabledModels.length || defaultModelSelection.unavailable || thinkingOptions.length <= 1}
              onChange={(level) => actions.onSelectDefaultThinking(level as ThinkingLevel)} /></label>
          </div> : <p className="model-settings-empty">在模型来源中启用一个模型。</p>}
          {defaultModelSelection.unavailable && <p className="model-settings-unavailable" role="status">
            {defaultModelSelection.unavailableReason || '默认模型暂不可用，请选择其他已启用模型。'}
          </p>}
          <button type="button" className="model-enabled-summary" disabled={!enabledModels.length} aria-haspopup="dialog"
            aria-label="查看已启用模型" aria-describedby="model-enabled-count" onClick={() => setEnabledOpen(true)}>
            <span id="model-enabled-count">已启用模型 <span className="model-count">{enabledModels.length}</span></span>
            <span className="model-summary-link">查看列表<ChevronRight aria-hidden="true" /></span>
          </button>
        </section>
        <section className="settings-preference-card model-provider-directory" aria-labelledby="model-providers-heading">
          <div className="model-section-heading"><h2 id="model-providers-heading">模型来源 <span className="model-count">{providers.length}</span></h2>{addSource}</div>
          {(providers.length > sourcePageSize || sourceQuery) && <label className="model-list-search">
            <Search aria-hidden="true" /><input aria-label="搜索模型来源" placeholder="搜索来源名称或 ID…" value={sourceQuery}
              onChange={event => { setSourceQuery(event.target.value); setSourcePage(0); }} />
          </label>}
          {visibleSources.map(provider => {
            const expanded = expandedProvider === provider.id;
            return <ModelSourceRow key={provider.id} provider={provider} expanded={expanded} busy={settingsBusy} recoveryPending={recoveryPending}
              quotaAvailable={quotaAvailable} actions={actions} onQuota={() => setQuotaProviderId(provider.id)}>
              <ProviderCatalog provider={provider} catalog={providerModels[provider.id]} state={providerCatalogState[provider.id]}
                discovery={providerDiscovery[provider.id]} query={modelQuery} enabledModels={enabledModels} busy={settingsBusy}
                recoveryPending={recoveryPending} actions={actions} />
            </ModelSourceRow>;
          })}
          {!matchingSources.length && <p className="model-settings-empty">没有匹配的来源。</p>}
          {lastPage > 0 && <div className="model-directory-pages"><span role="status">第 {page + 1} / {lastPage + 1} 页</span>
            <button type="button" className="icon-button" aria-label="上一页来源" disabled={!page} onClick={() => setSourcePage(page - 1)}><ChevronLeft /></button>
            <button type="button" className="icon-button" aria-label="下一页来源" disabled={page >= lastPage} onClick={() => setSourcePage(page + 1)}><ChevronRight /></button>
          </div>}
        </section>
      </>}
    </div>
    {enabledOpen && providers.length > 0 && <EnabledModelsDialog enabledModels={enabledModels} modelById={modelById} defaultId={defaultModelSelection.modelRef}
      view={modelView} busy={settingsBusy || recoveryPending} defaultBusy={defaultModelBusy} actions={actions} onClose={() => setEnabledOpen(false)} />}
    {quotaProvider && <ProviderQuotaDialog key={quotaProvider.id} id={quotaProvider.id} name={quotaProvider.name} onClose={() => setQuotaProviderId('')} />}
  </div>;
}
