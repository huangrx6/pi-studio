import { Accordion } from '../../shared/Accordion';
import { LoadingIndicator, LoadingState } from '../../shared/LoadingState';
import { useSettingsToast } from '../../shared/SettingsToast';
import { useSettingsDraftGuard } from '../../shared/SettingsDraftGuard';
import { useCallback, useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import {
  ChevronRight,
  Check,
  CircleAlert,
  Package,
  Search,
  Terminal,
  Trash2,
  RotateCw,
  X,
} from 'lucide-react';
import { DetailDialog } from '../../shared/DetailDialog';
import { InfoHint } from '../../shared/InfoHint';
import { SettingsPageHeader } from '../../shared/SettingsPageHeader';
import { localToolSelection, patternMatches, sameToolNames, selectionFromSources, toggleToolSelection } from './agent-tool-selection';
import { groupAgentTools, isMcpMethod, type CatalogDisplayEntry } from './agent-tool-groups';
import './styles/agent-tools-settings.css';
import { toolWrites } from './agent-tool-writes';
import type {
  AgentToolCatalog,
  AgentToolCommand,
  AgentToolInfo,
  AgentToolSelection,
  AgentToolSource,
} from '../../types/agent-tool-types';
import { runtimeRefreshFailure } from '../../shared/runtime-refresh';
import { isComposingKey } from '../../shared/keyboard-navigation';

const RECOMMENDED_TOOLS = ['read', 'write', 'edit', 'bash', 'grep', 'find', 'ls', 'tool_search'];

const SOURCE_KIND_LABEL: Record<AgentToolSource['kind'], string> = {
  core: 'Pi 核心',
  mcp: 'MCP 服务器',
  package: '扩展包',
  git: 'Git 扩展',
  local: '本地扩展',
  inline: 'Studio 内置',
  extension: '扩展',
};

type AgentToolDetail = {
  kind: 'tool';
  item: CatalogDisplayEntry<AgentToolInfo>;
} | {
  kind: 'command';
  item: CatalogDisplayEntry<AgentToolCommand>;
};

function scopeLabel(scope: string): string {
  if (scope === 'project' || scope === 'workspace') return '当前项目';
  if (scope === 'manual') return '手动添加';
  return '全局';
}

function exposureLabel(exposure: string): string {
  if (exposure === 'direct') return '直接提供';
  if (exposure === 'on-demand' || exposure === 'deferred') return '按需加载';
  if (exposure === 'hidden') return '隐藏';
  return exposure || '标准';
}

function toolSource(selection: AgentToolSelection, name: string): AgentToolSource {
  const stored = selection.sources[name];
  return {
    key: stored?.source || 'unknown',
    source: stored?.source || 'unknown',
    label: stored?.label || '来源未知',
    kind: stored?.source?.startsWith('npm:')
      ? 'package'
      : stored?.source?.startsWith('git:')
        ? 'git'
        : stored?.source === 'manual'
          ? 'local'
          : 'extension',
    scope: stored?.scope || 'user',
    path: stored?.path || '',
    baseDir: stored?.baseDir || '',
  };
}

export function AgentToolsSettings({ cwd, initialSelection, onSaved, onOpenMcp }: {
  cwd: string;
  onOpenMcp: () => void;
  initialSelection: AgentToolSelection;
  onSaved: (snapshot: { agentTools: AgentToolSelection }) => void;
}) {
  const showToast = useSettingsToast();
  const initialLocal = useMemo(() => localToolSelection(initialSelection), [initialSelection]);
  const [selection, setSelection] = useState(initialLocal);
  const [draft, setDraft] = useState(initialLocal);
  const [catalog, setCatalog] = useState<AgentToolCatalog | null>(null);
  const [loading, setLoading] = useState(true);
  const writeState = useSyncExternalStore(toolWrites.subscribe, toolWrites.getSnapshot);
  const saving = writeState.pending;
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [customName, setCustomName] = useState('');
  const [groupExpansion, setGroupExpansion] = useState<Record<string, boolean>>({});
  const [collapsedMatches, setCollapsedMatches] = useState<string[]>([]);
  const groupId = useId();
  const [detail, setDetail] = useState<AgentToolDetail | null>(null);
  const requestRef = useRef(0);
  const contextRef = useRef(cwd);
  contextRef.current = cwd;
  const lifecycleRef = useRef(0);
  const selectionRef = useRef(initialLocal);


  const loadCatalog = useCallback(async (refresh = false) => {
    const request = ++requestRef.current;
    setLoading(true);
    setCatalogError(null);
    const lifecycle = lifecycleRef.current;
    const current = () => request === requestRef.current && lifecycle === lifecycleRef.current && cwd === contextRef.current;
    try {
      const result = await window.piApi.agentToolCatalog({ cwd, refresh });
      if (current()) setCatalog(result);
    } catch (cause) {
      if (current()) setCatalogError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (current()) setLoading(false);
    }
  }, [cwd]);

  useEffect(() => {
    const previous = selectionRef.current;
    setSelection(initialLocal);
    setDraft(current => sameToolNames(current.enabled, previous.enabled) ? initialLocal : current);
    selectionRef.current = initialLocal;
  }, [initialLocal]);

  useEffect(() => {
    // Settings is often opened immediately after an extension change, so start
    // from the current runtime instead of a stale in-memory discovery session.
    setCatalog(null);
    setGroupExpansion({});
    setCollapsedMatches([]);
    setDetail(null);
    void loadCatalog(true);
    return () => { requestRef.current += 1; lifecycleRef.current += 1; };
  }, [loadCatalog]);

  useEffect(() => {
    if (!writeState.failure) return;
    setDraft(writeState.failure.draft);
    showToast(writeState.failure.message, 'error');
  }, [writeState.failure, cwd, showToast]);

  const localTools = useMemo(() => catalog?.tools.filter(tool => !isMcpMethod(tool)) ?? [], [catalog]);
  const catalogSources = useMemo(
    () => Object.fromEntries(localTools.map(tool => [tool.name, tool.source])),
    [localTools],
  );
  const availableNames = useMemo(() => new Set(localTools.map(tool => tool.name)), [localTools]);
  const dirty = !sameToolNames(draft.enabled, selection.enabled);
  useSettingsDraftGuard({ label: '工具选择', dirty, saving });
  const wildcardRules = draft.enabled.filter((name) => name.includes('*'));
  const recommendedSelected = sameToolNames(draft.enabled, RECOMMENDED_TOOLS);
  const unavailable = catalog ? draft.enabled.filter(name => !name.includes('*') && !availableNames.has(name)) : [];
  const groups = useMemo(() => catalog ? groupAgentTools(catalog, query) : [], [catalog, query]);
  const diagnostics = catalog ? [...catalog.errors.filter(item => !item.path?.startsWith('mcp:')), ...catalog.warnings] : [];
  const searching = Boolean(query.trim());
  function search(value: string) {
    setQuery(value);
    setCollapsedMatches([]);
  }
  function toggleGroup(key: string, defaultOpen: boolean) {
    if (searching) {
      setCollapsedMatches(keys => keys.includes(key) ? keys.filter(item => item !== key) : [...keys, key]);
    } else {
      setGroupExpansion(current => ({ ...current, [key]: !(current[key] ?? defaultOpen) }));
    }
  }
  const detailIsTool = detail?.kind === 'tool';
  const selectionEnables = (name: string) => draft.enabled.some((pattern) => patternMatches(pattern, name));
  const detailEnabled = detailIsTool && selectionEnables(detail.item.name);
  const detailChanged = detailIsTool && detailEnabled !== selection.enabled.some(pattern => patternMatches(pattern, detail.item.name));

  function updateEnabled(next: string[]) {
    if (toolWrites.getSnapshot().pending) return;
    toolWrites.clearFailure();
    setDraft((current) => selectionFromSources(next, catalogSources, current));
  }

  function toggle(name: string, checked: boolean) {
    if (toolWrites.getSnapshot().pending) return;
    const expandsWildcard = !checked && draft.enabled.some(rule => rule.includes('*') && patternMatches(rule, name));
    updateEnabled(toggleToolSelection(draft.enabled, [...availableNames], name, checked));
    if (expandsWildcard) showToast('已展开匹配的通配规则。保存后，新出现的匹配工具需单独允许。', 'info');
  }

  function addCustomTool() {
    if (toolWrites.getSnapshot().pending) return;
    const name = customName.trim();
    if (!/^[A-Za-z0-9_.:*\-]+$/.test(name) || ['__proto__', 'prototype', 'constructor'].includes(name)) {
      showToast('工具名或通配符只能包含字母、数字、点、横线、下划线、冒号或星号。', 'error');
      return;
    }
    if (name.startsWith('mcp__')) {
      showToast('请在 MCP 服务器的工具列表中启停这个方法。', 'error');
      return;
    }
    if (draft.enabled.includes(name)) {
      setCustomName('');
      return;
    }
    // Keep unresolved names in the allow-list draft. The SDK will activate them
    // automatically once the matching extension tool appears in discovery.
    updateEnabled([...draft.enabled, name]);
    setCustomName('');
  }

  function resetRecommended() {
    updateEnabled(RECOMMENDED_TOOLS);
  }

  async function save() {
    if (toolWrites.getSnapshot().pending || !dirty) return;
    const lifecycle = lifecycleRef.current;
    const current = () => lifecycle === lifecycleRef.current && cwd === contextRef.current;
    try {
      const snapshot = await toolWrites.run(draft, () => window.piApi.setAgentTools({ tools: draft, cwd }));
      // The saved selection is global even if this editor has since closed.
      onSaved(snapshot);
      const refreshFailure = runtimeRefreshFailure(snapshot.runtimeRefresh);
      if (refreshFailure) toolWrites.reportSavedWarning(snapshot.agentTools, refreshFailure);
      if (!current()) return;
      const saved = localToolSelection(snapshot.agentTools);
      setSelection(saved);
      setDraft(saved);
      selectionRef.current = saved;
      if (!refreshFailure) showToast(snapshot.runtimeRefresh?.pendingSessions ? '配置已保存，运行中的会话将在本轮结束后应用。' : '配置已保存。');
      void loadCatalog(true);
    } catch (cause) {
      if (current() && !toolWrites.getSnapshot().failure) showToast(cause instanceof Error ? cause.message : String(cause), 'error');
    }
  }

  return <div className="settings-preference-page agent-tools-settings">
    <SettingsPageHeader title="智能体工具" iconPosition="end" meta="选择对话可调用的内置工具和扩展工具。"
      icon={<svg viewBox="0 0 32 32" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M2 11h28v16H2zM11 11V7.5A2.5 2.5 0 0 1 13.5 5h5A2.5 2.5 0 0 1 21 7.5V11M2 17h11m6 0h11" />
        <rect x="13" y="15" width="6" height="5" rx="1" stroke="var(--accent)" />
      </svg>} />
    <div className="settings-preference-groups">
      <section className="settings-preference-card agent-tool-catalog" aria-labelledby="agent-catalog-title">
        <header className="agent-tool-catalog-heading">
          <div><h2 id="agent-catalog-title">工具目录</h2>
            {catalog && <p>{localTools.length} 个工具{catalog.commands.length > 0 && ` · ${catalog.commands.length} 个扩展命令`}</p>}</div>
          <button type="button" className="settings-outline" disabled={loading || saving} onClick={() => void loadCatalog(true)}>
            {loading ? <LoadingIndicator /> : <RotateCw aria-hidden="true" />}刷新目录
          </button>
        </header>
        <div className="agent-tool-search-wrap"><Search aria-hidden="true" />
          <input className="agent-tool-search" aria-label="搜索智能体工具" placeholder="搜索工具、命令或来源…" value={query} onChange={event => search(event.target.value)} />
          {query && <button type="button" aria-label="清除工具搜索" title="清除搜索" onClick={() => search('')}><X /></button>}
        </div>
        {catalogError && <div className="agent-tool-catalog-error"><p role="alert">{catalogError}</p>
          <button type="button" className="settings-text-button" disabled={loading || saving} onClick={() => void loadCatalog(true)}>重新加载工具目录</button>
          {catalog && <small>显示上次成功读取的目录。</small>}</div>}
        {loading && !catalog && <LoadingState variant="section">正在读取工具目录…</LoadingState>}
        {catalog && <div className="agent-tool-groups">
          {groups.map((group, index) => {
            const expanded = searching ? !collapsedMatches.includes(group.key) : groupExpansion[group.key] ?? group.defaultOpen;
            const panel = `${groupId}-${index}`;
            const enabledCount = group.tools.filter(tool => selectionEnables(tool.name)).length;
            return <section className="agent-tool-group" key={group.key}>
              <h3><button type="button" className="agent-tool-group-trigger" aria-expanded={expanded} aria-controls={panel} onClick={() => toggleGroup(group.key, group.defaultOpen)}>
                <span>{group.label}</span>
                <small>{searching ? `${group.tools.length + group.commands.length} 项匹配` :
                  [group.tools.length > 0 && `${enabledCount} / ${group.tools.length} 已启用`, group.commands.length > 0 && `${group.commands.length} 个命令`].filter(Boolean).join(' · ')}</small>
                <ChevronRight aria-hidden="true" />
              </button></h3>
              <div id={panel} hidden={!expanded}>{expanded && <ul className="agent-tool-list">
                {group.tools.map(tool => {
                  const enabled = selectionEnables(tool.name);
                  return <li className="agent-tool-row" key={tool.name}>
                    <div><button type="button" className="agent-tool-open settings-row-link" aria-label={`查看工具 ${tool.name} 详情`} onClick={() => setDetail({ kind: 'tool', item: tool })}>
                      <code>{tool.name}</code><ChevronRight className="settings-row-link-indicator" aria-hidden="true" /></button>
                      <p>{tool.description}</p></div>
                    <button type="button" role="switch" className={`switch ${enabled ? 'is-on' : ''}`} aria-checked={enabled} disabled={saving || loading}
                      aria-label={`${enabled ? '禁用' : '允许'}工具 ${tool.name}`} onClick={() => toggle(tool.name, !enabled)}><span /></button>
                  </li>;
                })}
                {group.commands.map(command => <li className="agent-tool-row" key={`command:${command.name}`}>
                  <div><button type="button" className="agent-tool-open settings-row-link" aria-label={`查看扩展命令 ${command.name} 详情`} onClick={() => setDetail({ kind: 'command', item: command })}>
                    <code>/{command.name}</code><ChevronRight className="settings-row-link-indicator" aria-hidden="true" /></button><p>{command.description}</p></div>
                  <small>随扩展启停</small>
                </li>)}
              </ul>}</div>
            </section>;
          })}
          {!groups.length && <p className="agent-tool-empty" role="status">{searching ? '没有匹配的工具或命令。' : '当前工作区没有检测到可配置工具。'}</p>}
        </div>}
        <div className="agent-tool-mcp"><span>MCP 方法由各服务器管理</span>
          <button type="button" className="settings-text-button" disabled={saving} onClick={onOpenMcp}>管理 MCP 方法<ChevronRight aria-hidden="true" /></button></div>
      </section>

      <Accordion className="settings-preference-card agent-tool-rules" summary="自定义规则"
        description={[wildcardRules.length > 0 && `${wildcardRules.length} 条通配规则`, unavailable.length > 0 && `${unavailable.length} 个工具暂未发现`].filter(Boolean).join(' · ') || '按名称或通配符添加工具'}>
        <div className="agent-tool-rules-body">
          {wildcardRules.length > 0 && <section aria-label="批量工具规则">
            <h3>通配规则 <InfoHint label="停用通配规则中的一个工具时，会保留当前检测到的其他匹配工具。" /></h3>
            <ul className="agent-tool-rule-list">{wildcardRules.map(name => <li key={name}>
              <div><code>{name}</code>{catalog && <p>匹配 {localTools.filter(tool => patternMatches(name, tool.name)).length} 个工具</p>}</div>
              <button type="button" className="icon-button" disabled={saving} aria-label={`移除工具规则 ${name}`} onClick={() => updateEnabled(draft.enabled.filter(item => item !== name))}><Trash2 /></button>
            </li>)}</ul>
          </section>}
          {unavailable.length > 0 && <section aria-label="当前未检测到的工具">
            <h3>暂未发现 <InfoHint label="名称保留在配置中，工具重新出现后会被允许。" /></h3>
            <ul className="agent-tool-rule-list">{unavailable.map(name => {
              const source = toolSource(draft, name);
              return <li key={name}><div><code>{name}</code><p>{source.label} · {source.source}</p></div>
                <button type="button" className="icon-button" disabled={saving} aria-label={`移除不可用工具 ${name}`} onClick={() => toggle(name, false)}><Trash2 /></button></li>;
            })}</ul>
          </section>}
          <div className="agent-tool-custom">
            <label htmlFor="agent-tool-custom-name">手动添加</label>
            <div className="agent-tool-custom-control"><input id="agent-tool-custom-name" value={customName} disabled={saving} placeholder="工具名或通配符，例如 browser_*"
              onChange={event => setCustomName(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && !isComposingKey(event.nativeEvent)) addCustomTool(); }} />
              <button type="button" className="settings-outline" disabled={saving || !customName.trim()} onClick={addCustomTool}>添加</button></div>
          </div>
        </div>
      </Accordion>
      {diagnostics.length > 0 && <Accordion className="settings-preference-card agent-tool-diagnostics" summary="扩展诊断" badge={diagnostics.length}>
        {diagnostics.map((item, index) => <div className="agent-tool-diagnostic" key={index}><code>{item.path || '扩展加载'}</code><p>{item.message}</p></div>)}
      </Accordion>}
      <footer className={`settings-preference-card agent-tool-save-bar${dirty ? ' is-dirty' : ''}`}>
        <div className="agent-tool-save-summary"><strong>全局配置</strong><span role="status">{saving ? '正在保存…' : dirty ? '有未保存的更改' : '与已保存配置一致'}</span></div>
        <div className="agent-tool-toolbar-actions">
          <button type="button" className="settings-text-button" disabled={saving || !dirty} onClick={() => { toolWrites.clearFailure(); setDraft(selection); }}>撤销更改</button>
          <button type="button" className="settings-outline" disabled={saving || recommendedSelected} onClick={resetRecommended}>恢复推荐配置</button>
          <button type="button" className="settings-save" disabled={saving || !dirty} onClick={() => void save()}>{saving ? '正在保存…' : '保存更改'}</button>
        </div>
      </footer>
    </div>

    {detail && <DetailDialog className="agent-tool-detail-dialog" onClose={() => setDetail(null)}>
      <header className="detail-header">
        <div className="detail-heading">
          <span className="detail-icon" aria-hidden="true">{detail.kind === 'tool' ? <Terminal /> : <Package />}</span>
          <h2><code>{detail.kind === 'command' ? `/${detail.item.name}` : detail.item.name}</code></h2>
          <p>{detail.item.description}</p>
        </div>
        <button className="icon-button" aria-label="关闭详情" title="关闭" onClick={() => setDetail(null)}><X /></button>
      </header>
      <div className="detail-body agent-tool-detail-body">
        <div className={`agent-tool-detail-state ${detailEnabled ? 'is-enabled' : ''}`}>
          {detail.kind === 'command' ? <Package aria-hidden="true" /> : detailEnabled ? <Check aria-hidden="true" /> : <CircleAlert aria-hidden="true" />}
          <strong>{detail.kind === 'command' ? '随扩展启停' : detailEnabled ? '已启用' : '已停用'}</strong>
          {detailChanged && <p>有未保存的更改，保存后生效。</p>}
        </div>
        {detail.item.originalDescription && <Accordion className="agent-tool-original" compact summary="查看作者原文">
          <p dir="auto">{detail.item.originalDescription}</p>
        </Accordion>}
        <dl className="detail-list">
          <div><dt>类型</dt><dd>{detail.kind === 'tool' ? '智能体工具' : '扩展命令'}</dd></div>
          {detail.item.source.baseDir && detail.item.source.baseDir !== detail.item.source.path && <div><dt>来源目录</dt><dd><code>{detail.item.source.baseDir}</code></dd></div>}
          {detail.kind === 'tool' && <div><dt>提供方式</dt><dd>{exposureLabel(detail.item.exposure)}</dd></div>}
          <div><dt>来源</dt><dd>{detail.item.source.label}</dd></div>
          <div><dt>来源类型</dt><dd>{SOURCE_KIND_LABEL[detail.item.source.kind]}</dd></div>
          <div><dt>范围</dt><dd>{scopeLabel(detail.item.source.scope)}</dd></div>
          <div><dt>标识</dt><dd><code>{detail.item.source.source || '未知'}</code></dd></div>
          <div><dt>路径</dt><dd>{detail.item.source.path ? <code>{detail.item.source.path}</code> : '—'}</dd></div>
        </dl>
      </div>
      <footer className="detail-footer">
        <span />
        <button className="settings-outline" onClick={() => setDetail(null)}>关闭</button>
        {detail.kind === 'tool' && <button className="settings-save" disabled={saving || loading} onClick={() => toggle(detail.item.name, !detailEnabled)}>{detailEnabled ? <X /> : <Check />}{detailEnabled ? '从草稿移除' : '加入草稿'}</button>}
      </footer>
    </DetailDialog>}
  </div>;
}
