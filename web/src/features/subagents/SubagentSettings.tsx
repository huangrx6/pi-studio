import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Bot,
  Check,
  CircleAlert,
  FileDiff,
  FolderGit2,
  FolderOpen,
  FolderTree,
  GitMerge,
  Layers3,
  LoaderCircle,
  RotateCw,
  Save,
  Sparkles,
  Trash2,
  Undo2,
  Wrench,
} from 'lucide-react';
import type { AgentToolInfo, AgentToolSource } from '../../types/agent-tool-types';
import type {
  SubagentConfig,
  SubagentSettingsSnapshot,
  SubagentThinking,
} from '../../types/subagent-types';
import { InfoHint } from '../../shared/InfoHint';
import { Select } from '../../shared/Select';
import { SettingsPageHeader } from '../../shared/SettingsPageHeader';
import { runtimeRefreshFailure } from '../../shared/runtime-refresh';
import { useActionConfirmation } from '../../shared/ConfirmDialog';

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
    worktreeIsolation: 'background',
    worktreeLimit: 8,
    budgetTokens: 0,
    budgetCostUsd: 0,
    budgetAction: 'warn',
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

function formatBytes(value?: number): string {
  const bytes = Math.max(0, Number(value) || 0);
  if (bytes < 1_024) return `${bytes} B`;
  if (bytes < 1_024 * 1_024) return `${(bytes / 1_024).toFixed(bytes >= 10 * 1_024 ? 0 : 1)} KB`;
  return `${(bytes / (1_024 * 1_024)).toFixed(bytes >= 10 * 1_024 * 1_024 ? 0 : 1)} MB`;
}

const WORKTREE_STATUS_LABEL = {
  active: '运行中',
  finished: '待处理',
  failed: '执行失败',
  applied: '已应用',
  discarded: '已丢弃',
  removed: '已清理',
} as const;

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
  const [worktreeBusy, setWorktreeBusy] = useState('');
  const confirmation = useActionConfirmation();
  const worktrees = Array.isArray(snapshot?.worktrees) ? snapshot.worktrees : [];
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

  async function settleWorktree(id: string, action: 'apply' | 'discard' | 'cleanup') {
    if (worktreeBusy) return;
    const item = worktrees.find((worktree) => worktree.id === id);
    const accepted = await confirmation.confirm(action === 'apply'
      ? {
          title: '应用工作树改动？',
          description: `${item?.changedFiles ?? 0} 个文件会写入当前项目。应用前会先做 Git 冲突检查；不会改动你的暂存区。`,
          confirmLabel: '应用改动',
        }
      : action === 'discard'
        ? {
            title: '丢弃这个工作树？',
            description: '工作树目录及其未合并改动会永久删除。项目中的文件不会被修改。',
            confirmLabel: '丢弃工作树',
            tone: 'danger',
          }
        : {
            title: '清理已结束工作树？',
            description: '只清除已经应用、丢弃或移除的目录；待处理改动会保留。',
            confirmLabel: '开始清理',
          });
    if (!accepted) return;
    setWorktreeBusy(id || 'cleanup');
    setError(null);
    try {
      if (action === 'apply') await window.piApi.applyManagedWorktree(id);
      else if (action === 'discard') await window.piApi.discardManagedWorktree({ id });
      else await window.piApi.cleanupManagedWorktrees();
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setWorktreeBusy('');
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
      <SettingsPageHeader
        icon={<Bot />}
        title="子智能体"
        meta={<InfoHint label="新任务继承当前 Harness 配置；运行中的任务保持不变。" />}
        actions={
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
        }
      />
      <section className="settings-card subagent-overview">
        {!runtimeReady && <div className={`subagent-runtime-status is-${runtimeState}`}>
          <div>
            <strong>子智能体尚未启用 <InfoHint label="在智能体工具中开放 subagent 后即可使用；已保存的模型、思考强度和工具限制会保留。" /></strong>
          </div>
          {snapshot?.installed && toolsReady === false && onOpenAgentTools && (
            <button type="button" className="settings-outline" onClick={onOpenAgentTools}>去启用</button>
          )}
        </div>}

        <div className="subagent-scope-block">
          <div className="subagent-section-label">
            <strong>配置范围 <InfoHint label="全局值适用于所有工作区；工作区值只覆盖所选工作区。" /></strong>
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
              </div>
              {scope === 'project' && <Check />}
            </button>
          </div>
          {scope === 'project' && (
            <div className="subagent-workspace-target">
              <div>
                <span>目标工作区</span>
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

        </div>
      </section>

      <section className="settings-card subagent-section">
        <div className="subagent-section-heading">
          <span><Layers3 /></span>
          <div>
            <h2>运行方式 <InfoHint label="前台任务等待结果；后台任务由 Durable 管理，主智能体可以继续工作。" /></h2>
          </div>
        </div>
        <div className="subagent-control-grid">
          <label className={`subagent-control ${draft.backgroundEnabled ? 'is-enabled' : ''}`}>
            <span className="subagent-label">允许后台子智能体 <InfoHint label="关闭后只接受前台调用；已经运行的后台任务不会被中断。" /></span>
            <span className="subagent-toggle-row">
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
          </div>
          <label className={`subagent-control ${draft.supervisorEnabled ? 'is-enabled' : ''} ${draft.backgroundEnabled ? '' : 'is-disabled'}`}>
            <span className="subagent-label">允许联系主智能体 <InfoHint align="end" label="后台任务可向主智能体提问；收到回复后会继续执行。" /></span>
            <span className="subagent-toggle-row">
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
          </label>
        </div>
        <div className="subagent-field-grid">
          <label className="subagent-field">
            <span className="subagent-label">最大并发 <InfoHint label="当前主会话中可以同时运行的后台任务数量。" /></span>
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
          </label>
          <label className="subagent-field">
            <span className="subagent-label">最多创建 <InfoHint label="一个主会话累计可创建的子会话数量。" /></span>
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
          </label>
          <label className="subagent-field">
            <span className="subagent-label">默认等待时间 <InfoHint align="end" label="超时只结束本次等待，不会停止子智能体。" /></span>
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
          </label>
          <div className="subagent-field">
            <span className="subagent-label">工作树隔离 <InfoHint label="隔离任务只修改 Studio 管理的 Git 工作树，结束前不接触项目文件。" /></span>
            <Select
              label="子智能体工作树隔离方式"
              value={draft.worktreeIsolation}
              options={[
                { value: 'background', label: '后台任务 · 推荐' },
                { value: 'always', label: '所有子智能体' },
                { value: 'off', label: '关闭 · 共享工作区' },
              ]}
              onChange={(value) => setDraft((current) => ({
                ...current,
                worktreeIsolation: value as SubagentConfig['worktreeIsolation'],
              }))}
            />
          </div>
          <label className={`subagent-field ${draft.worktreeIsolation === 'off' ? 'is-disabled' : ''}`}>
            <span className="subagent-label">工作树保留上限 <InfoHint label="达到上限后会阻止新建隔离任务，直到合并或丢弃已有改动。" /></span>
            <input
              type="number"
              min={1}
              max={50}
              disabled={draft.worktreeIsolation === 'off'}
              value={draft.worktreeLimit}
              onChange={(event) => setDraft((current) => ({
                ...current,
                worktreeLimit: Number(event.target.value),
              }))}
            />
          </label>
          <label className="subagent-field">
            <span className="subagent-label">Token 预算 <InfoHint align="end" label="按当前会话内所有子智能体的模型请求累计；0 表示不限制。" /></span>
            <input
              type="number"
              min={0}
              max={100_000_000}
              step={1_000}
              value={draft.budgetTokens}
              placeholder="0 · 不限制"
              onChange={(event) => setDraft((current) => ({
                ...current,
                budgetTokens: Number(event.target.value),
              }))}
            />
          </label>
          <label className="subagent-field">
            <span className="subagent-label">参考成本预算 <InfoHint label="使用模型返回的参考价格；没有返回价格时不会估算。" /></span>
            <div className="subagent-input-unit">
              <input
                type="number"
                min={0}
                max={100_000}
                step={0.01}
                value={draft.budgetCostUsd}
                placeholder="0 · 不限制"
                onChange={(event) => setDraft((current) => ({
                  ...current,
                  budgetCostUsd: Number(event.target.value),
                }))}
              />
              <span>USD</span>
            </div>
          </label>
          <div className={`subagent-field ${draft.budgetTokens || draft.budgetCostUsd ? '' : 'is-disabled'}`}>
            <span className="subagent-label">达到预算后 <InfoHint align="end" label="不会中断正在执行的任务；策略从下一安全请求边界开始生效。" /></span>
            <Select
              label="子智能体预算超限策略"
              value={draft.budgetAction}
              options={[
                { value: 'warn', label: '仅提醒' },
                { value: 'stop', label: '阻止新任务' },
              ]}
              disabled={!draft.budgetTokens && !draft.budgetCostUsd}
              onChange={(value) => setDraft((current) => ({
                ...current,
                budgetAction: value === 'stop' ? 'stop' : 'warn',
              }))}
            />
          </div>
        </div>
      </section>

      <section className="settings-card subagent-section">
        <div className="subagent-section-heading">
          <span><Sparkles /></span>
          <div>
            <h2>模型与思考 <InfoHint label="用于下一次子智能体会话。优先级：调用参数 → 指定工作区 → 所有工作区 → 父智能体。" /></h2>
          </div>
        </div>
        <div className="subagent-field-grid">
          <div className="subagent-field">
            <span className="subagent-label">默认模型 <InfoHint label="留空时跟随父智能体。" /></span>
            <Select
              label="子智能体默认模型"
              value={draft.defaultModel}
              options={defaultModelOptions}
              onChange={updateModel}
            />
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
          </div>
          <div className="subagent-field">
            <span className="subagent-label">thinking 上限 <InfoHint align="end" label="阻止子智能体使用更高成本的推理强度。" /></span>
            <Select
              label="子智能体 thinking 上限"
              value={draft.maxThinking}
              options={thinkingOptions(snapshot?.thinkingLevels || [], '不限制')}
              onChange={(value) => setDraft((current) => ({
                ...current,
                maxThinking: value as SubagentThinking,
              }))}
            />
          </div>
        </div>
      </section>

      <section className="settings-card subagent-section subagent-worktrees">
        <div className="subagent-section-heading">
          <span><FolderGit2 /></span>
          <div>
            <h2>隔离工作树 <InfoHint label="在应用、丢弃或清理前，子智能体产生的文件改动会保留在 Studio 私有目录中。" /></h2>
          </div>
          <button
            type="button"
            className="settings-outline"
            disabled={Boolean(worktreeBusy)}
            onClick={() => void settleWorktree('', 'cleanup')}
          >
            <RotateCw className={worktreeBusy === 'cleanup' ? 'spin' : ''} />
            清理已结束
          </button>
        </div>
        <div className="subagent-worktree-summary">
          <span><strong>{worktrees.filter((item) => item.status === 'active').length}</strong><small>运行中</small></span>
          <span><strong>{worktrees.filter((item) => item.status === 'finished').length}</strong><small>待处理</small></span>
          <span><strong>{formatBytes(worktrees.reduce((sum, item) => sum + item.sizeBytes, 0))}</strong><small>占用空间</small></span>
          <span><strong>{worktrees.reduce((sum, item) => sum + (item.changedFiles || 0), 0)}</strong><small>变更文件</small></span>
        </div>
        <div className="subagent-worktree-list">
          {worktrees.map((worktree) => (
            <article className={`subagent-worktree-row is-${worktree.status}`} key={worktree.id}>
              <span className="subagent-worktree-icon">
                {worktree.status === 'active' ? <LoaderCircle className="spin" /> : worktree.status === 'failed' ? <CircleAlert /> : <FileDiff />}
              </span>
              <div className="subagent-worktree-copy">
                <div>
                  <strong>{worktree.name}</strong>
                  <span className={`settings-badge is-${worktree.status}`}>{WORKTREE_STATUS_LABEL[worktree.status]}</span>
                </div>
                <code title={worktree.path}>{worktree.path}</code>
                <small>
                  {worktree.changedFiles || 0} 个文件 · {formatBytes(worktree.sizeBytes)}
                  {worktree.totalAdded !== undefined ? ` · +${worktree.totalAdded} / −${worktree.totalRemoved || 0}` : ''}
                  {worktree.error ? ` · ${worktree.error}` : ''}
                </small>
                {Boolean(worktree.files?.length) && (
                  <details>
                    <summary>查看改动文件</summary>
                    <ul>
                      {worktree.files!.slice(0, 80).map((file) => (
                        <li key={`${file.status}:${file.path}`}>
                          <span>{file.status === 'added' ? 'A' : file.status === 'deleted' ? 'D' : 'M'}</span>
                          <code>{file.path}</code>
                        </li>
                      ))}
                    </ul>
                  </details>
                )}
              </div>
              <div className="subagent-worktree-actions">
                <button
                  type="button"
                  className="icon-button"
                  disabled={!worktree.directoryExists}
                  title="在 Finder 中显示"
                  aria-label={`显示工作树 ${worktree.name}`}
                  onClick={() => void window.piApi.revealManagedWorktree(worktree.id)}
                >
                  <FolderOpen />
                </button>
                <button
                  type="button"
                  className="settings-outline"
                  disabled={worktree.status === 'active' || !worktree.directoryExists || Boolean(worktreeBusy)}
                  onClick={() => void settleWorktree(worktree.id, 'apply')}
                >
                  <GitMerge />应用
                </button>
                <button
                  type="button"
                  className="icon-button is-danger"
                  disabled={worktree.status === 'active' || Boolean(worktreeBusy)}
                  title="丢弃工作树"
                  aria-label={`丢弃工作树 ${worktree.name}`}
                  onClick={() => void settleWorktree(worktree.id, 'discard')}
                >
                  <Trash2 />
                </button>
              </div>
            </article>
          ))}
          {!worktrees.length && (
            <div className="settings-empty">
              没有待处理工作树
            </div>
          )}
        </div>
      </section>

      <section className="settings-card subagent-section">
        <div className="subagent-section-heading subagent-tools-heading">
          <span><Wrench /></span>
          <div>
            <h2>工具权限 <InfoHint label="默认继承父智能体当前工具；也可以保存一份更窄的白名单。" /></h2>
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
                  {tool.description && <small>{tool.description}</small>}
                </span>
                <span className="subagent-tool-source" title={tool.source.path || tool.source.source}>
                  {sourceLabel(tool.source)}
                </span>
              </label>
            );
          })}
          {!parentTools.length && (
            <div className="settings-empty">
              当前父智能体没有可用工具
            </div>
          )}
        </div>
      </section>

      {error && <div className="settings-error" role="alert">{error}</div>}
      {confirmation.dialog}
      <div className="subagent-savebar">
        <div>
          <strong>
            {dirty ? `${scopeLabel}有未保存的更改` : '配置已同步'}
            <InfoHint label="配置从下一次启动子智能体时生效。" />
          </strong>
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
