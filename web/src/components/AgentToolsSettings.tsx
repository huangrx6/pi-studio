import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import {
  ArrowUpRight,
  Check,
  CircleAlert,
  LoaderCircle,
  Package,
  Plus,
  RefreshCw,
  Save,
  Terminal,
  Trash2,
  Wrench,
  X,
} from 'lucide-react';
import { DetailDialog } from './DetailDialog';
import type {
  AgentToolCatalog,
  AgentToolCommand,
  AgentToolInfo,
  AgentToolSelection,
  AgentToolSource,
} from '../agent-tool-types';

const RECOMMENDED_TOOLS = ['read', 'write', 'edit', 'bash', 'grep', 'find', 'ls'];
const KNOWN_DESCRIPTIONS: Record<string, string> = {
  read: '读取工作区文件。',
  write: '创建或覆盖文件。',
  edit: '精确修改文件内容。',
  bash: '执行终端命令。',
  grep: '搜索文件内容。',
  find: '按名称查找文件。',
  ls: '浏览目录结构。',
  subagents_enable: '为支持动态工具的模型加载完整子 Agent 能力。',
  subagent: '启动前台、并行或链式工作的子 Agent。',
  contact_supervisor: '让子 Agent 向父 Agent 提问或汇报。',
  subagent_supervisor: '查看并回复正在工作的子 Agent。',
  bg_wait: '等待后台子 Agent 完成，或读取当前状态。',
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

function selectionFromSources(enabled: string[], sources: Record<string, AgentToolInfo['source']>, previous: AgentToolSelection): AgentToolSelection {
  return {
    enabled,
    sources: Object.fromEntries(enabled.map((name) => {
      const source = sources[name];
      if (source) {
        return [name, {
          source: source.source,
          label: source.label,
          scope: source.scope,
          path: source.path,
          baseDir: source.baseDir,
        }];
      }
      const stored = previous.sources[name];
      return [name, stored || {
        source: 'manual',
        label: '手动添加',
        scope: 'manual',
        path: '',
        baseDir: '',
      }];
    })),
  };
}

export function AgentToolsSettings({ cwd, initialSelection, configPath, onSaved }: {
  cwd: string;
  initialSelection: AgentToolSelection;
  configPath: string;
  onSaved: (snapshot: { agentTools: AgentToolSelection }) => void;
}) {
  const [selection, setSelection] = useState(initialSelection);
  const [draft, setDraft] = useState(initialSelection);
  const [catalog, setCatalog] = useState<AgentToolCatalog | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [customName, setCustomName] = useState('');
  const [activeSourceKey, setActiveSourceKey] = useState('');
  const [detail, setDetail] = useState<AgentToolDetail | null>(null);
  const requestRef = useRef(0);

  const loadCatalog = useCallback(async (refresh = false) => {
    const request = ++requestRef.current;
    setLoading(true);
    setError(null);
    try {
      const result = await window.piApi.agentToolCatalog({ cwd, refresh });
      if (request === requestRef.current) setCatalog(result);
    } catch (cause) {
      if (request === requestRef.current) setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (request === requestRef.current) setLoading(false);
    }
  }, [cwd]);

  useEffect(() => {
    setSelection(initialSelection);
    setDraft(initialSelection);
  }, [initialSelection]);

  useEffect(() => {
    // Settings is often opened immediately after an extension change, so start
    // from the current runtime instead of a stale in-memory discovery session.
    void loadCatalog(true);
  }, [loadCatalog]);

  const catalogSources = useMemo(
    () => Object.fromEntries((catalog?.tools || []).map((tool) => [tool.name, tool.source])),
    [catalog],
  );
  const availableNames = useMemo(() => new Set((catalog?.tools || []).map((tool) => tool.name)), [catalog]);
  const enabled = new Set(draft.enabled);
  const dirty = JSON.stringify(draft) !== JSON.stringify(selection);
  const unavailable = draft.enabled.filter((name) => name !== '*' && !availableNames.has(name));
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
      if (left.source.label === 'pi-subagents' && right.source.label !== 'pi-subagents') return -1;
      if (right.source.label === 'pi-subagents' && left.source.label !== 'pi-subagents') return 1;
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
  const detailEnabled = detailIsTool && enabled.has(detail.item.name);

  function updateEnabled(next: string[]) {
    setDraft((current) => selectionFromSources(next, catalogSources, current));
  }

  function toggle(name: string, checked: boolean) {
    updateEnabled(checked
      ? [...draft.enabled.filter((item) => item !== '*'), ...(draft.enabled.includes(name) ? [] : [name])]
      : draft.enabled.filter((item) => item !== name));
  }

  function addCustomTool() {
    const name = customName.trim();
    if (!/^[A-Za-z0-9_.:-]+$/.test(name) || ['__proto__', 'prototype', 'constructor'].includes(name)) {
      setError('工具名只能包含字母、数字、点、横线、下划线或冒号。');
      return;
    }
    if (draft.enabled.includes(name)) {
      setCustomName('');
      return;
    }
    setError(null);
    updateEnabled([...draft.enabled, name]);
    setCustomName('');
  }

  function resetRecommended() {
    setDraft(selectionFromSources(RECOMMENDED_TOOLS, catalogSources, draft));
  }

  async function save() {
    setSaving(true);
    setError(null);
    try {
      const snapshot = await window.piApi.setAgentTools({ tools: draft, cwd });
      setSelection(snapshot.agentTools);
      setDraft(snapshot.agentTools);
      onSaved(snapshot);
      // The whitelist can change which extension tools are discoverable.
      void loadCatalog(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
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
    <section className="settings-card">
      <div className="settings-card-head">
        <div>
          <h2>Agent 工具 <span className="count-badge">{draft.enabled.length}</span></h2>
          <p>决定模型能调用哪些工具。保存后会热更新已打开的会话；正在回答的会话在本轮结束后自动应用。</p>
        </div>
        <button className="settings-add-button" disabled={loading} onClick={() => void loadCatalog(true)}>
          {loading ? <LoaderCircle className="spin" /> : <RefreshCw />}
          刷新目录
        </button>
      </div>
      <div className="agent-tool-summary">
        <span><Wrench />{draft.enabled.length} 个已允许</span>
        <span><Package />{catalog?.tools.length ?? 0} 个已检测到</span>
        <span><Terminal />{catalog?.commands.length ?? 0} 个扩展命令</span>
      </div>
      <div className="agent-tool-config-path">
        <span>同步文件</span>
        <code title={configPath}>{configPath}</code>
      </div>
      <p className="agent-tool-source-note">
        工具可能来自 Pi 核心、扩展包或本地扩展。这里保留已经选择的工具；卸载来源扩展后，它会显示为不可用，重新安装后自动恢复。
      </p>
    </section>

    {(catalog?.errors.length || catalog?.warnings.length) ? <section className="settings-card agent-tool-diagnostics">
      <div className="settings-card-head"><div><h2>扩展诊断</h2><p>加载失败的工具不会出现在下方目录中。</p></div></div>
      {[...(catalog?.errors || []), ...(catalog?.warnings || [])].map((item, index) => (
        <div className="agent-tool-diagnostic" key={`${item.path}-${index}`}>
          <CircleAlert />
          <div><strong>{item.path || '扩展加载'}</strong><span>{item.message}</span></div>
        </div>
      ))}
    </section> : null}

    {unavailable.length > 0 && <section className="settings-card">
      <div className="settings-card-head"><div><h2>当前不可用 <span className="count-badge">{unavailable.length}</span></h2><p>这些工具仍在本地白名单中，但当前没有找到提供它的扩展。</p></div></div>
      <div className="agent-tool-unavailable-list">
        {unavailable.map((name) => {
          const source = toolSource(draft, name);
          return <div className="agent-tool-unavailable" key={name}>
            <CircleAlert />
            <div><code>{name}</code><span>{source.label} · {source.source}</span></div>
            <button className="icon-button resource-delete" aria-label={`移除不可用工具 ${name}`} title="从白名单移除" onClick={() => toggle(name, false)}><Trash2 /></button>
          </div>;
        })}
      </div>
    </section>}

    <section className="settings-card">
      <div className="settings-card-head">
        <div><h2>可用工具</h2><p>工具与斜杠命令按提供者分组；扩展被移除后，它注册的命令也会一起消失。</p></div>
        <div className="agent-tool-search-wrap">
          <input className="agent-tool-search" aria-label="搜索 Agent 工具" placeholder="搜索工具或来源…" value={query} onChange={(event) => setQuery(event.target.value)} />
          {query && <button className="agent-tool-search-clear" aria-label="清除工具搜索" title="清除搜索" onClick={() => setQuery('')}><X /></button>}
        </div>
      </div>
      {loading && !catalog ? <div className="settings-loading" role="status"><LoaderCircle className="spin" />正在扫描可用工具…</div> : <div className="agent-tool-groups">
        {groups.length > 0 && <>
          <div className="agent-tool-tabs" role="tablist" aria-label="工具来源">
            {groups.map((group, index) => {
              const active = group.key === activeGroup?.key;
              return <button
                id={`agent-tool-tab-${index}`}
                type="button"
                role="tab"
                aria-selected={active}
                aria-controls="agent-tool-source-panel"
                tabIndex={active ? 0 : -1}
                className={`agent-tool-tab ${active ? 'is-active' : ''}`}
                key={group.key}
                onClick={() => setActiveSourceKey(group.key)}
                onKeyDown={(event) => onSourceTabKeyDown(event, index)}
              >
                <span className="agent-tool-tab-icon">{group.source.kind === 'core' ? <Wrench /> : <Package />}</span>
                <span className="agent-tool-tab-copy"><strong>{group.source.label}</strong><small>{SOURCE_KIND_LABEL[group.source.kind]} · {scopeLabel(group.source.scope)}</small></span>
                <span className="agent-tool-tab-count" title={`${group.tools.length} 个工具，${group.commands.length} 个命令`}>{group.tools.length + group.commands.length}</span>
              </button>;
            })}
          </div>
          {activeGroup && <section id="agent-tool-source-panel" role="tabpanel" aria-labelledby={`agent-tool-tab-${groups.indexOf(activeGroup)}`} className="agent-tool-source-panel">
            <header className="agent-tool-source-panel-head">
              <div>
                <span className="agent-tool-source-icon">{activeGroup.source.kind === 'core' ? <Wrench /> : <Package />}</span>
                <div><strong>{activeGroup.source.label}</strong><span>{SOURCE_KIND_LABEL[activeGroup.source.kind]} · {scopeLabel(activeGroup.source.scope)} · {activeGroup.tools.length} 个工具{activeGroup.commands.length ? ` · ${activeGroup.commands.length} 个命令` : ''}</span></div>
              </div>
              {(activeGroup.source.path || activeGroup.source.source) && <code title={activeGroup.source.path || activeGroup.source.source}>{activeGroup.source.path || activeGroup.source.source}</code>}
            </header>
            <div className="agent-tool-card-grid">
              {activeGroup.tools.map((tool) => {
                const isEnabled = enabled.has(tool.name);
                return <article className={`agent-tool-card ${isEnabled ? 'is-enabled' : ''}`} key={tool.name}>
                  <button type="button" className="agent-tool-card-main" aria-label={`查看工具 ${tool.name} 详情`} onClick={() => setDetail({ kind: 'tool', item: tool })}>
                    <span className="agent-tool-card-topline">
                      <span className="agent-tool-card-icon"><Terminal /></span>
                      <span className="agent-tool-card-type">{exposureLabel(tool.exposure)}</span>
                    </span>
                    <span className="agent-tool-card-name"><code>{tool.name}</code>{isEnabled && <Check aria-label="已允许" />}</span>
                    <span className="agent-tool-card-description">{KNOWN_DESCRIPTIONS[tool.name] || tool.description || '暂无说明'}</span>
                    <span className="agent-tool-card-footer"><span>{isEnabled ? '已允许模型调用' : '当前已停用'}</span><span>详情 <ArrowUpRight /></span></span>
                  </button>
                  <button
                    className={`switch agent-tool-card-toggle ${isEnabled ? 'is-on' : ''}`}
                    type="button"
                    role="switch"
                    aria-checked={isEnabled}
                    aria-label={`${isEnabled ? '禁用' : '允许'}工具 ${tool.name}`}
                    onClick={() => toggle(tool.name, !isEnabled)}
                  ><span /></button>
                </article>;
              })}
              {activeGroup.commands.map((command) => <article className="agent-tool-card is-command" key={`${activeGroup.source.key}:${command.name}`}>
                <button type="button" className="agent-tool-card-main" aria-label={`查看扩展命令 ${command.name} 详情`} onClick={() => setDetail({ kind: 'command', item: command })}>
                  <span className="agent-tool-card-topline">
                    <span className="agent-tool-card-icon"><Terminal /></span>
                    <span className="agent-tool-card-type">扩展命令</span>
                  </span>
                  <span className="agent-tool-card-name"><code>/{command.name}</code></span>
                  <span className="agent-tool-card-description">{command.description || '由扩展注册的斜杠命令。'}</span>
                  <span className="agent-tool-card-footer"><span>随扩展加载</span><span>详情 <ArrowUpRight /></span></span>
                </button>
              </article>)}
            </div>
          </section>}
        </>}
        {!groups.length && <div className="settings-empty">{query ? '没有匹配的工具。' : '当前工作区没有检测到可配置工具。'}</div>}
      </div>}
      <div className="agent-tool-custom">
        <div><strong>手动添加工具</strong><span>扩展尚未加载时，可以先写入工具名；SDK 会在工具实际存在时启用它。</span></div>
        <div className="agent-tool-custom-control"><input value={customName} placeholder="例如 mcp__docs__search" onChange={(event) => setCustomName(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') addCustomTool(); }} /><button className="settings-outline" disabled={!customName.trim()} onClick={addCustomTool}><Plus />添加</button></div>
      </div>
    </section>

    {error && <div className="settings-error" role="alert">{error}</div>}
    <div className="agent-tool-savebar">
      <div><strong>{dirty ? '有未保存的更改' : '已与本地文件同步'}</strong><span>保存后会热更新会话运行时，无需退出或重新启动 App。</span></div>
      <button className="settings-outline" disabled={saving || !dirty} onClick={resetRecommended}>恢复核心工具</button>
      <button className="settings-save" disabled={saving || !dirty} onClick={() => void save()}>{saving ? <LoaderCircle className="spin" /> : <Save />}{saving ? '正在保存…' : '保存更改'}</button>
    </div>

    {detail && <DetailDialog className="agent-tool-detail-dialog" onClose={() => setDetail(null)}>
      <header className="detail-header">
        <div className="detail-heading">
          <span className="detail-icon">{detail.kind === 'tool' ? <Terminal /> : <Package />}</span>
          <div>
            <h2><code>{detail.kind === 'command' ? `/${detail.item.name}` : detail.item.name}</code></h2>
            <p>{detail.item.description || (detail.kind === 'command' ? '由扩展注册的斜杠命令。' : '暂无工具说明。')}</p>
          </div>
        </div>
        <button className="icon-button" aria-label="关闭详情" title="关闭" onClick={() => setDetail(null)}><X /></button>
      </header>
      <div className="detail-body agent-tool-detail-body">
        <div className={`agent-tool-detail-state ${detailEnabled ? 'is-enabled' : ''}`}>
          <span>{detailEnabled ? <Check /> : <CircleAlert />}</span>
          <div><strong>{detail.kind === 'command' ? '由扩展管理' : detailEnabled ? '已在当前草稿中允许' : '当前草稿中已停用'}</strong><p>{detail.kind === 'command' ? '斜杠命令随提供它的扩展一起加载，不能单独启停。' : '这里的开关只修改当前草稿；点击页面底部的“保存更改”后会同步到 Pi，并热更新会话运行时。'}</p></div>
        </div>
        <dl className="detail-list">
          <div><dt>类型</dt><dd>{detail.kind === 'tool' ? 'Agent 工具' : '扩展命令'}</dd></div>
          {detail.kind === 'tool' && <div><dt>提供方式</dt><dd>{exposureLabel(detail.item.exposure)}</dd></div>}
          <div><dt>来源</dt><dd>{detail.item.source.label}</dd></div>
          <div><dt>来源类型</dt><dd>{SOURCE_KIND_LABEL[detail.item.source.kind]}</dd></div>
          <div><dt>范围</dt><dd>{scopeLabel(detail.item.source.scope)}</dd></div>
          <div><dt>标识</dt><dd><code>{detail.item.source.source || '未知'}</code></dd></div>
          <div><dt>路径</dt><dd>{detail.item.source.path ? <code>{detail.item.source.path}</code> : '由 Pi 运行时直接提供，没有单独文件路径。'}</dd></div>
        </dl>
      </div>
      <footer className="detail-footer">
        <span>{detail.kind === 'command' ? '命令的可用性会跟随扩展状态。' : dirty ? '此操作会进入未保存的更改。' : '当前工具配置已同步。'}</span>
        <button className="settings-outline" onClick={() => setDetail(null)}>关闭</button>
        {detail.kind === 'tool' && <button className="settings-save" onClick={() => toggle(detail.item.name, !detailEnabled)}>{detailEnabled ? <X /> : <Check />}{detailEnabled ? '停用此工具' : '允许此工具'}</button>}
      </footer>
    </DetailDialog>}
  </div>;
}
