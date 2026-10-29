import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  CircleAlert,
  LoaderCircle,
  Package,
  Plus,
  RefreshCw,
  Save,
  Terminal,
  Trash2,
  Wrench,
} from 'lucide-react';
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
  const visibleTools = (catalog?.tools || []).filter((tool) => (
    !query.trim()
    || `${tool.name} ${tool.description} ${tool.source.label}`.toLowerCase().includes(query.trim().toLowerCase())
  ));
  const groups = useMemo(() => {
    const grouped = new Map<string, {
      source: AgentToolSource;
      tools: AgentToolInfo[];
      commands: AgentToolCommand[];
    }>();
    for (const tool of visibleTools) {
      const current = grouped.get(tool.source.key);
      if (current) {
        current.tools.push(tool);
      } else {
        grouped.set(tool.source.key, {
          source: tool.source,
          tools: [tool],
          commands: (catalog?.commands || []).filter((command) => command.source.key === tool.source.key),
        });
      }
    }
    // A source can provide commands without exposing a model-callable tool.
    for (const command of catalog?.commands || []) {
      if (query.trim() && !`${command.name} ${command.description} ${command.source.label}`.toLowerCase().includes(query.trim().toLowerCase())) continue;
      if (grouped.has(command.source.key)) continue;
      grouped.set(command.source.key, {
        source: command.source,
        tools: [],
        commands: (catalog?.commands || []).filter((item) => item.source.key === command.source.key),
      });
    }
    return [...grouped.values()].sort((left, right) => {
      if (left.source.kind === 'core' && right.source.kind !== 'core') return -1;
      if (right.source.kind === 'core' && left.source.kind !== 'core') return 1;
      if (left.source.label === 'pi-subagents' && right.source.label !== 'pi-subagents') return -1;
      if (right.source.label === 'pi-subagents' && left.source.label !== 'pi-subagents') return 1;
      return left.source.label.localeCompare(right.source.label);
    });
  }, [catalog?.commands, query, visibleTools]);

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
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  }

  return <div className="settings-sections agent-tools-settings">
    <section className="settings-card">
      <div className="settings-card-head">
        <div>
          <h2>Agent 工具 <span className="count-badge">{draft.enabled.length}</span></h2>
          <p>决定模型能调用哪些工具。白名单只影响之后创建的会话，现有回答不会被中途改变。</p>
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
        <input className="agent-tool-search" aria-label="搜索 Agent 工具" placeholder="搜索工具或来源…" value={query} onChange={(event) => setQuery(event.target.value)} />
      </div>
      {loading && !catalog ? <div className="settings-loading" role="status"><LoaderCircle className="spin" />正在扫描可用工具…</div> : <div className="agent-tool-groups">
        {groups.map((group) => <section className="agent-tool-source" key={group.source.key}>
          <header>
            <span className="agent-tool-source-icon">{group.source.kind === 'core' ? <Wrench /> : <Package />}</span>
            <div><strong>{group.source.label}</strong><span>{SOURCE_KIND_LABEL[group.source.kind]} · {group.tools.length} 个工具{group.commands.length ? ` · ${group.commands.length} 个命令` : ''} · {group.source.scope === 'project' ? '当前项目' : '全局'}</span></div>
            <code title={group.source.source}>{group.source.source}</code>
          </header>
          <div className="agent-tool-list">
            {group.tools.map((tool) => <div className={`agent-tool-row ${enabled.has(tool.name) ? 'is-enabled' : ''}`} key={tool.name}>
              <span className="agent-tool-row-icon"><Terminal /></span>
              <div className="agent-tool-copy"><strong><code>{tool.name}</code></strong><span>{KNOWN_DESCRIPTIONS[tool.name] || tool.description || '暂无说明'}</span></div>
              <button className={`switch ${enabled.has(tool.name) ? 'is-on' : ''}`} role="switch" aria-checked={enabled.has(tool.name)} aria-label={`${enabled.has(tool.name) ? '禁用' : '允许'}工具 ${tool.name}`} onClick={() => toggle(tool.name, !enabled.has(tool.name))}><span /></button>
            </div>)}
            {group.commands.map((command) => <div className="agent-tool-row agent-command-row" key={`${group.source.key}:${command.name}`}>
              <span className="agent-tool-row-icon"><Terminal /></span>
              <div className="agent-tool-copy"><strong><code>/{command.name}</code></strong><span>{command.description || '扩展命令'} · 随扩展加载</span></div>
              <code className="agent-command-kind">命令</code>
            </div>)}
          </div>
        </section>)}
        {!groups.length && <div className="settings-empty">{query ? '没有匹配的工具。' : '当前工作区没有检测到可配置工具。'}</div>}
      </div>}
      <div className="agent-tool-custom">
        <div><strong>手动添加工具</strong><span>扩展尚未加载时，可以先写入工具名；SDK 会在工具实际存在时启用它。</span></div>
        <div className="agent-tool-custom-control"><input value={customName} placeholder="例如 mcp__docs__search" onChange={(event) => setCustomName(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') addCustomTool(); }} /><button className="settings-outline" disabled={!customName.trim()} onClick={addCustomTool}><Plus />添加</button></div>
      </div>
    </section>

    {error && <div className="settings-error" role="alert">{error}</div>}
    <div className="agent-tool-savebar">
      <div><strong>{dirty ? '有未保存的更改' : '已与本地文件同步'}</strong><span>保存后，新建会话会使用这份工具白名单。</span></div>
      <button className="settings-outline" disabled={saving || !dirty} onClick={resetRecommended}>恢复核心工具</button>
      <button className="settings-save" disabled={saving || !dirty} onClick={() => void save()}>{saving ? <LoaderCircle className="spin" /> : <Save />}{saving ? '正在保存…' : '保存更改'}</button>
    </div>
  </div>;
}
