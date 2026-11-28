import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, Check, ChevronDown, ChevronRight, Ellipsis, Pencil, Plus, RefreshCw, Search, Trash2, X } from 'lucide-react';
import { ActionMenu, type MenuAction } from '../../shared/ActionMenu';
import { LoadingIndicator, LoadingState } from '../../shared/LoadingState';
import { SettingsPageHeader } from '../../shared/SettingsPageHeader';
import { Select } from '../../shared/Select';
import { ENABLED_MODELS_PAGE_SIZE, EnabledModelsDialog } from './EnabledModelsDialog';
import { ModelCapabilities } from './ModelCapabilities';
import { ProviderIcon } from './ProviderIcon';
import { ProviderQuotaDialog } from './ProviderQuotaView';
import { thinkingLabels, type ThinkingLevel } from '../../types/model-types';
import { discoverySelection, MODEL_CATALOG_PAGE_SIZE, modelCatalogPage } from './model-settings-catalog.ts';
import type { ModelProvider, ModelSettingsActions, ModelSettingsProps, ProviderCatalogState, ProviderDiscoveryState, ProviderModelInfo } from './model-settings-types';
import './styles/model-settings.css';

export type { ModelSettingsActions, ModelSettingsProps } from './model-settings-types';

type CatalogFilter = 'all' | 'enabled';

function providerStatusMeta(provider: ModelProvider) {
  const enabled = provider.enabled !== false;
  const needsAuth = provider.authConfigured === false;
  const label = !enabled
    ? '已停用'
    : needsAuth
      ? '未配置凭据'
      : provider.mode === 'oauth'
        ? 'OAuth'
        : provider.mode === 'env'
          ? (provider.envAvailable ? '环境变量' : '环境变量未设置')
          : 'API Key';
  const tone = !enabled ? 'off' : needsAuth || (provider.mode === 'env' && !provider.envAvailable) ? 'warn' : 'ready';
  return { enabled, needsAuth, label, tone };
}

function ProviderDiscovery({ provider, catalog, discovery, busy, recoveryPending, actions }: {
  provider: ModelProvider;
  catalog: ProviderModelInfo[];
  discovery: ProviderDiscoveryState;
  busy: boolean;
  recoveryPending: boolean;
  actions: ModelSettingsActions;
}) {
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
      <div className="provider-discovery-toolbar">
        <span>已选 {selection.selectedMissing.length} 个未添加模型</span>
        <button type="button" className="settings-text-button" disabled={!selection.missing.length || selectionDisabled}
          onClick={() => actions.onDiscoverySelection(provider.id, selection.allMissingSelected ? [] : selection.missing.map((item) => item.id))}>
          {selection.allMissingSelected ? '清空选择' : '全选未添加'}
        </button>
      </div>
      <div className="provider-discovery-list" role="group" aria-label={`${provider.name} 可添加模型`}>
        {(discovery.models || []).map((item) => {
          const added = selection.addedIds.has(item.id);
          const checked = added || selection.selectedIds.has(item.id);
          return <label className={`provider-discovery-option ${added ? 'is-added' : ''}`} key={item.id}>
            <input type="checkbox" checked={checked} disabled={added || selectionDisabled} aria-label={`${added ? '已添加模型' : '选择模型'} ${item.name}`}
              onChange={(event) => actions.onDiscoverySelection(provider.id, event.target.checked ? [...new Set([...(discovery.selected || []), item.id])] : (discovery.selected || []).filter((id) => id !== item.id))} />
            <span><strong>{item.name}</strong>{item.id.toLowerCase() !== item.name.toLowerCase() && <code>{item.id}</code>}</span>
            {added && <small>已添加</small>}
          </label>;
        })}
      </div>
      <div className="provider-discovery-footer">
        <span>{selection.missing.length ? `${selection.missing.length} 个尚未添加` : '接口返回的模型均已添加'}</span>
        <button type="button" className="settings-save" disabled={!selection.selectedMissing.length || selectionDisabled}
          onClick={() => actions.onImportModels(provider.id, selection.selectedMissing)}>
          {discovery.importing && <LoadingIndicator />}
          {discovery.importing ? '正在添加…' : selection.selectedMissing.length ? `添加所选 ${selection.selectedMissing.length} 个` : '请选择模型'}
        </button>
      </div>
    </> : <p className="model-settings-empty">接口返回了空列表。</p>)}
  </div>;
}

function ProviderOverviewRow({
  provider,
  enabledCount,
  busy,
  recoveryPending,
  quotaAvailable,
  actions,
  onQuota,
}: {
  provider: ModelProvider;
  enabledCount: number;
  busy: boolean;
  recoveryPending: boolean;
  quotaAvailable: boolean;
  actions: ModelSettingsActions;
  onQuota: () => void;
}) {
  const [menu, setMenu] = useState<{ anchor: HTMLButtonElement; x: number; y: number } | null>(null);
  const { enabled, needsAuth, label: status, tone } = providerStatusMeta(provider);
  const editLabel = needsAuth ? '配置连接' : '编辑连接';

  const overflowItems: MenuAction[] = [
    { label: editLabel, disabled: busy, run: () => actions.onEditProvider(provider.id) },
    { label: enabled ? '停用来源' : '启用来源', disabled: busy || recoveryPending, run: () => actions.onToggleProvider(provider, !enabled) },
  ];
  if (quotaAvailable && provider.quotaEnabled) {
    overflowItems.push({ label: '查看额度', disabled: !enabled, run: onQuota });
  }
  overflowItems.push({
    label: '删除来源',
    destructive: true,
    disabled: busy || recoveryPending,
    run: () => actions.onDeleteProvider(provider),
  });

  function openMenu(anchor: HTMLButtonElement) {
    const bounds = anchor.getBoundingClientRect();
    setMenu({ anchor, x: bounds.right, y: bounds.bottom + 4 });
  }

  return <li className={`model-provider-row${!enabled ? ' is-disabled' : ''}`} data-provider-id={provider.id}>
    <button
      type="button"
      className="model-provider-row-open"
      aria-label={`管理 ${provider.name} 的模型`}
      onClick={() => actions.onManageProvider(provider.id)}
    >
      <span className="model-provider-avatar" aria-hidden="true">
        <ProviderIcon provider={provider.id} name={provider.name} icon={provider.icon} size="var(--icon-lg)" />
      </span>
      <span className="model-provider-copy">
        <span className="model-provider-title">
          <strong>{provider.name}</strong>
          <span className="model-source-status" data-tone={tone}>{status}</span>
        </span>
        <span className="model-provider-sub">
          <span>{enabledCount > 0 ? `已启用 ${enabledCount} / ${provider.models} 个模型` : `${provider.models} 个模型`}</span>
          {Boolean(provider.mediaModelCount) && <span>· {provider.mediaModelCount} 媒体</span>}
        </span>
      </span>
    </button>
    <div className="model-provider-row-actions">
      <button type="button" className="icon-button model-source-more" aria-label={`${provider.name} 的更多操作`}
        title="更多操作" aria-haspopup="menu" aria-expanded={Boolean(menu)}
        onKeyDown={event => { if (event.key === 'ArrowDown') { event.preventDefault(); openMenu(event.currentTarget); } }}
        onClick={event => { if (menu) setMenu(null); else openMenu(event.currentTarget); }}>
        <Ellipsis aria-hidden="true" />
      </button>
      <ChevronRight className="model-provider-chevron" aria-hidden="true" />
    </div>
    {menu && <ActionMenu {...menu} className="model-source-menu" align="end" items={overflowItems} onClose={() => setMenu(null)} />}
  </li>;
}

function ProviderStage({
  provider,
  providers,
  catalog,
  state,
  discovery,
  query,
  enabledModels,
  defaultModelRef,
  defaultModelBusy,
  busy,
  recoveryPending,
  quotaAvailable,
  actions,
  onBack,
  onSwitchProvider,
  onQuota,
}: {
  provider: ModelProvider;
  providers: ModelProvider[];
  catalog?: ProviderModelInfo[];
  state?: ProviderCatalogState;
  discovery?: ProviderDiscoveryState;
  query: string;
  enabledModels: string[];
  defaultModelRef: string;
  defaultModelBusy: boolean;
  busy: boolean;
  recoveryPending: boolean;
  quotaAvailable: boolean;
  actions: ModelSettingsActions;
  onBack: () => void;
  onSwitchProvider: (id: string) => void;
  onQuota: () => void;
}) {
  const [filter, setFilter] = useState<CatalogFilter>('all');
  const [pagination, setPagination] = useState({ providerId: provider.id, query, filter, limit: MODEL_CATALOG_PAGE_SIZE });
  const [menu, setMenu] = useState<{ anchor: HTMLButtonElement; x: number; y: number } | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const focusNewItem = useRef<number | null>(null);

  useEffect(() => {
    setFilter('all');
    setMenu(null);
  }, [provider.id]);

  const enabledSet = useMemo(() => new Set(enabledModels), [enabledModels]);
  const enabledCountInCatalog = useMemo(
    () => (catalog ? catalog.filter((item) => enabledSet.has(item.id)).length : 0),
    [catalog, enabledSet],
  );
  const filteredSource = useMemo(() => {
    const items = catalog || [];
    if (filter === 'enabled') return items.filter((item) => enabledSet.has(item.id));
    return items;
  }, [catalog, filter, enabledSet]);

  const limit = pagination.providerId === provider.id && pagination.query === query && pagination.filter === filter
    ? pagination.limit
    : MODEL_CATALOG_PAGE_SIZE;
  const page = useMemo(() => modelCatalogPage(filteredSource, query, limit), [filteredSource, query, limit]);

  useLayoutEffect(() => {
    if (focusNewItem.current === null) return;
    const node = listRef.current?.querySelectorAll<HTMLElement>('[data-model-id]')[focusNewItem.current];
    focusNewItem.current = null;
    node?.querySelector<HTMLButtonElement>('button[role="switch"]')?.focus({ preventScroll: true });
    node?.scrollIntoView({ block: 'nearest', behavior: 'instant' });
  }, [page.items]);

  const { enabled, needsAuth, label: status, tone: statusTone } = providerStatusMeta(provider);
  const editLabel = needsAuth ? '配置连接' : '编辑连接';

  const overflowItems: MenuAction[] = [
    {
      label: enabled ? '停用来源' : '启用来源',
      disabled: busy || recoveryPending,
      run: () => actions.onToggleProvider(provider, !enabled),
    },
  ];
  if (quotaAvailable && provider.quotaEnabled) {
    overflowItems.push({ label: '查看额度', disabled: !enabled, run: onQuota });
  }
  overflowItems.push({
    label: '删除来源',
    destructive: true,
    disabled: busy || recoveryPending,
    run: () => actions.onDeleteProvider(provider),
  });

  function openMenu(anchor: HTMLButtonElement) {
    const bounds = anchor.getBoundingClientRect();
    setMenu({ anchor, x: bounds.right, y: bounds.bottom + 4 });
  }

  return <section className="model-detail-view" aria-label={`管理来源 ${provider.name}`}>
    <div className="model-detail-nav">
      <button type="button" className="model-ghost-btn model-back-btn" onClick={onBack}>
        <ArrowLeft aria-hidden="true" />模型来源
      </button>
      {providers.length > 1 && (
        <div className="model-detail-switcher">
          <Select
            label="切换模型来源"
            value={provider.id}
            options={providers.map((item) => ({
              value: item.id,
              label: item.name,
              description: item.enabled === false ? '已停用' : `${item.models} 个模型`,
            }))}
            onChange={onSwitchProvider}
          />
        </div>
      )}
    </div>

    <div className="settings-preference-card model-stage">
      <header className="model-stage-head">
        <div className="model-stage-identity">
          <span className="model-stage-avatar" aria-hidden="true">
            <ProviderIcon provider={provider.id} name={provider.name} icon={provider.icon} />
          </span>
          <div className="model-stage-copy">
            <div className="model-stage-title-row">
              <h2>{provider.name}</h2>
              <span className="model-source-status" data-tone={statusTone}>{status}</span>
              {Boolean(provider.mediaModelCount) && (
                <span className="model-stage-media-note">· {provider.mediaModelCount} 媒体</span>
              )}
            </div>
            {provider.mode === 'env' && provider.envName && (
              <code className="model-stage-env">{provider.envName}</code>
            )}
          </div>
        </div>

        <div className="model-stage-head-actions">
          <button type="button" className={needsAuth ? 'settings-save' : 'settings-outline'} disabled={busy}
            onClick={() => actions.onEditProvider(provider.id)}>
            <Pencil aria-hidden="true" />{editLabel}
          </button>
          <button type="button" className="icon-button model-source-more" aria-label={`${provider.name} 的更多操作`}
            title="更多操作" aria-haspopup="menu" aria-expanded={Boolean(menu)}
            onKeyDown={event => { if (event.key === 'ArrowDown') { event.preventDefault(); openMenu(event.currentTarget); } }}
            onClick={event => { if (menu) setMenu(null); else openMenu(event.currentTarget); }}>
            <Ellipsis aria-hidden="true" />
          </button>
        </div>
      </header>

      {!enabled ? (
        <div className="model-stage-disabled">
          <p>此模型来源已停用。</p>
          <button type="button" className="settings-outline" disabled={busy || recoveryPending}
            onClick={() => actions.onToggleProvider(provider, true)}>
            启用来源
          </button>
        </div>
      ) : (
        <div className="model-stage-body">
          <div className="model-stage-toolbar">
            <label className="model-list-search model-stage-search">
              <Search aria-hidden="true" />
              <input className="model-search" type="search" aria-label={`搜索 ${provider.name} 的模型`}
                value={query} onChange={(event) => actions.onModelQueryChange(event.target.value)}
                placeholder="搜索模型名称或 ID…" />
            </label>
            <div className="settings-segments model-stage-filter" role="group" aria-label="模型筛选">
              <button type="button" aria-pressed={filter === 'all'} onClick={() => setFilter('all')}>全部</button>
              <button type="button" aria-pressed={filter === 'enabled'} onClick={() => setFilter('enabled')}>
                已启用{catalog ? ` ${enabledCountInCatalog}` : ''}
              </button>
            </div>
            <div className="model-stage-tools">
              <button type="button" className="model-ghost-btn" title="从模型列表地址或 /models 接口拉取模型"
                disabled={discovery?.loading || discovery?.importing || busy}
                onClick={() => actions.onDiscoverProvider(provider.id)}>
                {discovery?.loading ? <LoadingIndicator /> : <RefreshCw aria-hidden="true" />}获取模型
              </button>
              <button type="button" className="model-ghost-btn" disabled={busy}
                onClick={() => actions.onOpenModelEditor(provider.id)}>
                <Plus aria-hidden="true" />添加模型
              </button>
            </div>
          </div>

          {discovery && <ProviderDiscovery provider={provider} catalog={catalog || []} discovery={discovery}
            busy={busy || catalog === undefined || Boolean(state?.loading)} recoveryPending={recoveryPending} actions={actions} />}

          {(state?.loading || (catalog === undefined && !state?.error)) && (
            <div className="model-stage-loading"><LoadingState variant="section">正在加载模型目录…</LoadingState></div>
          )}

          {state?.error && <div className="model-settings-catalog-error">
            <p role="alert">{state.error}</p>
            <button type="button" className="settings-text-button" disabled={state.loading}
              onClick={() => actions.onReloadProvider(provider.id)}>重新加载</button>
          </div>}

          {catalog !== undefined && <>
            <div ref={listRef} className="model-stage-list" role="list" aria-label={`${provider.name} 模型目录`}>
              {page.items.map((item) => {
                const isEnabled = enabledSet.has(item.id);
                const isDefault = item.id === defaultModelRef;
                const showCode = item.model.toLowerCase() !== item.name.toLowerCase();
                return <div className={`model-stage-row${isEnabled ? ' is-enabled' : ''}`} data-model-id={item.id} role="listitem" key={item.id}>
                  <div className="model-stage-row-copy">
                    <div className="model-stage-row-title">
                      <strong title={item.name}>{item.name}</strong>
                      {showCode && <code title={item.model}>{item.model}</code>}
                      {isDefault && <span className="model-default-badge"><Check aria-hidden="true" />默认</span>}
                      {item.origin === 'override' && <span className="model-override-badge">已覆盖</span>}
                    </div>
                    <ModelCapabilities item={item} />
                  </div>
                  <div className="model-stage-row-actions">
                    <div className="model-row-hover-actions">
                      {isEnabled && !isDefault && (
                        <button type="button" className="settings-text-button model-set-default-btn"
                          disabled={busy || recoveryPending || defaultModelBusy}
                          aria-label={`设 ${item.name} 为默认模型`}
                          onClick={() => actions.onSelectDefaultModel(item.id)}>
                          设为默认
                        </button>
                      )}
                      <button type="button" className="icon-button" aria-label={`编辑模型 ${item.name}`}
                        title={item.origin === 'builtin' ? '覆盖内置模型参数' : '编辑模型'} disabled={busy}
                        onClick={() => actions.onOpenModelEditor(provider.id, item)}>
                        <Pencil aria-hidden="true" />
                      </button>
                      {item.deletable && (
                        <button type="button" className="icon-button resource-delete" disabled={busy || recoveryPending}
                          aria-label={`${item.origin === 'override' ? '恢复' : '删除'}模型 ${item.name}`}
                          title={item.origin === 'override' ? '恢复内置参数' : '删除模型'}
                          onClick={() => actions.onDeleteModel(provider.id, item)}>
                          <Trash2 aria-hidden="true" />
                        </button>
                      )}
                    </div>
                    <button type="button" role="switch" aria-checked={isEnabled}
                      className={`switch model-row-switch${isEnabled ? ' is-on' : ''}`}
                      aria-label={`${isEnabled ? '停用' : '启用'}模型 ${item.name}`}
                      disabled={busy || recoveryPending}
                      onClick={() => actions.onSetEnabled(
                        isEnabled ? enabledModels.filter((id) => id !== item.id) : [...new Set([...enabledModels, item.id])],
                      )}>
                      <span />
                    </button>
                  </div>
                </div>;
              })}
            </div>
            {!page.total && (
              <p className="model-stage-empty">
                {filter === 'enabled'
                  ? '此来源下还没有启用的模型。'
                  : catalog.length
                    ? '没有匹配的模型。'
                    : '暂无模型，可点击「获取模型」或添加。'}
              </p>
            )}
            {page.remaining > 0 && (
              <div className="model-settings-pagination">
                <span role="status">已显示 {page.items.length} / {page.total} 个模型</span>
                <button type="button" className="settings-text-button" onClick={() => {
                  focusNewItem.current = page.items.length;
                  setPagination({ providerId: provider.id, query, filter, limit: limit + MODEL_CATALOG_PAGE_SIZE });
                }}>
                  加载更多（剩余 {page.remaining} 个）
                </button>
              </div>
            )}
          </>}
        </div>
      )}

      {menu && <ActionMenu {...menu} className="model-source-menu" align="end" items={overflowItems} onClose={() => setMenu(null)} />}
    </div>
  </section>;
}

/** 2-level scalable provider directory -> focused provider model stage. */
export function ModelSettings({
  providers,
  quotaAvailable,
  models,
  enabledModels,
  defaultModelSelection,
  defaultModelBusy,
  settingsBusy,
  recoveryPending = false,
  providerModels,
  providerCatalogState,
  providerDiscovery,
  expandedProvider,
  modelView,
  modelQuery,
  actions,
}: ModelSettingsProps) {
  const modelById = useMemo(() => new Map(models.map((item) => [item.id, item])), [models]);
  const [enabledOpen, setEnabledOpen] = useState(false);
  const [quotaProviderId, setQuotaProviderId] = useState('');
  const [sourceQuery, setSourceQuery] = useState('');
  const quotaProvider = quotaAvailable && providers.find(provider => provider.id === quotaProviderId && provider.enabled && provider.quotaEnabled);

  const focusedProvider = expandedProvider
    ? providers.find(provider => provider.id === expandedProvider)
    : undefined;

  const enabledCountByProvider = useMemo(() => {
    const counts = new Map<string, number>();
    for (const id of enabledModels) {
      const providerId = modelById.get(id)?.provider || id.split('/')[0];
      if (providerId) counts.set(providerId, (counts.get(providerId) || 0) + 1);
    }
    return counts;
  }, [enabledModels, modelById]);

  const needle = sourceQuery.trim().toLocaleLowerCase();
  const matchingSources = useMemo(
    () => providers.filter(source => `${source.name} ${source.id}`.toLocaleLowerCase().includes(needle)),
    [providers, needle],
  );

  const useModelDirectory = enabledModels.length > ENABLED_MODELS_PAGE_SIZE;
  const defaultOptions = useMemo(() => useModelDirectory ? [] : [...new Set([defaultModelSelection.modelRef, ...enabledModels].filter(Boolean))].map((id) => {
    const model = modelById.get(id);
    return { value: id, label: model?.name || (id === defaultModelSelection.modelRef ? defaultModelSelection.label : '') || id, description: `${model?.providerName || model?.provider || id.split('/')[0]} · ${id}` };
  }), [useModelDirectory, defaultModelSelection.modelRef, defaultModelSelection.label, enabledModels, modelById]);
  const thinkingOptions = defaultModelSelection.thinkingLevels.map((level) => ({ value: level, label: thinkingLabels[level], description: level === 'default' ? '跟随模型和 Pi 的默认推理等级' : `固定使用 ${thinkingLabels[level]}` }));

  return <div className="settings-preference-page model-settings">
    <SettingsPageHeader title="模型配置" iconPosition="end" meta={<span>连接模型来源，管理可用的对话模型。</span>}
      icon={<svg viewBox="0 0 32 32" fill="none" stroke="currentColor" strokeLinejoin="round" strokeLinecap="round" aria-hidden="true">
        <path d="m2.5 10 13.5-7 13.5 7L16 17zM2.5 16l13.5 7 13.5-7M2.5 22l13.5 7 13.5-7" />
        <path d="m12.5 10 3.5-1.8 3.5 1.8-3.5 1.8z" />
      </svg>} />

    <div className="settings-preference-groups">
      {providers.length === 0 ? <section className="settings-preference-card model-first-run" aria-labelledby="model-first-run-heading">
        <div><h2 id="model-first-run-heading">连接一个模型来源</h2>
          <p>添加模型来源后，即可启用模型并选择新对话的默认模型。</p></div>
        <button type="button" className="settings-save model-add-source" disabled={settingsBusy} onClick={actions.onAddProvider}>
          <Plus aria-hidden="true" />添加模型来源
        </button>
      </section> : focusedProvider ? (
        <ProviderStage
          provider={focusedProvider}
          providers={providers}
          catalog={providerModels[focusedProvider.id]}
          state={providerCatalogState[focusedProvider.id]}
          discovery={providerDiscovery[focusedProvider.id]}
          query={modelQuery}
          enabledModels={enabledModels}
          defaultModelRef={defaultModelSelection.modelRef}
          defaultModelBusy={defaultModelBusy}
          busy={settingsBusy}
          recoveryPending={recoveryPending}
          quotaAvailable={quotaAvailable}
          actions={actions}
          onBack={() => actions.onManageProvider(focusedProvider.id)}
          onSwitchProvider={(id) => actions.onManageProvider(id)}
          onQuota={() => setQuotaProviderId(focusedProvider.id)}
        />
      ) : <>
        <section className="settings-preference-card model-default-bar" aria-label="新对话默认配置">
          {useModelDirectory || defaultOptions.length > 0 ? <div className="model-default-grid">
            <label>
              <span>默认模型</span>
              {useModelDirectory
                ? <button type="button" className="pi-select-trigger" aria-label="新对话默认模型" aria-haspopup="dialog"
                  disabled={defaultModelBusy} onClick={() => setEnabledOpen(true)}>
                  <span className="pi-select-value">{defaultModelSelection.label || defaultModelSelection.modelRef || '选择模型'}</span>
                  <ChevronDown className="pi-select-chevron" aria-hidden="true" />
                </button>
                : <Select label="新对话默认模型" value={defaultModelSelection.modelRef} options={defaultOptions}
                  disabled={defaultModelBusy || !enabledModels.length} onChange={actions.onSelectDefaultModel} />}
            </label>
            <label>
              <span>默认思考强度</span>
              <Select label="新对话默认思考强度" value={defaultModelSelection.thinkingLevel}
                options={thinkingOptions} disabled={defaultModelBusy || !enabledModels.length || defaultModelSelection.unavailable || thinkingOptions.length <= 1}
                onChange={(level) => actions.onSelectDefaultThinking(level as ThinkingLevel)} />
            </label>
            <div className="model-default-summary">
              {defaultModelBusy && <LoadingIndicator />}
              <button type="button" className="model-ghost-btn model-enabled-btn" disabled={!enabledModels.length}
                aria-haspopup="dialog" aria-label="查看已启用模型" onClick={() => setEnabledOpen(true)}>
                已启用 <strong>{enabledModels.length}</strong> 个
              </button>
            </div>
          </div> : <div className="model-default-empty">
            <span>从下方进入任意来源启用模型，即可设为新对话默认</span>
          </div>}
          {defaultModelSelection.unavailable && <p className="model-settings-unavailable" role="status">
            {defaultModelSelection.unavailableReason || '默认模型暂不可用，请选择其他已启用模型。'}
          </p>}
        </section>

        <section className="model-provider-section" aria-labelledby="model-providers-heading">
          <div className="model-provider-section-head">
            <div className="model-provider-heading-copy">
              <h2 id="model-providers-heading">模型来源</h2>
              <span className="model-count">{providers.length}</span>
            </div>
            <div className="model-provider-section-actions">
              {(providers.length > 6 || sourceQuery) && (
                <label className="model-list-search model-source-search">
                  <Search aria-hidden="true" />
                  <input type="search" aria-label="搜索模型来源" placeholder="搜索来源…" value={sourceQuery}
                    onChange={event => setSourceQuery(event.target.value)} />
                </label>
              )}
              <button type="button" className="settings-save model-add-source" disabled={settingsBusy} onClick={actions.onAddProvider}>
                <Plus aria-hidden="true" />添加来源
              </button>
            </div>
          </div>

          <div className="settings-preference-card model-provider-list-card">
            {matchingSources.length > 0 ? (
              <ul className="model-provider-list" aria-label="已连接的模型来源">
                {matchingSources.map(provider => (
                  <ProviderOverviewRow
                    key={provider.id}
                    provider={provider}
                    enabledCount={enabledCountByProvider.get(provider.id) || 0}
                    busy={settingsBusy}
                    recoveryPending={recoveryPending}
                    quotaAvailable={quotaAvailable}
                    actions={actions}
                    onQuota={() => setQuotaProviderId(provider.id)}
                  />
                ))}
              </ul>
            ) : (
              <p className="model-stage-empty">没有匹配「{sourceQuery.trim()}」的模型来源。</p>
            )}
          </div>
        </section>
      </>}
    </div>

    {enabledOpen && providers.length > 0 && <EnabledModelsDialog enabledModels={enabledModels} modelById={modelById} defaultId={defaultModelSelection.modelRef}
      view={modelView} busy={settingsBusy || recoveryPending} defaultBusy={defaultModelBusy} actions={actions} onClose={() => { setEnabledOpen(false); actions.onModelViewChange('all'); }} />}
    {quotaProvider && <ProviderQuotaDialog key={quotaProvider.id} id={quotaProvider.id} name={quotaProvider.name} onClose={() => setQuotaProviderId('')} />}
  </div>;
}
