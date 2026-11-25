import { Accordion } from '../../shared/Accordion';
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import {
  ChevronRight,
  FolderOpen,
  GitMerge,
  RotateCw,
  SlidersHorizontal,
  Trash2,
  Undo2,
} from 'lucide-react';
import { SettingsDialog } from '../../shared/SettingsDialog';
import { isComposingKey } from '../../shared/keyboard-navigation';
import type { ModalDismiss } from '../../shared/useModalDialog';
import { revealFileLabel } from '../../shared/desktop-platform';
import type { AgentToolInfo, AgentToolSource } from '../../types/agent-tool-types';
import type { ModelOption } from '../../types/model-types';
import type {
  SubagentConfig,
  SubagentSettingsSnapshot,
  SubagentThinking,
} from '../../types/subagent-types';
import { InfoHint } from '../../shared/InfoHint';
import { Select } from '../../shared/Select';
import { SubagentProfileLibrary } from './SubagentProfileLibrary';
import './styles/subagent-profiles.css';
import { runtimeRefreshFailure } from '../../shared/runtime-refresh';
import { useActionConfirmation } from '../../shared/ConfirmDialog';
import { SettingsToast, useSettingsToast } from '../../shared/SettingsToast';
import { useSettingsDraftGuard } from '../../shared/SettingsDraftGuard';
import { createSubagentSettingsOwner, createSubagentSettingsWrites, toggleSubagentAllowedTool } from './subagent-settings-state';
import './styles/subagent-settings.css';

const settingsWrites = createSubagentSettingsWrites();

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
    worktreeParent: '',
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

type SubagentSettingsProps = {
  cwd: string;
  workspaces: WorkspaceOption[];
  models?: Pick<ModelOption, 'id' | 'name'>[];
  enabledAgentTools?: string[];
  onOpenAgentTools?: () => void;
  onWorktreesRevealed?: () => void;
};

export function SubagentSettings(props: SubagentSettingsProps) {
  const [defaultsOpen, setDefaultsOpen] = useState(false);
  const defaultsButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (props.onWorktreesRevealed) {
      defaultsButton.current?.focus({ preventScroll: true });
      setDefaultsOpen(true);
    }
  }, [props.onWorktreesRevealed]);
  return <div className="settings-preference-page role-settings-page">
    <SubagentProfileLibrary cwd={props.cwd}
      models={props.models}
      canDelegate={props.enabledAgentTools?.some(pattern => matchesTool(pattern, 'subagent'))}
      onOpenAgentTools={props.onOpenAgentTools} defaultsAction={
        <button ref={defaultsButton} type="button" className="settings-outline" aria-haspopup="dialog" onClick={() => setDefaultsOpen(true)}>
          <SlidersHorizontal aria-hidden="true" />共用运行默认值
        </button>
      } />
    {defaultsOpen && <SubagentDefaultsDialog {...props} onClose={() => {
      setDefaultsOpen(false);
      props.onWorktreesRevealed?.();
    }} />}
  </div>;
}

function SubagentDefaultsDialog({
  cwd, workspaces, enabledAgentTools, onOpenAgentTools, onWorktreesRevealed, onClose,
}: SubagentSettingsProps & { onClose: () => void }) {
  const showToast = useSettingsToast();
  const inputPrefix = useId();
  const [snapshot, setSnapshot] = useState<SubagentSettingsSnapshot | null>(null);
  const worktreesHeading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (!snapshot || !onWorktreesRevealed) return;
    const frame = requestAnimationFrame(() => {
      if (!worktreesHeading.current) return;
      worktreesHeading.current.focus({ preventScroll: true });
      worktreesHeading.current.closest('section')?.scrollIntoView({ block: 'start', behavior: 'instant' });
      onWorktreesRevealed();
    });
    return () => cancelAnimationFrame(frame);
  }, [snapshot, onWorktreesRevealed]);
  const [catalogTools, setCatalogTools] = useState<AgentToolInfo[]>([]);
  const [scope, setScope] = useState<Scope>('user');
  const [targetWorkspace, setTargetWorkspace] = useState(cwd || workspaces[0]?.cwd || '');
  const [draft, setDraft] = useState<SubagentConfig>(emptyConfig);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [worktreeBusy, setWorktreeBusy] = useState('');
  const [loadError, setLoadError] = useState<string | null>(null);
  const [toolFilter, setToolFilter] = useState('');
  const [collapsedToolGroups, setCollapsedToolGroups] = useState<string[]>([]);
  const [collapsedSearchGroups, setCollapsedSearchGroups] = useState<string[]>([]);
  const filteringTools = Boolean(toolFilter.trim());
  const collapsedGroups = filteringTools ? collapsedSearchGroups : collapsedToolGroups;
  const setCollapsedGroups = filteringTools ? setCollapsedSearchGroups : setCollapsedToolGroups;
  const [worktreeLoadError, setWorktreeLoadError] = useState<string | null>(null);
  const confirmation = useActionConfirmation('subagent-confirm');
  const worktrees = Array.isArray(snapshot?.worktrees) ? snapshot.worktrees : [];
  const scopeRef = useRef(scope);
  scopeRef.current = scope;

  // Project scope always targets one explicit workspace; global scope is workspace independent.
  const effectiveWorkspace = targetWorkspace || cwd || workspaces[0]?.cwd || '';
  const workspaceName = workspaces.find((workspace) => workspace.cwd === effectiveWorkspace)?.name
    || effectiveWorkspace.split(/[\\/]/).filter(Boolean).at(-1)
    || '';

  const owner = useRef(createSubagentSettingsOwner(effectiveWorkspace + '\0' + scope)).current;
  owner.setScope(effectiveWorkspace + '\0' + scope);
  const busy = loading || saving || Boolean(worktreeBusy);

  const load = useCallback(async () => {
    const request = owner.begin();
    setLoading(true);
    setSnapshot(null);
    setCatalogTools([]);
    setDraft(emptyConfig());
    setLoadError(null);
    setWorktreeLoadError(null);
    try {
      await settingsWrites.wait();
      if (!owner.current(request)) return;
      const [next, catalog] = await Promise.all([
        window.piApi.subagentSettings(effectiveWorkspace),
        window.piApi.agentToolCatalog({ cwd: effectiveWorkspace, refresh: true }),
      ]);
      if (!owner.current(request)) return;
      setSnapshot(next);
      setDraft(configFor(next, scopeRef.current));
      setCatalogTools(catalog.tools.filter((tool) => !SUBAGENT_CONTROL_TOOLS.has(tool.name)));
    } catch (cause) {
      if (owner.current(request)) setLoadError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (owner.current(request)) setLoading(false);
    }
  }, [effectiveWorkspace, owner]);

  useEffect(() => {
    // Keep an explicitly selected workspace stable while its draft is being edited.
    // A removed workspace is shown as unavailable; never silently retarget its settings.
    if (!targetWorkspace) setTargetWorkspace(cwd || workspaces[0]?.cwd || '');
  }, [cwd, workspaces, targetWorkspace]);

  useEffect(() => {
    owner.activate();
    setSaving(false);
    setWorktreeBusy('');
    void load();
    return () => owner.dispose();
  }, [load, owner]);

  const savedDraft = snapshot ? configFor(snapshot, scope) : emptyConfig();
  const dirty = Boolean(snapshot) && JSON.stringify(draft) !== JSON.stringify(savedDraft);
  useSettingsDraftGuard({ label: '子智能体配置', dirty });

  const scopeLabel = scope === 'user' ? '所有工作区' : workspaceName || '指定工作区';
  const defaultModelOptions = useMemo(() => [
    { value: '', label: '跟随父智能体' },
    ...(draft.defaultModel && !snapshot?.models.some((model) => model.modelRef === draft.defaultModel)
      ? [{ value: draft.defaultModel, label: `${draft.defaultModel}（当前不可用）`, disabled: true }] : []),
    ...(snapshot?.models || []).map((model) => ({
      value: model.modelRef,
      label: model.label,
      description: `${model.provider} · ${model.modelRef}`,
    })),
  ], [snapshot?.models, draft.defaultModel]);
  const selectedModel = snapshot?.models.find((model) => model.modelRef === draft.defaultModel);
  const thinkingLevels = selectedModel
    ? selectedModel.thinkingLevels
    : snapshot?.thinkingLevels || [];
  const parentTools = useMemo(() => catalogTools.filter((tool) => (
    tool.enabled ?? (!enabledAgentTools || enabledAgentTools.some((pattern) => matchesTool(pattern, tool.name)))
  )), [catalogTools, enabledAgentTools]);
  const availableNames = useMemo(() => new Set(parentTools.map((tool) => tool.name)), [parentTools]);
  const explicitTools = draft.allowedTools.length > 0;
  const selectedTools = useMemo(() => new Set(draft.allowedTools), [draft.allowedTools]);
  const missingTools = draft.allowedTools.filter((name) => !availableNames.has(name));
  const toolGroups = useMemo(() => {
    const query = toolFilter.trim().toLowerCase();
    const groups = new Map<string, { label: string; tools: AgentToolInfo[] }>();
    for (const tool of parentTools) {
      if (query && !`${tool.name} ${tool.description ?? ''}`.toLowerCase().includes(query)) continue;
      const label = sourceLabel(tool.source);
      const entry = groups.get(label) ?? { label, tools: [] };
      entry.tools.push(tool);
      groups.set(label, entry);
    }
    return [...groups.values()];
  }, [parentTools, toolFilter]);

  const limitSummary = [
    `${draft.maxConcurrent} 并发`,
    `最多 ${draft.maxSpawns} 次`,
    draft.worktreeIsolation === 'off' ? '共享工作区' : `工作树上限 ${draft.worktreeLimit}`,
    draft.budgetTokens || draft.budgetCostUsd ? '预算已设置' : '预算不限',
  ].join(' · ');
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
    const next = toggleSubagentAllowedTool(draft.allowedTools, parentTools.map((tool) => tool.name), name);
    if (!next) {
      showToast('至少保留一个工具。空白名单表示继承父智能体；如需恢复继承，请使用“恢复继承”。', 'error');
      return;
    }
    setDraft((current) => ({ ...current, allowedTools: next }));
  }

  function toggleToolGroup(label: string) {
    setCollapsedGroups((current) => (
      current.includes(label) ? current.filter((entry) => entry !== label) : [...current, label]
    ));
  }

  function setToolsEnabled(names: string[], enabled: boolean) {
    const allNames = parentTools.map((tool) => tool.name);
    const base = explicitTools ? draft.allowedTools.filter((name) => allNames.includes(name)) : allNames;
    const next = enabled
      ? allNames.filter((name) => base.includes(name) || names.includes(name))
      : base.filter((name) => !names.includes(name));
    if (!next.length) {
      showToast('至少保留一个工具。空白名单表示继承父智能体；如需恢复继承，请使用“恢复继承”。', 'error');
      return;
    }
    setDraft((current) => ({ ...current, allowedTools: next }));
  }

  async function allowDiscard() {
    if (!dirty) return true;
    return confirmation.confirm({
      title: '放弃未保存更改？',
      description: '当前子智能体配置尚未保存，继续将放弃这些修改。',
      confirmLabel: '放弃更改',
      tone: 'danger',
    });
  }

  async function changeScope(nextScope: Scope) {
    if (busy || nextScope === scope || !await allowDiscard()) return;
    setScope(nextScope);
    if (snapshot) setDraft(configFor(snapshot, nextScope));
  }

  async function changeWorkspace(nextWorkspace: string) {
    if (busy || nextWorkspace === effectiveWorkspace || !await allowDiscard()) return;
    setSnapshot(null);
    setTargetWorkspace(nextWorkspace);
  }

  async function refresh() {
    if (busy || !await allowDiscard()) return;
    await load();
  }

  async function save(dismiss: ModalDismiss) {
    if (!snapshot || busy || !dirty) return;
    const ticket = owner.begin();
    const input = { cwd: effectiveWorkspace, scope, settings: cloneConfig(draft) };
    setSaving(true);
    try {
      const next = await settingsWrites.run(() => window.piApi.saveSubagentSettings(input));
      if (!owner.current(ticket)) return;
      const refreshFailure = runtimeRefreshFailure(next.runtimeRefresh);
      setSnapshot(next);
      setDraft(configFor(next, input.scope));
      if (refreshFailure) showToast(refreshFailure, 'error');
      else {
        await dismiss(onClose);
        showToast('配置已保存，将用于下一次子智能体任务。');
      }
    } catch (cause) {
      if (owner.current(ticket)) showToast(cause instanceof Error ? cause.message : String(cause), 'error');
    } finally {
      if (owner.current(ticket)) setSaving(false);
    }
  }

  async function settleWorktree(id: string, action: 'apply' | 'discard' | 'cleanup') {
    if (busy) return;
    const ticket = owner.begin();
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
    if (!accepted || !owner.current(ticket)) return;
    setWorktreeBusy(id || 'cleanup');
    setWorktreeLoadError(null);
    let applied = false;
    try {
      await settingsWrites.run(async () => {
        if (action === 'apply') await window.piApi.applyManagedWorktree(id);
        else if (action === 'discard') await window.piApi.discardManagedWorktree({ id });
        else await window.piApi.cleanupManagedWorktrees();
      });
      applied = true;
      if (!owner.current(ticket)) return;
      const next = await window.piApi.managedWorktrees({ cwd: effectiveWorkspace });
      if (!owner.current(ticket)) return;
      setSnapshot((current) => current ? { ...current, worktrees: next } : current);
      showToast('工作树操作已完成。');
    } catch (cause) {
      if (owner.current(ticket)) {
        const message = cause instanceof Error ? cause.message : String(cause);
        if (applied) setWorktreeLoadError(`操作已完成，但列表刷新失败：${message}`);
        else showToast(message, 'error');
      }
    } finally {
      if (owner.current(ticket)) setWorktreeBusy('');
    }
  }

  async function reloadWorktrees() {
    if (busy) return;
    const ticket = owner.begin();
    setWorktreeBusy('reload');
    setWorktreeLoadError(null);
    try {
      await settingsWrites.wait();
      if (!owner.current(ticket)) return;
      const next = await window.piApi.managedWorktrees({ cwd: effectiveWorkspace });
      if (owner.current(ticket)) setSnapshot((current) => current ? { ...current, worktrees: next } : current);
    } catch (cause) {
      if (owner.current(ticket)) setWorktreeLoadError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (owner.current(ticket)) setWorktreeBusy('');
    }
  }

  async function revealWorktree(id: string) {
    if (busy) return;
    const ticket = owner.begin();
    try { await window.piApi.revealManagedWorktree(id); }
    catch (cause) { if (owner.current(ticket)) showToast(cause instanceof Error ? cause.message : String(cause), 'error'); }
  }

  return <><SettingsDialog wide className="subagent-form-dialog subagent-defaults-dialog" title="共用运行默认值"
    description="工作区可覆盖全局默认值，每个角色也可以单独调整。"
    action="保存配置" closeLabel="关闭" busy={saving || Boolean(worktreeBusy)} busyAction={saving ? '正在保存…' : '处理中…'}
    loading={loading && !snapshot} unavailable={!snapshot || !dirty} error={null} autoFocusFirstField={false}
    onSubmit={dismiss => void save(dismiss)} onClose={onClose}
    onRequestClose={async dismiss => { if (await allowDiscard()) await dismiss(onClose); }}
    footerHint={snapshot && (() => <div className="subagent-defaults-footer-tools">
      <button type="button" className="icon-button" disabled={busy} aria-label="刷新子智能体配置" title="刷新配置" onClick={() => void refresh()}><RotateCw /></button>
      {dirty && <><button type="button" className="settings-outline" disabled={busy} onClick={() => setDraft(cloneConfig(savedDraft))}>撤销更改</button>
        <span role="status">{scopeLabel}有未保存的更改</span></>}
    </div>)}>
    <div className="subagent-form subagent-settings">
      {loadError && <div className="settings-error" role="alert">
        <span>无法读取子智能体配置：{loadError}</span>
        <button type="button" className="settings-outline" onClick={() => void load()}>重新加载</button>
      </div>}
      {snapshot && <div className="subagent-defaults-sections">
      <section className="subagent-defaults-section" aria-labelledby="subagent-scope">
        <div className="subagent-scope-block subagent-default-row">
          <div className="subagent-section-heading">
            <h3 id="subagent-scope">配置范围</h3>
            <InfoHint label="这里配置角色共用的默认值。工作区可以覆盖全局值，每个角色也可以在编辑框里逐项指定。" />
          </div>
          <div className="settings-segments subagent-scope-grid" role="group" aria-label="子智能体配置范围">
            <button
              type="button"
              aria-pressed={scope === 'user'}
              disabled={busy}
              onClick={() => changeScope('user')}
            >
              所有工作区
            </button>
            <button
              type="button"
              aria-pressed={scope === 'project'}
              disabled={busy || (workspaces.length === 0 && !effectiveWorkspace)}
              onClick={() => changeScope('project')}
            >
              指定工作区
            </button>
          </div>
          {scope === 'project' && (
            <div className="subagent-workspace-target subagent-default-row">
              <div>
                <span>目标工作区</span>
              </div>
              <Select
                label="子智能体目标工作区"
                value={effectiveWorkspace}
                options={[...(!workspaces.some((workspace) => workspace.cwd === effectiveWorkspace) && effectiveWorkspace
                  ? [{ value: effectiveWorkspace, label: `${workspaceName}（当前工作区列表中不可用）`, disabled: true }] : []), ...workspaces.map((workspace) => ({
                  value: workspace.cwd,
                  label: workspace.name,
                  description: workspace.cwd,
                }))]}
                disabled={busy || workspaces.length === 0}
                placeholder="选择工作区"
                onChange={changeWorkspace}
              />
            </div>
          )}
        </div>
        {!runtimeReady && <div className={`subagent-runtime-status is-${runtimeState}`}>
          <strong>{runtimeLabel} <InfoHint label="在智能体工具中开放 subagent 后即可使用；已保存的模型、思考强度和工具限制会保留。" /></strong>
          {snapshot?.installed && toolsReady === false && onOpenAgentTools && (
            <button type="button" className="settings-outline" onClick={onOpenAgentTools}>去启用</button>
          )}
        </div>}
      </section>
      <section className="subagent-defaults-section" aria-labelledby="subagent-execution">
        <div className="subagent-section-heading">
          <h3 id="subagent-execution">运行方式</h3>
          <InfoHint label="前台任务等待结果；后台任务由 Durable 管理，主智能体可以继续工作。" />
        </div>
        <div className="subagent-default-rows">
          <div className="subagent-default-row subagent-switch-row">
            <span className="subagent-label"><span>允许后台子智能体</span> <InfoHint label="关闭后只接受前台调用；已经运行的后台任务不会被中断。" /></span>
            <button
              type="button"
              role="switch"
              className={`switch ${draft.backgroundEnabled ? 'is-on' : ''}`}
              aria-label="允许后台子智能体"
              aria-checked={draft.backgroundEnabled}
              disabled={busy || !snapshot}
              onClick={() => setDraft((current) => {
                const nextEnabled = !current.backgroundEnabled;
                return {
                  ...current,
                  backgroundEnabled: nextEnabled,
                  defaultMode: nextEnabled ? current.defaultMode : 'foreground',
                  supervisorEnabled: nextEnabled && current.supervisorEnabled,
                };
              })}
            >
              <span />
            </button>
          </div>
          <div className={`subagent-default-row ${draft.backgroundEnabled ? '' : 'is-disabled'}`}>
            <span className="subagent-label">默认运行模式</span>
            <Select
              label="默认子智能体运行模式"
              value={draft.defaultMode}
              options={[
                { value: 'foreground', label: '前台 · 等待结果' },
                { value: 'background', label: '后台 · 完成后回传' },
              ]}
              disabled={busy || !snapshot || !draft.backgroundEnabled}
              onChange={(value) => setDraft((current) => ({
                ...current,
                defaultMode: value === 'background' ? 'background' : 'foreground',
              }))}
            />
          </div>
          <div className={`subagent-default-row subagent-switch-row ${draft.backgroundEnabled ? '' : 'is-disabled'}`}>
            <span className="subagent-label"><span>允许联系主智能体</span> <InfoHint label="后台任务可向主智能体提问；收到回复后会继续执行。" /></span>
            <button
              type="button"
              role="switch"
              className={`switch ${draft.supervisorEnabled ? 'is-on' : ''}`}
              aria-label="允许联系主智能体"
              aria-checked={draft.supervisorEnabled}
              disabled={busy || !snapshot || !draft.backgroundEnabled}
              onClick={() => setDraft((current) => ({
                ...current,
                supervisorEnabled: !current.supervisorEnabled,
              }))}
            >
              <span />
            </button>
          </div>
        </div>
        <Accordion className="subagent-form-disclosure subagent-advanced" summary="运行限制与预算" description={limitSummary}>
          <div className="role-runtime-content">
            <section className="role-runtime-group">
              <h4>后台与调度</h4>
              <div className="role-runtime-fields">
                <div className="subagent-field">
                  <div className="subagent-label"><label htmlFor={`${inputPrefix}-maxConcurrent`}>最大并发</label>
                    <InfoHint label="当前主会话中可以同时运行的后台任务数量。" /></div>
                  <div className="role-number">
                    <input id={`${inputPrefix}-maxConcurrent`} type="number" inputMode="numeric" min={1} max={16}
                      aria-describedby={`${inputPrefix}-maxConcurrent-unit`} value={draft.maxConcurrent}
                      onChange={event => setDraft(current => ({ ...current, maxConcurrent: Number(event.target.value) }))} />
                    <small id={`${inputPrefix}-maxConcurrent-unit`}>个</small>
                  </div>
                </div>
                <div className="subagent-field">
                  <div className="subagent-label"><label htmlFor={`${inputPrefix}-maxSpawns`}>最多创建</label>
                    <InfoHint label="一个主会话累计可创建的子会话数量。" /></div>
                  <div className="role-number">
                    <input id={`${inputPrefix}-maxSpawns`} type="number" inputMode="numeric" min={1} max={100}
                      aria-describedby={`${inputPrefix}-maxSpawns-unit`} value={draft.maxSpawns}
                      onChange={event => setDraft(current => ({ ...current, maxSpawns: Number(event.target.value) }))} />
                    <small id={`${inputPrefix}-maxSpawns-unit`}>个</small>
                  </div>
                </div>
                <div className="subagent-field">
                  <div className="subagent-label"><label htmlFor={`${inputPrefix}-waitTimeoutMs`}>默认等待时间</label>
                    <InfoHint align="end" label="超时只结束本次等待，不会停止子智能体。" /></div>
                  <div className="role-number">
                    <input id={`${inputPrefix}-waitTimeoutMs`} type="number" inputMode="numeric" min={1} max={600} step={1}
                      aria-describedby={`${inputPrefix}-waitTimeoutMs-unit`} value={Math.round(draft.waitTimeoutMs / 1_000)}
                      onChange={event => setDraft(current => ({ ...current, waitTimeoutMs: Number(event.target.value) * 1_000 }))} />
                    <small id={`${inputPrefix}-waitTimeoutMs-unit`}>秒</small>
                  </div>
                </div>
              </div>
            </section>
            <section className="role-runtime-group">
              <h4>工作树</h4>
              <div className="role-runtime-fields">
                <div className="subagent-field">
                  <span className="subagent-label">工作树隔离 <InfoHint label="隔离任务只修改 Studio 管理的 Git 工作树，结束前不接触项目文件。" /></span>
                  <Select label="子智能体工作树隔离方式" value={draft.worktreeIsolation} disabled={busy || !snapshot}
                    options={[
                      { value: 'background', label: '后台任务 · 推荐' },
                      { value: 'always', label: '所有子智能体' },
                      { value: 'off', label: '关闭 · 共享工作区' },
                    ]}
                    onChange={value => setDraft(current => ({ ...current, worktreeIsolation: value as SubagentConfig['worktreeIsolation'] }))} />
                </div>
                <div className={`subagent-field ${draft.worktreeIsolation === 'off' ? 'is-disabled' : ''}`}>
                  <div className="subagent-label"><label htmlFor={`${inputPrefix}-worktreeLimit`}>工作树保留上限</label>
                    <InfoHint label="达到上限后会阻止新建隔离任务，直到合并或丢弃已有改动。" /></div>
                  <div className="role-number">
                    <input id={`${inputPrefix}-worktreeLimit`} type="number" inputMode="numeric" min={1} max={50}
                      aria-describedby={`${inputPrefix}-worktreeLimit-unit`} disabled={draft.worktreeIsolation === 'off'} value={draft.worktreeLimit}
                      onChange={event => setDraft(current => ({ ...current, worktreeLimit: Number(event.target.value) }))} />
                    <small id={`${inputPrefix}-worktreeLimit-unit`}>个</small>
                  </div>
                </div>
                <div className="subagent-field role-runtime-wide-field">
                  <span className="subagent-label">隔离工作树位置 <InfoHint label="只影响新建工作树。可以选择其他磁盘，已有工作树仍在原位置。" /></span>
                  <button type="button" className="settings-outline subagent-storage-path" disabled={busy || draft.worktreeIsolation === 'off'}
                    title={draft.worktreeParent || 'Studio 数据目录下的 worktrees'}
                    onClick={async () => {
                      try {
                        const directory = await window.piApi.pickWorktreeParent();
                        if (directory) setDraft(current => ({ ...current, worktreeParent: directory }));
                      } catch (cause) { showToast(cause instanceof Error ? cause.message : String(cause), 'error'); }
                    }}>
                    <FolderOpen aria-hidden="true" />
                    <span>{draft.worktreeParent || '选择位置 · 当前使用 Studio 数据目录'}</span>
                  </button>
                  {draft.worktreeParent && <button type="button" className="settings-text-button" disabled={busy}
                    onClick={() => setDraft(current => ({ ...current, worktreeParent: '' }))}>恢复默认位置</button>}
                </div>
              </div>
            </section>
            <section className="role-runtime-group">
              <h4>运行预算</h4>
              <div className="role-runtime-fields">
                <div className="subagent-field">
                  <div className="subagent-label"><label htmlFor={`${inputPrefix}-budgetTokens`}>Token 预算</label>
                    <InfoHint label="按当前会话内所有子智能体的模型请求累计；0 表示不限制。" /></div>
                  <div className="role-number">
                    <input id={`${inputPrefix}-budgetTokens`} type="number" inputMode="numeric" min={0} max={100_000_000} step={1_000}
                      aria-describedby={`${inputPrefix}-budgetTokens-unit`} value={draft.budgetTokens} placeholder="0 · 不限制"
                      onChange={event => setDraft(current => ({ ...current, budgetTokens: Number(event.target.value) }))} />
                    <small id={`${inputPrefix}-budgetTokens-unit`}>tokens</small>
                  </div>
                </div>
                <div className="subagent-field">
                  <div className="subagent-label"><label htmlFor={`${inputPrefix}-budgetCostUsd`}>参考成本预算</label>
                    <InfoHint label="使用模型返回的参考价格；没有返回价格时不会估算。" /></div>
                  <div className="role-number">
                    <input id={`${inputPrefix}-budgetCostUsd`} type="number" inputMode="decimal" min={0} max={100_000} step={0.01}
                      aria-describedby={`${inputPrefix}-budgetCostUsd-unit`} value={draft.budgetCostUsd} placeholder="0 · 不限制"
                      onChange={event => setDraft(current => ({ ...current, budgetCostUsd: Number(event.target.value) }))} />
                    <small id={`${inputPrefix}-budgetCostUsd-unit`}>USD</small>
                  </div>
                </div>
                <div className={`subagent-field ${draft.budgetTokens || draft.budgetCostUsd ? '' : 'is-disabled'}`}>
                  <span className="subagent-label">达到预算后 <InfoHint align="end" label="不会中断正在执行的任务；策略从下一安全请求边界开始生效。" /></span>
                  <Select label="子智能体预算超限策略" value={draft.budgetAction}
                    disabled={busy || !snapshot || (!draft.budgetTokens && !draft.budgetCostUsd)}
                    options={[{ value: 'warn', label: '仅提醒' }, { value: 'stop', label: '阻止新任务' }]}
                    onChange={value => setDraft(current => ({ ...current, budgetAction: value === 'stop' ? 'stop' : 'warn' }))} />
                </div>
              </div>
            </section>
          </div>
        </Accordion>
      </section>
      <section className="subagent-defaults-section" aria-labelledby="subagent-model">
        <div className="subagent-section-heading">
          <h3 id="subagent-model">模型与思考</h3>
          <InfoHint label="角色可以固定模型。其余角色会使用调用时指定的模型，或依次从当前工作区、所有工作区和父智能体取得默认模型。" />
        </div>
        <div className="subagent-model-grid">
          <div className="subagent-field">
            <span className="subagent-label">默认模型 <InfoHint label="留空时跟随父智能体。" /></span>
            <Select
              disabled={busy || !snapshot}
              label="子智能体默认模型"
              value={draft.defaultModel}
              options={defaultModelOptions}
              onChange={updateModel}
            />
          </div>
          <div className="subagent-field">
            <span className="subagent-label">默认思考强度</span>
            <Select
              disabled={busy || !snapshot}
              label="子智能体默认思考强度"
              value={draft.defaultThinking}
              options={thinkingOptions(thinkingLevels, '跟随父智能体')}
              onChange={(value) => setDraft((current) => ({
                ...current,
                defaultThinking: value as SubagentThinking,
              }))}
            />
          </div>
        </div>
        <div className="subagent-default-row subagent-thinking-limit">
          <span className="subagent-label">思考强度上限 <InfoHint label="阻止子智能体使用更高成本的推理强度。" /></span>
          <Select
            disabled={busy || !snapshot}
            label="子智能体思考强度上限"
            value={draft.maxThinking}
            options={thinkingOptions(snapshot?.thinkingLevels || [], '不限制')}
            onChange={(value) => setDraft((current) => ({
              ...current,
              maxThinking: value as SubagentThinking,
            }))}
          />
        </div>
      </section>
      <section className="subagent-defaults-section subagent-worktrees" aria-labelledby="subagent-worktrees">
        <div className="subagent-section-heading">
          <h3 id="subagent-worktrees" ref={worktreesHeading} tabIndex={-1}>隔离工作树</h3>
          <InfoHint label="在应用、丢弃或清理前，子智能体产生的文件改动会保留在 Studio 私有目录中。" />
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
        {worktreeLoadError && <SettingsToast tone="error" message={worktreeLoadError}>
          <button type="button" className="settings-outline" disabled={busy} onClick={() => void reloadWorktrees()}>重新读取工作树</button>
        </SettingsToast>}
        <div className="subagent-worktree-list">
          {worktrees.map((worktree) => (
            <article className={`subagent-worktree-row is-${worktree.status}`} key={worktree.id} data-worktree-id={worktree.id}>
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
                  <Accordion summary="查看改动文件">
                    <ul>
                      {worktree.files!.map((file) => (
                        <li key={`${file.status}:${file.path}`}>
                          <span>{file.status === 'added' ? 'A' : file.status === 'deleted' ? 'D' : 'M'}</span>
                          <code>{file.path}</code>
                        </li>
                      ))}
                    </ul>
                  </Accordion>
                )}
              </div>
              <div className="subagent-worktree-actions">
                <button
                  type="button"
                  className="icon-button"
                  disabled={!worktree.directoryExists}
                  title={revealFileLabel()}
                  aria-label={`显示工作树 ${worktree.name}`}
                  onClick={() => void revealWorktree(worktree.id)}
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
            <p className="subagent-empty">没有待处理工作树</p>
          )}
        </div>
      </section>
      <section className="subagent-defaults-section" aria-labelledby="subagent-tools">
        <div className="subagent-section-heading">
          <h3 id="subagent-tools">工具权限</h3>
          <InfoHint label="默认继承父智能体当前工具；也可以保存一份更窄的白名单。" />
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
          <div>
            <strong>{explicitTools ? `仅允许 ${draft.allowedTools.length} 个工具` : '沿用父智能体当前工具'}</strong>
          </div>
        </div>
        {missingTools.length > 0 && (
          <div className="settings-error" role="status">
            有 {missingTools.length} 个已保存工具当前不可用：{missingTools.join('、')}。它可能来自已删除的扩展或 MCP。
          </div>
        )}
        {parentTools.length > 0 && (
          <div className="subagent-tool-toolbar">
            <input
              type="search"
              className="subagent-tool-filter"
              value={toolFilter}
              placeholder="搜索工具名或说明…"
              aria-label="搜索工具"
              onKeyDown={event => { if (event.key === 'Enter' && !isComposingKey(event.nativeEvent)) event.preventDefault(); }}
              onChange={event => {
                setToolFilter(event.target.value);
                setCollapsedSearchGroups([]);
              }}
            />
            <span className="subagent-tool-total">
              {toolFilter.trim() ? `${toolGroups.reduce((sum, group) => sum + group.tools.length, 0)} / ${parentTools.length}` : `${parentTools.length} 个工具`}
            </span>
            <button
              type="button"
              className="settings-text-button"
              disabled={!toolGroups.length}
              onClick={() => setCollapsedGroups(
                toolGroups.every((group) => collapsedGroups.includes(group.label))
                  ? []
                  : toolGroups.map((group) => group.label),
              )}
            >
              {toolGroups.length && toolGroups.every((group) => collapsedGroups.includes(group.label)) ? '全部展开' : '全部折叠'}
            </button>
          </div>
        )}
        <div className="subagent-tool-groups">
          {toolGroups.map((group) => {
            const open = !collapsedGroups.includes(group.label);
            const names = group.tools.map((tool) => tool.name);
            const selectedInGroup = names.filter((name) => !explicitTools || selectedTools.has(name)).length;
            return (
              <section key={group.label} className={`subagent-tool-group ${open ? 'is-open' : ''}`}>
                <header className="subagent-tool-group-head">
                  <button
                    type="button"
                    className="subagent-tool-group-toggle settings-row-link"
                    aria-expanded={open}
                    onClick={() => toggleToolGroup(group.label)}
                  >
                    <ChevronRight className="settings-row-link-indicator" aria-hidden="true" />
                    <strong>{group.label}</strong>
                    <span className="subagent-tool-group-count">{selectedInGroup}/{group.tools.length}</span>
                  </button>
                  <button
                    type="button"
                    className="settings-text-button"
                    onClick={() => setToolsEnabled(names, selectedInGroup < group.tools.length)}
                  >
                    {selectedInGroup < group.tools.length ? '全选' : '清除'}
                  </button>
                </header>
                {open && <div className="subagent-tool-group-body">
                  {group.tools.map((tool) => {
                    const checked = !explicitTools || selectedTools.has(tool.name);
                    return (
                      <label
                        key={`${tool.source.key}:${tool.name}`}
                        className={`subagent-tool-row ${checked ? 'is-enabled' : ''}`}
                        title={tool.description || tool.name}
                      >
                        <input
                          type="checkbox"
                          checked={checked}
                          aria-label={`允许工具 ${tool.name}`}
                          onChange={() => toggleTool(tool.name)}
                        />
                        <span className="subagent-tool-copy">
                          <strong>{tool.name}</strong>
                          {tool.description && <small>{tool.description}</small>}
                        </span>
                      </label>
                    );
                  })}
                </div>}
              </section>
            );
          })}
          {!parentTools.length && (
            <p className="subagent-empty">当前父智能体没有可用工具</p>
          )}
          {parentTools.length > 0 && !toolGroups.length && (
            <p className="subagent-empty">没有匹配「{toolFilter.trim()}」的工具</p>
          )}
        </div>
      </section>
      </div>}
    </div>
  </SettingsDialog>{confirmation.dialog}</>;
}
