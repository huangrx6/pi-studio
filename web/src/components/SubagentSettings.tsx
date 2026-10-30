import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Bot,
  Check,
  CircleAlert,
  FolderTree,
  Info,
  Layers3,
  LoaderCircle,
  RotateCw,
  Save,
  Sparkles,
  Undo2,
  Wrench,
} from 'lucide-react';
import type { AgentToolInfo, AgentToolSource } from '../types/agent-tool-types';
import type {
  SubagentConfig,
  SubagentSettingsSnapshot,
  SubagentThinking,
} from '../types/subagent-types';
import { Select } from './Select';
import { runtimeRefreshFailure } from '../lib/runtime-refresh';

const THINKING_LABEL: Record<Exclude<SubagentThinking, ''>, string> = {
  off: '关闭',
  minimal: '极少',
  low: '低',
  medium: '中',
  high: '高',
  xhigh: '极高',
  max: '最大',
};
const SUBAGENT_CONTROL_TOOLS = new Set([
  'subagent',
  'subagent_stop',
  'bg_wait',
  'subagent_supervisor',
  'contact_supervisor',
]);

type Scope = 'user' | 'project';
type WorkspaceOption = { cwd: string; name: string };

function emptyConfig(): SubagentConfig {
  return {
    defaultModel: '',
    defaultProvider: '',
    defaultThinking: '',
    maxThinking: '',
    allowedTools: [],
    backgroundEnabled: true,
    defaultMode: 'foreground',
    supervisorEnabled: true,
    maxConcurrent: 4,
    maxSpawns: 32,
    waitTimeoutMs: 30_000,
  };
}

function cloneConfig(config?: SubagentConfig): SubagentConfig {
  const source = { ...emptyConfig(), ...(config || {}) };
  return {
    ...source,
    allowedTools: [...(source.allowedTools || [])],
  };
}

function configFor(snapshot: SubagentSettingsSnapshot, scope: Scope): SubagentConfig {
  return cloneConfig(snapshot[scope]);
}

function thinkingOptions(levels: SubagentThinking[], fallbackLabel: string) {
  return [
    { value: '', label: fallbackLabel },
    ...levels.filter((level): level is Exclude<SubagentThinking, ''> => Boolean(level)).map((level) => ({
      value: level,
      label: THINKING_LABEL[level],
    })),
  ];
}

function sourceLabel(source: AgentToolSource): string {
  if (source.kind === 'core') return 'Durable Core';
  if (source.kind === 'local') return `项目 · ${source.label}`;
  if (source.kind === 'package' || source.kind === 'git') return source.label;
  if (source.source.startsWith('mcp:')) return source.label;
  return source.label || '扩展';
}

function matchesTool(pattern: string, name: string): boolean {
  if (pattern === '*' || pattern === name) return true;
  if (!pattern.includes('*')) return false;
  const escaped = pattern
    .split('*')
    .map((part) => part.replace(/[|\\{}()[\]^$+?.]/g, '\\$&'))
    .join('.*');
  return new RegExp(`^${escaped}$`).test(name);
}

export function SubagentSettings({
  cwd,
  workspaces,
  enabledAgentTools,
  onOpenAgentTools,
}: {
  cwd: string;
  workspaces: WorkspaceOption[];
  enabledAgentTools?: string[];
  onOpenAgentTools?: () => void;
}) {
  const [snapshot, setSnapshot] = useState<SubagentSettingsSnapshot | null>(null);
  const [catalogTools, setCatalogTools] = useState<AgentToolInfo[]>([]);
  const [scope, setScope] = useState<Scope>('user');
  const [targetWorkspace, setTargetWorkspace] = useState(cwd || workspaces[0]?.cwd || '');
  const [draft, setDraft] = useState<SubagentConfig>(emptyConfig);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestRef = useRef(0);
  const scopeRef = useRef(scope);
  scopeRef.current = scope;

  // Project scope always targets one explicit workspace; global scope is workspace independent.
  const effectiveWorkspace = targetWorkspace || cwd || workspaces[0]?.cwd || '';
  const workspaceName = workspaces.find((workspace) => workspace.cwd === effectiveWorkspace)?.name
    || effectiveWorkspace.split('/').filter(Boolean).at(-1)
    || '';

  const load = useCallback(async () => {
    const request = ++requestRef.current;
    setLoading(true);
    setError(null);
    try {
      const [next, catalog] = await Promise.all([
        window.piApi.subagentSettings(effectiveWorkspace),
        window.piApi.agentToolCatalog({ cwd: effectiveWorkspace, refresh: true }),
      ]);
      if (request !== requestRef.current) return;
      setSnapshot(next);
      setDraft(configFor(next, scopeRef.current));
      setCatalogTools(catalog.tools.filter((tool) => !SUBAGENT_CONTROL_TOOLS.has(tool.name)));
    } catch (cause) {
      if (request === requestRef.current) {
        setError(cause instanceof Error ? cause.message : String(cause));
      }
    } finally {
      if (request === requestRef.current) setLoading(false);
    }
  }, [effectiveWorkspace]);

  useEffect(() => {
    setTargetWorkspace((current) => {
      if (current && (workspaces.some((workspace) => workspace.cwd === current) || current === cwd)) {
        return current;
      }
      return cwd || workspaces[0]?.cwd || '';
    });
  }, [cwd, workspaces]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (snapshot) setDraft(configFor(snapshot, scope));
  }, [scope, snapshot]);

  const savedDraft = snapshot ? configFor(snapshot, scope) : emptyConfig();
  const dirty = JSON.stringify(draft) !== JSON.stringify(savedDraft);
  const path = snapshot
    ? scope === 'user'
      ? snapshot.userPath
      : `${snapshot.projectPath} · ${snapshot.projectRoot}`
    : '';
  const scopeLabel = scope === 'user' ? '所有工作区' : workspaceName || '指定工作区';
  const defaultModelOptions = useMemo(() => [
    { value: '', label: '跟随父智能体' },
    ...(snapshot?.models || []).map((model) => ({
      value: model.modelRef,
      label: model.label,
      description: `${model.provider} · ${model.modelRef}`,
    })),
  ], [snapshot?.models]);
  const selectedModel = snapshot?.models.find((model) => model.modelRef === draft.defaultModel);
  const thinkingLevels = selectedModel
    ? selectedModel.thinkingLevels
    : snapshot?.thinkingLevels || [];
  const parentTools = useMemo(() => catalogTools.filter((tool) => (
    !enabledAgentTools
    || enabledAgentTools.some((pattern) => matchesTool(pattern, tool.name))
  )), [catalogTools, enabledAgentTools]);
  const availableNames = useMemo(() => new Set(parentTools.map((tool) => tool.name)), [parentTools]);
  const explicitTools = draft.allowedTools.length > 0;
  const selectedTools = useMemo(() => new Set(draft.allowedTools), [draft.allowedTools]);
  const missingTools = draft.allowedTools.filter((name) => !availableNames.has(name));
  const toolsReady = enabledAgentTools === undefined
    ? undefined
    : enabledAgentTools.includes('*') || enabledAgentTools.includes('subagent');
  const runtimeReady = Boolean(snapshot?.installed && toolsReady);
  const runtimeState = !snapshot?.installed
    ? 'missing'
    : toolsReady === undefined
      ? 'checking'
      : toolsReady
        ? 'ready'
        : 'missing';
  const runtimeLabel = !snapshot?.installed
    ? '尚未启用'
    : toolsReady === undefined
      ? '正在核对'
      : toolsReady
        ? '运行就绪'
        : '等待启用工具';

  function updateModel(defaultModel: string) {
    setDraft((current) => ({
      ...current,
      defaultModel,
      defaultProvider: defaultModel.split('/')[0] || '',
      defaultThinking: '',
    }));
  }

  function toggleTool(name: string) {
    setDraft((current) => {
      const base = current.allowedTools.length > 0
        ? current.allowedTools
        : parentTools.map((tool) => tool.name);
      const next = base.includes(name)
        ? base.filter((item) => item !== name)
        : [...base, name];
      return { ...current, allowedTools: [...new Set(next)] };
    });
  }

  function changeScope(nextScope: Scope) {
    if (nextScope === 'project' && !effectiveWorkspace && workspaces[0]) {
      setTargetWorkspace(workspaces[0].cwd);
    }
    setScope(nextScope);
  }

  function changeWorkspace(nextWorkspace: string) {
    if (nextWorkspace === effectiveWorkspace) return;
    setSnapshot(null);
    setDraft(emptyConfig());
    setTargetWorkspace(nextWorkspace);
  }

  async function save() {
    if (!snapshot) return;
    setSaving(true);
    setError(null);
    try {
      const next = await window.piApi.saveSubagentSettings({
        cwd: effectiveWorkspace,
        scope,
        settings: draft,
      });
      const refreshFailure = runtimeRefreshFailure(next.runtimeRefresh);
      if (refreshFailure) setError(refreshFailure);
      setSnapshot(next);
      setDraft(configFor(next, scope));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  }

  if (loading && !snapshot) {
    return (
      <div className="settings-loading" role="status">
        <LoaderCircle className="spin" />
        正在读取子智能体运行配置…
      </div>
    );
  }

  return (
    <div className="settings-sections subagent-settings">
      <section className="settings-card subagent-overview">
        <div className="subagent-overview-head">
          <div className="subagent-overview-copy">
            <span className="subagent-eyebrow"><Bot />多智能体协作</span>
            <h2>子智能体</h2>
            <p>为子智能体设置独立模型、思考强度和工具边界；每次启动都会继承当前 Harness 配置。</p>
          </div>
          <div className="subagent-overview-actions">
            <span className={`subagent-status-pill is-${runtimeState}`}>
              {runtimeReady
                ? <Check />
                : runtimeState === 'checking'
                  ? <LoaderCircle className="spin" />
                  : <CircleAlert />}
              {runtimeLabel}
            </span>
            <button
              type="button"
              className="icon-button"
              disabled={loading || saving}
              aria-label="刷新子智能体配置"
              title="刷新"
              onClick={() => void load()}
            >
              <RotateCw className={loading ? 'spin' : ''} />
            </button>
          </div>
        </div>

        <div className={`subagent-runtime-status is-${runtimeState}`}>
          <div>
            <strong>{runtimeReady ? 'Durable 子智能体已就绪' : '子智能体功能尚未完全启用'}</strong>
            <span>{runtimeReady
              ? '配置保存在 Studio SQLite，并从下一次启动的子智能体开始生效。'
              : '在智能体工具中开放 subagent 后即可使用；已保存的模型、thinking 和工具限制不会丢失。'}</span>
          </div>
          {snapshot?.installed && toolsReady === false && onOpenAgentTools && (
            <button type="button" className="settings-outline" onClick={onOpenAgentTools}>去启用</button>
          )}
        </div>

        <div className="subagent-scope-block">
          <div className="subagent-section-label">
            <strong>配置范围</strong>
            <span>全局值适用于所有工作区；工作区值只覆盖所选工作区。</span>
          </div>
          <div className="subagent-scope-grid" role="radiogroup" aria-label="子智能体配置范围">
            <button
              type="button"
              role="radio"
              aria-checked={scope === 'user'}
              className={scope === 'user' ? 'is-active' : ''}
              onClick={() => changeScope('user')}
            >
              <span><Layers3 /></span>
              <div>
                <strong>所有工作区</strong>
                <small>作为全局默认配置</small>
              </div>
              {scope === 'user' && <Check />}
            </button>
            <button
              type="button"
              role="radio"
              aria-checked={scope === 'project'}
              disabled={workspaces.length === 0 && !effectiveWorkspace}
              className={scope === 'project' ? 'is-active' : ''}
              onClick={() => changeScope('project')}
            >
              <span><FolderTree /></span>
              <div>
                <strong>指定工作区</strong>
                <small>{workspaceName ? `只覆盖 ${workspaceName}` : '添加工作区后可单独覆盖'}</small>
              </div>
              {scope === 'project' && <Check />}
            </button>
          </div>
          {scope === 'project' && (
            <div className="subagent-workspace-target">
              <div>
                <span>目标工作区</span>
                <small>其他工作区继续使用“所有工作区”配置。</small>
              </div>
              <Select
                label="子智能体目标工作区"
                value={effectiveWorkspace}
                options={workspaces.map((workspace) => ({
                  value: workspace.cwd,
                  label: workspace.name,
                  description: workspace.cwd,
                }))}
                disabled={saving || loading || workspaces.length === 0}
                placeholder="选择工作区"
                leadingIcon={<FolderTree />}
                onChange={changeWorkspace}
              />
            </div>
          )}
          <div className="subagent-config-path">
            <span>保存位置</span>
            <code title={path}>{path || '正在读取 Studio 配置…'}</code>
          </div>
        </div>
      </section>

      <section className="settings-card subagent-section">
        <div className="subagent-section-heading">
          <span><Layers3 /></span>
          <div>
            <h2>运行方式</h2>
            <p>前台任务会等待结果；后台任务由 Durable 管理，主智能体可以继续工作。</p>
          </div>
        </div>
        <div className="subagent-control-grid">
          <label className={`subagent-control ${draft.backgroundEnabled ? 'is-enabled' : ''}`}>
            <span className="subagent-label">允许后台子智能体</span>
            <span className="subagent-toggle-row">
              <span>{draft.backgroundEnabled ? '已开启' : '已关闭'}</span>
              <input
                type="checkbox"
                checked={draft.backgroundEnabled}
                onChange={(event) => setDraft((current) => ({
                  ...current,
                  backgroundEnabled: event.target.checked,
                  defaultMode: event.target.checked ? current.defaultMode : 'foreground',
                  supervisorEnabled: event.target.checked && current.supervisorEnabled,
                }))}
              />
            </span>
            <small>关闭后只接受前台调用，运行中的后台任务不会被中断。</small>
          </label>
          <div className={`subagent-control subagent-control-field ${draft.backgroundEnabled ? '' : 'is-disabled'}`}>
            <span className="subagent-label">默认运行模式</span>
            <Select
              label="默认子智能体运行模式"
              value={draft.defaultMode}
              options={[
                { value: 'foreground', label: '前台 · 等待结果' },
                { value: 'background', label: '后台 · 完成后回传' },
              ]}
              disabled={!draft.backgroundEnabled}
              onChange={(value) => setDraft((current) => ({
                ...current,
                defaultMode: value === 'background' ? 'background' : 'foreground',
              }))}
            />
            <small>调用子智能体未指定模式时使用。</small>
          </div>
          <label className={`subagent-control ${draft.supervisorEnabled ? 'is-enabled' : ''} ${draft.backgroundEnabled ? '' : 'is-disabled'}`}>
            <span className="subagent-label">允许联系主智能体</span>
            <span className="subagent-toggle-row">
              <span>{draft.supervisorEnabled ? '已开启' : '已关闭'}</span>
              <input
                type="checkbox"
                disabled={!draft.backgroundEnabled}
                checked={draft.supervisorEnabled}
                onChange={(event) => setDraft((current) => ({
                  ...current,
                  supervisorEnabled: event.target.checked,
                }))}
              />
            </span>
            <small>允许后台任务提问；主智能体回复后，任务会继续执行。</small>
          </label>
        </div>
        <div className="subagent-field-grid">
          <label className="subagent-field">
            <span className="subagent-label">最大并发</span>
            <input
              type="number"
              min={1}
              max={16}
              value={draft.maxConcurrent}
              onChange={(event) => setDraft((current) => ({
                ...current,
                maxConcurrent: Number(event.target.value),
              }))}
            />
            <small>当前主会话里同时运行的后台任务数量。</small>
          </label>
          <label className="subagent-field">
            <span className="subagent-label">最多创建</span>
            <input
              type="number"
              min={1}
              max={100}
              value={draft.maxSpawns}
              onChange={(event) => setDraft((current) => ({
                ...current,
                maxSpawns: Number(event.target.value),
              }))}
            />
            <small>一个主会话累计可创建的子会话数量。</small>
          </label>
          <label className="subagent-field">
            <span className="subagent-label">默认等待时间</span>
            <div className="subagent-input-unit">
              <input
                type="number"
                min={1}
                max={600}
                step={1}
                value={Math.round(draft.waitTimeoutMs / 1_000)}
                onChange={(event) => setDraft((current) => ({
                  ...current,
                  waitTimeoutMs: Number(event.target.value) * 1_000,
                }))}
              />
              <span>秒</span>
            </div>
            <small>超时只结束本次等待，不会停止子智能体。</small>
          </label>
        </div>
      </section>

      <section className="settings-card subagent-section">
        <div className="subagent-section-heading">
          <span><Sparkles /></span>
          <div>
            <h2>模型与思考</h2>
            <p>以下值用于下一次子智能体会话；调用参数可以覆盖这里的选择。</p>
          </div>
        </div>
        <div className="subagent-field-grid">
          <div className="subagent-field">
            <span className="subagent-label">默认模型</span>
            <Select
              label="子智能体默认模型"
              value={draft.defaultModel}
              options={defaultModelOptions}
              onChange={updateModel}
            />
            <small>留空时跟随父智能体。</small>
          </div>
          <div className="subagent-field">
            <span className="subagent-label">默认 thinking</span>
            <Select
              label="子智能体默认 thinking"
              value={draft.defaultThinking}
              options={thinkingOptions(thinkingLevels, '跟随父智能体')}
              onChange={(value) => setDraft((current) => ({
                ...current,
                defaultThinking: value as SubagentThinking,
              }))}
            />
            <small>只显示当前模型支持的强度。</small>
          </div>
          <div className="subagent-field">
            <span className="subagent-label">thinking 上限</span>
            <Select
              label="子智能体 thinking 上限"
              value={draft.maxThinking}
              options={thinkingOptions(snapshot?.thinkingLevels || [], '不限制')}
              onChange={(value) => setDraft((current) => ({
                ...current,
                maxThinking: value as SubagentThinking,
              }))}
            />
            <small>阻止子智能体使用更高成本的推理强度。</small>
          </div>
        </div>
        <div className="subagent-resolution-note">
          <Info />
          <span>优先级：调用参数 → 指定工作区 → 所有工作区 → 父智能体</span>
        </div>
      </section>

      <section className="settings-card subagent-section">
        <div className="subagent-section-heading subagent-tools-heading">
          <span><Wrench /></span>
          <div>
            <h2>工具权限</h2>
            <p>默认继承父智能体当前工具；也可以在交集内保存一份更窄的白名单。</p>
          </div>
          <button
            type="button"
            className="settings-text-button"
            disabled={!explicitTools}
            onClick={() => setDraft((current) => ({ ...current, allowedTools: [] }))}
          >
            <Undo2 />
            恢复继承
          </button>
        </div>
        <div className="subagent-tool-summary">
          <span><Bot /></span>
          <div>
            <strong>{explicitTools ? `仅允许 ${draft.allowedTools.length} 个工具` : '沿用父智能体当前工具'}</strong>
            <small>最终权限始终与父智能体的交集一致，子智能体不能扩大权限。</small>
          </div>
        </div>
        {missingTools.length > 0 && (
          <div className="settings-error" role="status">
            有 {missingTools.length} 个已保存工具当前不可用：{missingTools.join('、')}。它可能来自已删除的扩展或 MCP。
          </div>
        )}
        <div className="subagent-tool-list">
          {parentTools.map((tool) => {
            const checked = !explicitTools || selectedTools.has(tool.name);
            return (
              <label
                key={`${tool.source.key}:${tool.name}`}
                className={`subagent-tool-row ${checked ? 'is-enabled' : ''}`}
              >
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={() => toggleTool(tool.name)}
                />
                <span className="subagent-tool-check">{checked && <Check />}</span>
                <span className="subagent-tool-copy">
                  <strong>{tool.name}</strong>
                  <small>{tool.description || '没有工具说明。'}</small>
                </span>
                <span className="subagent-tool-source" title={tool.source.path || tool.source.source}>
                  {sourceLabel(tool.source)}
                </span>
              </label>
            );
          })}
          {!parentTools.length && (
            <div className="settings-empty">
              当前父智能体还没有可用工具。先在智能体工具页启用工具，或检查扩展与 MCP 状态。
            </div>
          )}
        </div>
      </section>

      {error && <div className="settings-error" role="alert">{error}</div>}
      <div className="subagent-savebar">
        <div>
          <strong>{dirty ? `${scopeLabel}有未保存的更改` : '配置已同步'}</strong>
          <span>{scopeLabel} · {path} · 下一次启动子智能体时生效</span>
        </div>
        <button
          className="settings-outline"
          disabled={!dirty || saving}
          onClick={() => setDraft(cloneConfig(savedDraft))}
        >
          撤销更改
        </button>
        <button className="settings-save" disabled={!dirty || saving} onClick={() => void save()}>
          {saving ? <LoaderCircle className="spin" /> : <Save />}
          {saving ? '正在保存…' : '保存配置'}
        </button>
      </div>
    </div>
  );
}
