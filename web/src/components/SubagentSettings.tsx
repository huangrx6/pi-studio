import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Bot,
  Check,
  ChevronRight,
  CircleAlert,
  Cpu,
  LoaderCircle,
  Package,
  RotateCw,
  Save,
  Shield,
  Sparkles,
} from 'lucide-react';
import { Select } from './Select';
import type {
  SubagentAgentDefinition,
  SubagentConfig,
  SubagentSettingsSnapshot,
  SubagentThinking,
} from '../subagent-types';

const THINKING_LABEL: Record<Exclude<SubagentThinking, ''>, string> = {
  off: '关闭',
  minimal: '极少',
  low: '低',
  medium: '中',
  high: '高',
  xhigh: '极高',
  max: '最大',
};
const THINKING_LEVELS = new Set(Object.keys(THINKING_LABEL));

const SOURCE_LABEL: Record<SubagentAgentDefinition['source'], string> = {
  builtin: '内置',
  package: '扩展包',
  user: '全局',
  project: '项目',
};

function thinkingLabel(value: string): string {
  if (value === 'false') return '关闭';
  return value && Object.hasOwn(THINKING_LABEL, value)
    ? THINKING_LABEL[value as Exclude<SubagentThinking, ''>]
    : value || '父 Agent';
}

function emptyConfig(): SubagentConfig {
  return {
    defaultModel: '',
    defaultProvider: '',
    defaultThinking: '',
    maxThinking: '',
    agentOverrides: {},
  };
}

function configFor(snapshot: SubagentSettingsSnapshot, scope: 'user' | 'project'): SubagentConfig {
  return snapshot[scope];
}

function cloneConfig(config: SubagentConfig): SubagentConfig {
  return {
    ...config,
    agentOverrides: Object.fromEntries(
      Object.entries(config.agentOverrides).map(([name, value]) => [name, { ...value }]),
    ),
  };
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

function modelBaseRef(value?: string): string {
  const text = value?.trim() || '';
  const separator = text.lastIndexOf(':');
  if (separator < 0) return text;
  return THINKING_LEVELS.has(text.slice(separator + 1))
    ? text.slice(0, separator)
    : text;
}

function modelForRef(ref: string | undefined, models: SubagentSettingsSnapshot['models']) {
  const base = modelBaseRef(ref);
  return base ? models.find((model) => model.modelRef === base) : undefined;
}

function OverrideRow({
  agent,
  draft,
  scope,
  models,
  allThinkingLevels,
  currentModel,
  onChange,
}: {
  agent: SubagentAgentDefinition;
  draft: SubagentConfig;
  scope: 'user' | 'project';
  models: SubagentSettingsSnapshot['models'];
  allThinkingLevels: SubagentThinking[];
  currentModel: string;
  onChange: (next: { model: string; thinking: SubagentThinking }) => void;
}) {
  const override = draft.agentOverrides[agent.name] || { model: '', thinking: '' as const };
  const overrideModel = override.model === 'inherit' ? currentModel : override.model;
  const definitionModel = agent.model === 'inherit' ? currentModel : agent.model;
  const resolvedModel = overrideModel || definitionModel || draft.defaultModel || currentModel;
  const modelInfo = modelForRef(resolvedModel, models);
  // A known non-reasoning model deliberately yields an empty list: adding a
  // thinking value there would advertise a setting that cannot take effect.
  const levels = modelInfo ? modelInfo.thinkingLevels : allThinkingLevels;
  const modelOptions = [
    { value: '', label: '使用默认解析' },
    { value: 'inherit', label: '强制跟随父 Agent' },
    ...models.map((model) => ({
      value: model.modelRef,
      label: model.label,
      description: `${model.provider} · ${model.modelRef}`,
    })),
  ];
  const fallbackRef = definitionModel || draft.defaultModel || currentModel;
  const fallbackModel = modelForRef(fallbackRef, models)?.label
    || fallbackRef
    || '父 Agent';
  const fallbackThinking = thinkingLabel(agent.thinking || draft.defaultThinking);
  return <article className={`subagent-role ${scope === 'project' ? 'is-project' : ''}`}>
    <div className="subagent-role-identity">
      <span className={`subagent-role-icon is-${agent.source}`}>
        {agent.source === 'package' ? <Package /> : <Bot />}
      </span>
      <div>
        <div className="subagent-role-title">
          <strong>{agent.name}</strong>
          <span className={`subagent-source is-${agent.source}`}>{SOURCE_LABEL[agent.source]}</span>
        </div>
        <p>{agent.description || '这个角色没有填写说明。'}</p>
        <span className="subagent-role-path" title={agent.path}>{agent.path}</span>
      </div>
    </div>
    <div className="subagent-role-controls">
      <div className="subagent-role-field">
        <span><Cpu />模型</span>
        <Select
          label={`${agent.name} 模型`}
          value={override.model}
          options={modelOptions}
          onChange={(model) => onChange({ model, thinking: override.thinking })}
        />
        <small>
          {override.model ? '覆盖 Agent 定义与共享默认。' : `当前解析：${fallbackModel}`}
        </small>
      </div>
      <div className="subagent-role-field">
        <span><Sparkles />思考强度</span>
        <Select
          label={`${agent.name} 思考强度`}
          value={override.thinking}
          options={thinkingOptions(levels, '沿用 Agent 定义 / 默认')}
          onChange={(thinking) => onChange({ model: override.model, thinking: thinking as SubagentThinking })}
        />
        <small>
          {override.thinking ? '覆盖此 Agent 的思考强度。' : `当前回落：${fallbackThinking}`}
        </small>
      </div>
    </div>
  </article>;
}

export function SubagentSettings({
  cwd,
  enabledAgentTools,
  onOpenAgentTools,
}: {
  cwd: string;
  enabledAgentTools?: string[];
  onOpenAgentTools?: () => void;
}) {
  const [snapshot, setSnapshot] = useState<SubagentSettingsSnapshot | null>(null);
  const [scope, setScope] = useState<'user' | 'project'>('user');
  const [draft, setDraft] = useState<SubagentConfig>(emptyConfig);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestRef = useRef(0);

  async function load() {
    const request = ++requestRef.current;
    setLoading(true);
    setError(null);
    try {
      const next = await window.piApi.subagentSettings(cwd);
      if (request !== requestRef.current) return;
      setSnapshot(next);
      setDraft(cloneConfig(configFor(next, scope)));
    } catch (cause) {
      if (request === requestRef.current) setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (request === requestRef.current) setLoading(false);
    }
  }

  useEffect(() => { void load(); }, [cwd]);

  useEffect(() => {
    if (snapshot) setDraft(cloneConfig(configFor(snapshot, scope)));
  }, [scope, snapshot]);

  const savedDraft = snapshot ? configFor(snapshot, scope) : emptyConfig();
  const dirty = JSON.stringify(draft) !== JSON.stringify(savedDraft);
  const path = snapshot ? (scope === 'user' ? snapshot.userPath : snapshot.projectPath) : '';
  const scopeText = scope === 'user' ? '全局设置' : '当前项目';
  const defaultModelOptions = useMemo(() => [
    { value: '', label: '跟随父 Agent' },
    ...(snapshot?.models || []).map((model) => ({
      value: model.modelRef,
      label: model.label,
      description: `${model.provider} · ${model.modelRef}`,
    })),
  ], [snapshot?.models]);
  const defaultResolvedModel = draft.defaultModel || snapshot?.currentModel || '';
  const defaultModelInfo = modelForRef(defaultResolvedModel, snapshot?.models || []);
  const defaultThinkingLevels = defaultModelInfo
    ? defaultModelInfo.thinkingLevels
    : snapshot?.thinkingLevels || [];
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

  function updateOverride(name: string, next: { model: string; thinking: SubagentThinking }) {
    setDraft((current) => {
      const overrides = { ...current.agentOverrides };
      // Keep an explicit empty row so saving can clear pre-existing model /
      // thinking fields while preserving extension-owned fields for the role.
      overrides[name] = next;
      return { ...current, agentOverrides: overrides };
    });
  }

  async function save() {
    if (!snapshot) return;
    setSaving(true);
    setError(null);
    try {
      const next = await window.piApi.saveSubagentSettings({ cwd, scope, settings: draft });
      setSnapshot(next);
      setDraft(cloneConfig(configFor(next, scope)));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  }

  if (loading && !snapshot) {
    return <div className="settings-loading" role="status"><LoaderCircle className="spin" />正在读取子 Agent 配置…</div>;
  }

  return <div className="settings-sections subagent-settings">
    <section className="settings-card">
      <div className="settings-card-head">
        <div>
          <h2>子 Agent <span className="count-badge">{snapshot?.agents.length ?? 0}</span></h2>
          <p>每个子 Agent 使用独立会话，可独立选择模型与思考强度。Studio 只同步配置，实际运行由 pi-subagents 负责。</p>
        </div>
        <button className="settings-add-button" disabled={loading || saving} onClick={() => void load()}>
          {loading ? <LoaderCircle className="spin" /> : <RotateCw />}
          刷新
        </button>
      </div>
      <div className={`subagent-runtime-status is-${runtimeState}`}>
        {runtimeReady ? <Check /> : runtimeState === 'checking' ? <LoaderCircle className="spin" /> : <CircleAlert />}
        <div>
          <strong>{!snapshot?.installed
            ? '没有找到 pi-subagents'
            : toolsReady === undefined
              ? '正在核对子 Agent 工具'
              : toolsReady
                ? 'pi-subagents 已就绪'
                : 'subagent 工具尚未启用'}</strong>
          <span>{!snapshot?.installed
            ? '配置仍会保留；安装扩展并启用 subagent 工具后即可使用。'
            : toolsReady
              ? '设置会写入 Pi 的 settings.json，并热更新父会话；下一次启动子 Agent 时直接使用最新配置。'
              : '模型和思考设置仍会保留；到 Agent 工具中启用 subagent 后，父 Agent 才能启动子会话。'}</span>
        </div>
        {snapshot?.installed && toolsReady === false && onOpenAgentTools && <button type="button" className="settings-outline" onClick={onOpenAgentTools}>去启用</button>}
      </div>
      <div className="settings-scope-tabs" role="tablist" aria-label="子 Agent 配置范围">
        <button role="tab" aria-selected={scope === 'user'} className={scope === 'user' ? 'is-active' : ''} onClick={() => setScope('user')}>全局</button>
        <button role="tab" aria-selected={scope === 'project'} className={scope === 'project' ? 'is-active' : ''} onClick={() => setScope('project')}>当前项目</button>
      </div>
      <div className="subagent-config-path">
        <span>{scopeText}</span>
        <code title={path}>{path || '正在解析路径…'}</code>
        {scope === 'project' && snapshot && !snapshot.projectRootExists && <small>首次保存会创建 <code>.pi/settings.json</code></small>}
      </div>
    </section>

    <section className="settings-card">
      <div className="settings-card-head">
        <div>
          <h2>共享默认</h2>
          <p>这些值只在子 Agent 自己或角色覆盖没有指定时生效。项目管理级配置优先于全局配置。</p>
        </div>
      </div>
      <div className="subagent-default-grid">
        <div className="settings-field">
          <span>默认模型</span>
          <Select
            label="子 Agent 默认模型"
            value={draft.defaultModel}
            options={defaultModelOptions}
            onChange={(defaultModel) => setDraft((current) => ({ ...current, defaultModel }))}
          />
          <small>留空时沿用父 Agent 当前模型。角色定义里的模型仍拥有更高优先级。</small>
        </div>
        <div className="settings-field">
          <span>默认思考强度</span>
          <Select
            label="子 Agent 默认思考强度"
            value={draft.defaultThinking}
            options={thinkingOptions(defaultThinkingLevels, '不设置共享默认')}
            onChange={(value) => setDraft((current) => ({ ...current, defaultThinking: value as SubagentThinking }))}
          />
          <small>用于没有思考强度定义的角色；单个角色的覆盖优先级更高。</small>
        </div>
        <div className="settings-field">
          <span><Shield />思考强度上限</span>
          <Select
            label="子 Agent 思考强度上限"
            value={draft.maxThinking}
            options={thinkingOptions(snapshot?.thinkingLevels || [], '不限制')}
            onChange={(value) => setDraft((current) => ({ ...current, maxThinking: value as SubagentThinking }))}
          />
          <small>这是硬上限。任何来源请求更高强度时，pi-subagents 会在子 Agent 启动前拒绝。</small>
        </div>
      </div>
    </section>

    <section className="settings-card subagent-roster-card">
      <div className="settings-card-head">
        <div>
          <h2>角色覆盖 <span className="count-badge">{snapshot?.agents.length ?? 0}</span></h2>
          <p>按角色固定模型和思考强度。留空会依次回落到角色定义、共享默认和父 Agent。</p>
        </div>
      </div>
      <div className="subagent-priority-note">
        <ChevronRight />
        <span>覆盖优先级</span>
        <code>当前角色</code>
        <ChevronRight />
        <code>Agent 定义</code>
        <ChevronRight />
        <code>共享默认</code>
        <ChevronRight />
        <code>父 Agent</code>
      </div>
      <div className="subagent-role-list">
        {snapshot?.agents.map((agent) => <OverrideRow
          key={`${scope}:${agent.name}:${agent.path}`}
          agent={agent}
          draft={draft}
          scope={scope}
          models={snapshot.models}
          allThinkingLevels={snapshot.thinkingLevels}
          currentModel={snapshot.currentModel}
          onChange={(next) => updateOverride(agent.name, next)}
        />)}
        {!snapshot?.agents.length && <div className="settings-empty">没有发现可配置的子 Agent 定义。</div>}
      </div>
    </section>

    {error && <div className="settings-error" role="alert">{error}</div>}
    <div className="subagent-savebar">
      <div>
        <strong>{dirty ? `${scopeText}有未保存的更改` : '已与 Pi 配置同步'}</strong>
        <span>{path} · 保存后会热更新，无需重启 App</span>
      </div>
      <button className="settings-outline" disabled={!dirty || saving} onClick={() => setDraft(cloneConfig(savedDraft))}>撤销</button>
      <button className="settings-save" disabled={!dirty || saving} onClick={() => void save()}>
        {saving ? <LoaderCircle className="spin" /> : <Save />}
        {saving ? '正在保存…' : '保存配置'}
      </button>
    </div>
  </div>;
}
