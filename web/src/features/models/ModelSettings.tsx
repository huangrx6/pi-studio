import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Cpu, LoaderCircle, Pencil, Plus, Trash2, X } from 'lucide-react';
import { SettingsPageHeader } from '../../shared/SettingsPageHeader';
import { Select } from '../../shared/Select';
import { InfoHint } from '../../shared/InfoHint';
import { tokenLabel } from '../../shared/token-units';
import { thinkingLabels, type ModelOption, type ThinkingLevel } from '../../types/model-types';
import { discoverySelection, MODEL_CATALOG_PAGE_SIZE, modelCatalogPage } from './model-settings-catalog.mjs';
import type { ModelProvider, ModelSettingsActions, ModelSettingsProps, ProviderCatalogState, ProviderDiscoveryState, ProviderModelInfo } from './model-settings-types';
import './model-settings.css';

export type { ModelSettingsActions, ModelSettingsProps } from './model-settings-types';

function ModelCapabilities({ item }: { item: Pick<ModelOption, 'contextWindow' | 'maxTokens' | 'supportsImages' | 'reasoning' | 'thinkingLevels'> }) {
  return <span className="model-settings-capabilities">
    {Boolean(item.contextWindow) && <span title={`${item.contextWindow!.toLocaleString()} tokens`}>{tokenLabel(item.contextWindow!)} 上下文</span>}
    {Boolean(item.maxTokens) && <span title={`${item.maxTokens!.toLocaleString()} tokens`}>{tokenLabel(item.maxTokens!)} 输出</span>}
    {item.supportsImages && <span>图片</span>}
    {item.reasoning && <span>{item.thinkingLevels?.length ? `推理 · ${item.thinkingLevels.length} 档` : '推理'}</span>}
  </span>;
}

function ProviderDiscovery({ provider, catalog, discovery, busy, recoveryPending, actions }: { provider: ModelProvider; catalog: ProviderModelInfo[]; discovery: ProviderDiscoveryState; busy: boolean; recoveryPending: boolean; actions: ModelSettingsActions }) {
  const selectionDisabled = busy || recoveryPending || Boolean(discovery.importing);
  const selection = useMemo(() => discoverySelection(discovery.models || [], catalog, discovery.selected || []), [discovery.models, discovery.selected, catalog]);
  return <div className={`provider-discovery-panel ${discovery.error ? 'is-error' : ''}`}>
    <div className="provider-discovery-head">
      <div><strong role="status">{discovery.loading ? '正在读取模型列表…' : discovery.error ? '模型发现失败' : `发现 ${discovery.models?.length || 0} 个模型`}</strong>
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
      <div className="provider-discovery-footer"><span>{selection.missing.length ? `${selection.missing.length} 个模型尚未添加` : '接口返回的模型都已添加'}</span><button type="button" className="settings-save" disabled={!selection.selectedMissing.length || selectionDisabled} onClick={() => actions.onImportModels(provider.id, selection.selectedMissing)}>{discovery.importing && <LoaderCircle className="spin" />}{discovery.importing ? '正在添加…' : selection.selectedMissing.length ? `添加所选 ${selection.selectedMissing.length} 个` : '请选择模型'}</button></div>
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
    <div className="provider-model-head"><h3>模型目录 <InfoHint label="获取模型使用配置的模型列表地址；留空时自动尝试来源的 /models 接口。" /></h3><div className="model-settings-actions">
      <button type="button" className="settings-outline" disabled={discovery?.loading || discovery?.importing || busy} onClick={() => actions.onDiscoverProvider(provider.id)}>{discovery?.loading && <LoaderCircle className="spin" />}获取模型</button>
      <button type="button" className="settings-add-button" disabled={busy} onClick={() => actions.onOpenModelEditor(provider.id)}>添加模型</button>
    </div></div>
    <div className="provider-model-search"><input className="model-search" aria-label={`搜索 ${provider.name} 的模型`} value={query} onChange={(event) => actions.onModelQueryChange(event.target.value)} placeholder="搜索名称或模型 ID…" /></div>
    {discovery && <ProviderDiscovery provider={provider} catalog={catalog || []} discovery={discovery} busy={busy} recoveryPending={recoveryPending} actions={actions} />}
    {state?.loading && <p className="model-settings-status" role="status"><LoaderCircle className="spin" />正在加载模型…</p>}
    {state?.error && <div className="model-settings-catalog-error"><p role="alert">{state.error}</p><button type="button" className="settings-text-button" disabled={state.loading} onClick={() => actions.onReloadProvider(provider.id)}>重新加载模型目录</button></div>}
    {catalog === undefined && !state?.loading && !state?.error && <p className="model-settings-status" role="status">正在加载模型…</p>}
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
export function ModelSettings({ providers, models, enabledModels, defaultModelSelection, defaultModelBusy, settingsBusy, recoveryPending = false, providerModels, providerCatalogState, providerDiscovery, expandedProvider, modelView, modelQuery, actions }: ModelSettingsProps) {
  const modelById = useMemo(() => new Map(models.map((item) => [item.id, item])), [models]);
  const groups = useMemo(() => {
    const grouped = new Map<string, { provider: string; name: string; ids: string[] }>();
    for (const id of enabledModels) {
      const model = modelById.get(id); const provider = model?.provider || id.split('/')[0];
      const group = grouped.get(provider) || { provider, name: model?.providerName || provider, ids: [] };
      group.ids.push(id); grouped.set(provider, group);
    }
    return [...grouped.values()].sort((a, b) => a.name.localeCompare(b.name));
  }, [enabledModels, modelById]);
  const defaultOptions = useMemo(() => [...new Set([defaultModelSelection.modelRef, ...enabledModels].filter(Boolean))].map((id) => {
    const model = modelById.get(id);
    return { value: id, label: model?.name || (id === defaultModelSelection.modelRef ? defaultModelSelection.label : '') || id, description: `${model?.providerName || model?.provider || id.split('/')[0]} · ${id}` };
  }), [defaultModelSelection.modelRef, defaultModelSelection.label, enabledModels, modelById]);
  const thinkingOptions = defaultModelSelection.thinkingLevels.map((level) => ({ value: level, label: thinkingLabels[level], description: level === 'default' ? '跟随模型和 Pi 的默认推理等级' : `固定使用 ${thinkingLabels[level]}` }));
  const renderEnabledModel = (id: string) => {
    const item = modelById.get(id);
    return <li className="model-settings-enabled-row" data-enabled-model-id={id} key={id}><div className="model-settings-enabled-identity"><strong>{item?.name || id}</strong><code title={id}>{id}</code></div>{item && <ModelCapabilities item={item} />}<button type="button" className="icon-button" disabled={settingsBusy || recoveryPending} aria-label={`移除模型 ${item?.name || id}`} title="从已启用模型中移除" onClick={() => actions.onSetEnabled(enabledModels.filter((entry) => entry !== id))}><X /></button></li>;
  };
  if (providers.length === 0) return <div className="settings-sections model-settings">
    <SettingsPageHeader icon={<Cpu />} title="模型配置" />
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
    <SettingsPageHeader icon={<Cpu />} title="模型配置" actions={<button type="button" className="settings-add-button" disabled={settingsBusy} onClick={actions.onAddProvider}>添加模型来源</button>} />
    <section className="model-settings-section" aria-labelledby="model-default-heading"><div className="model-settings-section-heading"><div><h2 id="model-default-heading">新对话默认</h2><p>只影响新对话，当前会话保持原设置。</p></div>{defaultModelBusy && <span className="model-settings-status" role="status"><LoaderCircle className="spin" />同步中</span>}</div>
      {defaultOptions.length > 0 ? <div className="model-settings-default-fields"><label><span>默认模型</span><Select label="新对话默认模型" value={defaultModelSelection.modelRef} options={defaultOptions} disabled={defaultModelBusy || enabledModels.length === 0} onChange={actions.onSelectDefaultModel} /></label><label><span>默认思考强度</span><Select label="新对话默认思考强度" value={defaultModelSelection.thinkingLevel} options={thinkingOptions} disabled={defaultModelBusy || enabledModels.length === 0 || defaultModelSelection.unavailable || thinkingOptions.length <= 1} onChange={(level) => actions.onSelectDefaultThinking(level as ThinkingLevel)} /></label></div> : <p className="model-settings-empty">{providers.length ? '在模型来源中启用一个模型。' : '添加模型来源后即可选择默认模型。'}</p>}
      {defaultModelSelection.unavailable && <p className="model-settings-unavailable" role="status">{defaultModelSelection.unavailableReason || '默认模型暂不可用，请选择其他已启用模型。'}</p>}
    </section>
    <section className="model-settings-section" aria-labelledby="model-enabled-heading"><div className="model-settings-section-heading"><h2 id="model-enabled-heading">已启用模型 <span>{enabledModels.length}</span></h2>{enabledModels.length > 0 && <div className="model-settings-view" role="group" aria-label="模型查看方式"><button type="button" aria-pressed={modelView === 'all'} onClick={() => actions.onModelViewChange('all')}>全部</button><button type="button" aria-pressed={modelView === 'provider'} onClick={() => actions.onModelViewChange('provider')}>按来源</button></div>}</div>
      {!enabledModels.length ? <p className="model-settings-empty">还没有启用模型</p> : modelView === 'all' ? <ul className="model-settings-enabled-list">{enabledModels.map(renderEnabledModel)}</ul> : <div className="model-settings-groups">{groups.map((group) => <section key={group.provider}><h3>{group.name}</h3><ul className="model-settings-enabled-list">{group.ids.map(renderEnabledModel)}</ul></section>)}</div>}
    </section>
    <section className="model-settings-section" aria-labelledby="model-providers-heading"><div className="model-settings-section-heading"><h2 id="model-providers-heading">模型来源 <span>{providers.length}</span></h2></div>
      {providers.map((provider) => {
        const enabled = provider.enabled !== false;
        const status = !enabled ? '已停用' : provider.authConfigured === false ? '未配置凭据' : provider.mode === 'oauth' ? 'OAuth' : provider.mode === 'env' ? '环境变量' : 'API Key';
        return <section className="model-settings-provider" data-provider-id={provider.id} key={provider.id} aria-label={`模型来源 ${provider.name}`}>
          <div className="model-settings-provider-heading"><div className="model-settings-provider-identity"><h3>{provider.name}</h3><p><code>{provider.id}</code><span>{provider.models} 个模型</span><span className={!enabled || provider.authConfigured === false ? 'is-attention' : ''}>{status}</span></p>{provider.mode === 'env' && <p>{provider.envAvailable ? '环境变量已设置' : '环境变量未设置'}{provider.envName && <> · <code>{provider.envName}</code></>}</p>}</div>
            <div className="model-settings-actions"><button type="button" className="settings-text-button" aria-label={`${provider.authConfigured === false ? '配置连接' : '编辑'} ${provider.name}`} disabled={settingsBusy} onClick={() => actions.onEditProvider(provider.id)}>{provider.authConfigured === false ? '配置连接' : '编辑'}</button><button type="button" className="settings-text-button" disabled={!enabled} aria-expanded={expandedProvider === provider.id} onClick={() => actions.onManageProvider(provider.id)}>{expandedProvider === provider.id ? '收起' : '管理模型'}</button><button type="button" className={`switch ${enabled ? 'is-on' : ''}`} role="switch" aria-checked={enabled} disabled={settingsBusy || recoveryPending} aria-label={`${enabled ? '停用' : '启用'}模型来源 ${provider.name}`} onClick={() => actions.onToggleProvider(provider, !enabled)}><span /></button><button type="button" className="icon-button resource-delete" disabled={settingsBusy || recoveryPending} aria-label={`删除模型来源 ${provider.name}`} title="删除来源" onClick={() => actions.onDeleteProvider(provider)}><Trash2 /></button></div>
          </div>
          {expandedProvider === provider.id && <ProviderCatalog provider={provider} catalog={providerModels[provider.id]} state={providerCatalogState[provider.id]} discovery={providerDiscovery[provider.id]} query={modelQuery} enabledModels={enabledModels} busy={settingsBusy} recoveryPending={recoveryPending} actions={actions} />}
        </section>;
      })}
      {!providers.length && <p className="model-settings-empty">还没有模型来源</p>}
    </section>
  </div>;
}
