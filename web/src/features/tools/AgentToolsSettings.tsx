import { useSettingsDraftGuard } from '../../shared/SettingsDraftGuard';
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import {
  ChevronRight,
  Check,
  CircleAlert,
  LoaderCircle,
  Package,
  Search,
  Terminal,
  Trash2,
  Wrench,
  X,
} from 'lucide-react';
import { DetailDialog } from '../../shared/DetailDialog';
import { InfoHint } from '../../shared/InfoHint';
import { SettingsPageHeader } from '../../shared/SettingsPageHeader';
import { patternMatches, sameToolNames, selectionFromSources, toggleToolSelection } from './agent-tool-selection';
import './agent-tools-settings.css';
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

const RECOMMENDED_TOOLS = ['read', 'write', 'edit', 'bash', 'grep', 'find', 'ls', 'tool_search', 'mcp__*'];
const KNOWN_DESCRIPTIONS: Record<string, string> = {
  read: '读取工作区文件。',
  write: '创建或覆盖文件。',
  edit: '精确修改文件内容。',
  bash: '执行终端命令。',
  grep: '搜索文件内容。',
  find: '按名称查找文件。',
  ls: '浏览目录结构。',
  tool_search: '按需发现 deferred MCP 工具；匹配工具从下一次模型请求起可用。',
  'mcp__*': '允许所有已连接 MCP 服务器的工具；可按来源或单个工具收窄。',
};

const SOURCE_KIND_LABEL: Record<AgentToolSource['kind'], string> = {
  core: 'Pi 核心',
  package: '扩展包',
  git: 'Git 扩展',
  local: '本地扩展',
  inline: 'Studio 内置',
  extension: '扩展',
};

type AgentToolGroupItem = {
  key: string;
  source: AgentToolSource;
  tools: AgentToolInfo[];
  commands: AgentToolCommand[];
};

type AgentToolDetail = {
  kind: 'tool';
  item: AgentToolInfo;
} | {
  kind: 'command';
  item: AgentToolCommand;
};

/**
 * Provider identity is broader than a single tool file. In particular, every
 * built-in tool can report a different path, so grouping by source.key alone
 * would repeat the “Pi 核心” heading once per tool.
 */
function sourceGroupKey(source: AgentToolSource): string {
  if (source.kind === 'core') return 'core';
  if (source.kind === 'package' || source.kind === 'git') {
    return `${source.kind}:${source.scope}:${source.source}`;
  }
  return `${source.kind}:${source.scope}:${source.source}:${source.baseDir || source.path || source.label}`;
}

function scopeLabel(scope: string): string {
  if (scope === 'project') return '当前项目';
  if (scope === 'manual') return '手动添加';
  return '全局';
}

function exposureLabel(exposure: string): string {
  if (exposure === 'direct') return '直接提供';
  if (exposure === 'on-demand') return '按需加载';
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

export function AgentToolsSettings({ cwd, initialSelection, onSaved }: {
  cwd: string;
  initialSelection: AgentToolSelection;
  onSaved: (snapshot: { agentTools: AgentToolSelection }) => void;
}) {
  const [selection, setSelection] = useState(initialSelection);
  const [draft, setDraft] = useState(initialSelection);
  const [catalog, setCatalog] = useState<AgentToolCatalog | null>(null);
  const [loading, setLoading] = useState(true);
  const writeState = useSyncExternalStore(toolWrites.subscribe, toolWrites.getSnapshot);
  const saving = writeState.pending;
  const [error, setError] = useState<string | null>(null);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [notice, setNotice] = useState('');
  const [query, setQuery] = useState('');
  const [customName, setCustomName] = useState('');
  const [activeSourceKey, setActiveSourceKey] = useState('');
  const [detail, setDetail] = useState<AgentToolDetail | null>(null);
  const requestRef = useRef(0);
  const contextRef = useRef(cwd);
  contextRef.current = cwd;
  const lifecycleRef = useRef(0);
  const selectionRef = useRef(initialSelection);


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
    setSelection(initialSelection);
    setDraft(current => JSON.stringify(current) === JSON.stringify(previous) ? initialSelection : current);
    selectionRef.current = initialSelection;
  }, [initialSelection]);

  useEffect(() => {
    // Settings is often opened immediately after an extension change, so start
    // from the current runtime instead of a stale in-memory discovery session.
    setCatalog(null);
    setDetail(null);
    setError(null);
    setNotice('');
    void loadCatalog(true);
    return () => { requestRef.current += 1; lifecycleRef.current += 1; };
  }, [loadCatalog]);

  useEffect(() => {
    if (!writeState.failure) return;
    setDraft(writeState.failure.draft);
    setError(writeState.failure.message);
    setNotice('');
  }, [writeState.failure, cwd]);

  const catalogSources = useMemo(
    () => Object.fromEntries((catalog?.tools || []).map((tool) => [tool.name, tool.source])),
    [catalog],
  );
  const availableNames = useMemo(() => new Set((catalog?.tools || []).map((tool) => tool.name)), [catalog]);
  const dirty = JSON.stringify(draft) !== JSON.stringify(selection);
  useSettingsDraftGuard({ label: '工具选择', dirty, saving });
  const wildcardRules = draft.enabled.filter((name) => name.includes('*'));
  const recommendedSelected = sameToolNames(draft.enabled, RECOMMENDED_TOOLS);
  const unavailable = catalog ? draft.enabled.filter(name => !name.includes('*') && !availableNames.has(name)) : [];
  const groups = useMemo<AgentToolGroupItem[]>(() => {
    const needle = query.trim().toLowerCase();
    const matches = (name: string, description: string, source: AgentToolSource) => (
      !needle || `${name} ${description} ${source.label}`.toLowerCase().includes(needle)
    );
    const grouped = new Map<string, AgentToolGroupItem>();
    const ensureGroup = (source: AgentToolSource) => {
      const key = sourceGroupKey(source);
      const current = grouped.get(key);
      if (current) {
        return current;
      }
      const created = { key, source, tools: [], commands: [] };
      grouped.set(key, created);
      return created;
    };

    for (const tool of catalog?.tools || []) {
      if (!matches(tool.name, tool.description, tool.source)) continue;
      ensureGroup(tool.source).tools.push(tool);
    }

    // Commands are shown in the same provider deck. They remain read-only
    // because their lifetime is controlled by the extension that registers them.
    for (const command of catalog?.commands || []) {
      if (!matches(command.name, command.description, command.source)) continue;
      ensureGroup(command.source).commands.push(command);
    }

    return [...grouped.values()].sort((left, right) => {
      if (left.source.kind === 'core' && right.source.kind !== 'core') return -1;
      if (right.source.kind === 'core' && left.source.kind !== 'core') return 1;
      return left.source.label.localeCompare(right.source.label);
    });
  }, [catalog?.commands, catalog?.tools, query]);

  useEffect(() => {
    if (!groups.length) {
      if (activeSourceKey) setActiveSourceKey('');
      return;
    }
    if (!groups.some((group) => group.key === activeSourceKey)) {
      setActiveSourceKey(groups[0].key);
    }
  }, [activeSourceKey, groups]);

  const activeGroup = groups.find((group) => group.key === activeSourceKey) || groups[0];
  const detailIsTool = detail?.kind === 'tool';
  const selectionEnables = (name: string) => draft.enabled.some((pattern) => patternMatches(pattern, name));
  const detailEnabled = detailIsTool && selectionEnables(detail.item.name);

  function updateEnabled(next: string[]) {
    if (toolWrites.getSnapshot().pending) return;
    toolWrites.clearFailure();
    setError(null);
    setNotice('');
    setDraft((current) => selectionFromSources(next, catalogSources, current));
  }

  function toggle(name: string, checked: boolean) {
    if (toolWrites.getSnapshot().pending) return;
    const expandsWildcard = !checked && draft.enabled.some(rule => rule.includes('*') && patternMatches(rule, name));
    updateEnabled(toggleToolSelection(draft.enabled, (catalog?.tools || []).map(tool => tool.name), name, checked));
    if (expandsWildcard) setNotice('已将匹配的通配规则展开为当前检测到的其他工具；保存后，新出现的匹配工具将不再自动允许。');
  }

  function addCustomTool() {
    if (toolWrites.getSnapshot().pending) return;
    const name = customName.trim();
    if (!/^[A-Za-z0-9_.:*\-]+$/.test(name) || ['__proto__', 'prototype', 'constructor'].includes(name)) {
      setError('工具名或通配符只能包含字母、数字、点、横线、下划线、冒号或星号。');
      return;
    }
    if (draft.enabled.includes(name)) {
      setCustomName('');
      return;
    }
    // Keep unresolved names in the allow-list draft. The SDK will activate them
    // automatically once the matching extension tool appears in discovery.
    setError(null);
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
    setError(null);
    setNotice('');
    try {
      const snapshot = await toolWrites.run(draft, () => window.piApi.setAgentTools({ tools: draft, cwd }));
      // The saved selection is global even if this editor has since closed.
      onSaved(snapshot);
      const refreshFailure = runtimeRefreshFailure(snapshot.runtimeRefresh);
      if (refreshFailure) toolWrites.reportSavedWarning(snapshot.agentTools, refreshFailure);
      if (!current()) return;
      setSelection(snapshot.agentTools);
      setDraft(snapshot.agentTools);
      selectionRef.current = snapshot.agentTools;
      if (refreshFailure) setError(refreshFailure);
      else setNotice(snapshot.runtimeRefresh?.pendingSessions ? '配置已保存，运行中的会话将在本轮结束后应用。' : '配置已保存。');
      void loadCatalog(true);
    } catch (cause) {
      if (current()) setError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  function activateSourceTab(index: number) {
    const group = groups[index];
    if (!group) return;
    setActiveSourceKey(group.key);
    requestAnimationFrame(() => document.getElementById(`agent-tool-tab-${index}`)?.focus());
  }

  function onSourceTabKeyDown(event: ReactKeyboardEvent<HTMLButtonElement>, index: number) {
    let nextIndex: number | null = null;
    if (event.key === 'ArrowRight') nextIndex = (index + 1) % groups.length;
    if (event.key === 'ArrowLeft') nextIndex = (index - 1 + groups.length) % groups.length;
    if (event.key === 'Home') nextIndex = 0;
    if (event.key === 'End') nextIndex = groups.length - 1;
    if (nextIndex === null) return;
    event.preventDefault();
    activateSourceTab(nextIndex);
  }

  return <div className="settings-sections agent-tools-settings">
    <SettingsPageHeader icon={<Wrench />} title="智能体工具" actions={<button type="button" className="settings-outline" disabled={loading || saving} onClick={() => void loadCatalog(true)}>{loading && <LoaderCircle className="spin" />}刷新目录</button>} />
    <div className="agent-tool-save-bar">
      <div><p>全局配置 · 保存后应用于所有工作区。</p><span role="status">{saving ? '正在保存…' : dirty ? '有未保存的更改' : '与已保存配置一致'}</span></div>
      <div className="agent-tool-toolbar-actions">
        <button type="button" className="settings-text-button" disabled={saving || !dirty} onClick={() => { toolWrites.clearFailure(); setDraft(selection); setError(null); setNotice(''); }}>撤销更改</button>
        <button type="button" className="settings-outline" disabled={saving || recommendedSelected} title={recommendedSelected ? '当前已是推荐配置' : undefined} onClick={resetRecommended}>恢复推荐配置</button>
        <button type="button" className="settings-save" disabled={saving || !dirty} onClick={() => void save()}>{saving ? '正在保存…' : '保存更改'}</button>
      </div>
    </div>
    {error && <div className="settings-error" role="alert">{error}</div>}
    {notice && <p className="agent-tool-notice" role="status">{notice}</p>}
    {(catalog?.errors.length || catalog?.warnings.length) ? <details className="agent-tool-diagnostics">
      <summary>扩展诊断 · {(catalog?.errors.length || 0) + (catalog?.warnings.length || 0)} 项</summary>
      {[...(catalog?.errors || []), ...(catalog?.warnings || [])].map((item, index) => <div className="agent-tool-diagnostic" key={`${item.path}-${index}`}><code>{item.path || '扩展加载'}</code><p>{item.message}</p></div>)}
    </details> : null}
    {wildcardRules.length > 0 && <section className="agent-tool-section" aria-label="批量工具规则">
      <h2>批量工具规则 <InfoHint label="通配符也允许以后出现的匹配工具。停用其中一个工具，会把该规则展开成当前检测到的其他工具。" /></h2>
      <ul className="agent-tool-rule-list">{wildcardRules.map(name => <li key={name}>
        <div><code>{name}</code><p>{name === '*' ? '允许所有当前和未来检测到的工具' : KNOWN_DESCRIPTIONS[name] || '允许所有匹配此名称的工具'}{catalog && <span> · 当前匹配 {catalog.tools.filter(tool => patternMatches(name, tool.name)).length} 个</span>}</p></div>
        <button type="button" className="icon-button" disabled={saving} aria-label={`移除工具规则 ${name}`} title="移除规则" onClick={() => updateEnabled(draft.enabled.filter(item => item !== name))}><Trash2 /></button>
      </li>)}</ul>
    </section>}
    {unavailable.length > 0 && <section className="agent-tool-section" aria-label="当前未检测到的工具">
      <h2>当前未检测到 <InfoHint label="这些名称仍保留在配置中，工具重新出现后会被允许。" /></h2>
      <ul className="agent-tool-rule-list">{unavailable.map(name => {
        const source = toolSource(draft, name);
        return <li key={name}><div><code>{name}</code><p>{source.label} · {source.source}</p></div><button type="button" className="icon-button" disabled={saving} aria-label={`移除不可用工具 ${name}`} title="从配置移除" onClick={() => toggle(name, false)}><Trash2 /></button></li>;
      })}</ul>
    </section>}
    <section className="agent-tool-section" aria-label="工具目录">
      <div className="agent-tool-catalog-heading"><h2>工具目录</h2>{catalog && <span>{catalog.tools.length} 个工具 · {catalog.commands.length} 个扩展命令</span>}</div>
      <div className="agent-tool-search-wrap"><Search aria-hidden="true" /><input className="agent-tool-search" aria-label="搜索智能体工具" placeholder="搜索工具、命令或来源…" value={query} onChange={event => setQuery(event.target.value)} />{query && <button type="button" aria-label="清除工具搜索" title="清除搜索" onClick={() => setQuery('')}><X /></button>}</div>
      {catalogError && <div className="agent-tool-catalog-error"><p role="alert">{catalogError}</p><button type="button" className="settings-text-button" disabled={loading || saving} onClick={() => void loadCatalog(true)}>重新加载工具目录</button>{catalog && <small>显示上次成功读取的目录。</small>}</div>}
      {loading && !catalog ? <p className="agent-tool-loading" role="status"><LoaderCircle className="spin" />正在读取工具目录…</p> : <div className="agent-tool-groups">
        {groups.length > 0 && <>
          <div className="agent-tool-tabs" role="tablist" aria-label="工具来源">{groups.map((group, index) => {
            const active = group.key === activeGroup?.key;
            return <button id={`agent-tool-tab-${index}`} type="button" role="tab" aria-selected={active} aria-controls="agent-tool-source-panel" tabIndex={active ? 0 : -1} key={group.key} onClick={() => setActiveSourceKey(group.key)} onKeyDown={event => onSourceTabKeyDown(event, index)}>{group.source.label}<span>{group.tools.length + group.commands.length}</span></button>;
          })}</div>
          {activeGroup && <section id="agent-tool-source-panel" role="tabpanel" aria-labelledby={`agent-tool-tab-${groups.indexOf(activeGroup)}`}>
            <div className="agent-tool-source-meta"><span>{SOURCE_KIND_LABEL[activeGroup.source.kind]} · {scopeLabel(activeGroup.source.scope)}</span>{(activeGroup.source.path || activeGroup.source.source) && <details><summary>来源位置</summary><code>{activeGroup.source.path || activeGroup.source.source}</code></details>}</div>
            <ul className="agent-tool-list">
              {activeGroup.tools.map(tool => {
                const enabled = selectionEnables(tool.name);
                return <li className="agent-tool-row" key={tool.name}><div><button type="button" className="agent-tool-open" aria-label={`查看工具 ${tool.name} 详情`} onClick={() => setDetail({ kind: 'tool', item: tool })}><code>{tool.name}</code><ChevronRight /></button><p>{KNOWN_DESCRIPTIONS[tool.name] || tool.description}</p><small>{exposureLabel(tool.exposure)}</small></div><button className={`switch ${enabled ? 'is-on' : ''}`} type="button" role="switch" aria-checked={enabled} disabled={saving || loading} aria-label={`${enabled ? '禁用' : '允许'}工具 ${tool.name}`} onClick={() => toggle(tool.name, !enabled)}><span /></button></li>;
              })}
              {activeGroup.commands.map(command => <li className="agent-tool-row" key={`command:${command.name}`}><div><button type="button" className="agent-tool-open" aria-label={`查看扩展命令 ${command.name} 详情`} onClick={() => setDetail({ kind: 'command', item: command })}><code>/{command.name}</code><ChevronRight /></button><p>{command.description}</p><small>扩展命令 · 随扩展启停</small></div></li>)}
            </ul>
          </section>}
        </>}
        {!groups.length && catalog && <p className="agent-tool-empty">{query ? '没有匹配的工具或命令。' : '当前工作区没有检测到可配置工具。'}</p>}
      </div>}
      <div className="agent-tool-custom"><div><label htmlFor="agent-tool-custom-name">手动添加</label><InfoHint label="可以提前保存尚未加载的工具名或通配符；工具出现后会被允许。" /></div><div className="agent-tool-custom-control"><input id="agent-tool-custom-name" value={customName} disabled={saving} placeholder="例如 mcp__docs__*" onChange={event => setCustomName(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && !isComposingKey(event.nativeEvent)) addCustomTool(); }} /><button type="button" className="settings-outline" disabled={saving || !customName.trim()} onClick={addCustomTool}>添加</button></div></div>
    </section>

    {detail && <DetailDialog className="agent-tool-detail-dialog" onClose={() => setDetail(null)}>
      <header className="detail-header">
        <div className="detail-heading">
          <span className="detail-icon">{detail.kind === 'tool' ? <Terminal /> : <Package />}</span>
          <div>
            <h2><code>{detail.kind === 'command' ? `/${detail.item.name}` : detail.item.name}</code></h2>
            {detail.item.description && <p>{detail.item.description}</p>}
          </div>
        </div>
        <button className="icon-button" aria-label="关闭详情" title="关闭" onClick={() => setDetail(null)}><X /></button>
      </header>
      <div className="detail-body agent-tool-detail-body">
        <div className={`agent-tool-detail-state ${detailEnabled ? 'is-enabled' : ''}`}>
          <span>{detailEnabled ? <Check /> : <CircleAlert />}</span>
          <div><strong>{detail.kind === 'command' ? '由扩展管理' : detailEnabled ? '已在草稿中允许' : '已在草稿中停用'}</strong><p>{detail.kind === 'command' ? '随扩展启停。' : '保存后生效。'}</p></div>
        </div>
        <dl className="detail-list">
          <div><dt>类型</dt><dd>{detail.kind === 'tool' ? '智能体工具' : '扩展命令'}</dd></div>
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
