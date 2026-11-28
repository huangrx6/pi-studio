import { useMemo, useState } from 'react';
import { Check, Plus, Trash2 } from 'lucide-react';
import { Accordion } from '../../shared/Accordion';
import { useActionConfirmation } from '../../shared/ConfirmDialog';
import { errorText } from '../../shared/error-text';
import { isComposingKey } from '../../shared/keyboard-navigation';
import { Select } from '../../shared/Select';
import { useSettingsToast } from '../../shared/SettingsToast';
import type {
  PermissionDecision,
  PermissionEvaluation,
  PermissionMode,
  PermissionPolicy,
  PermissionPolicyState,
  PermissionRule,
  PermissionScope,
} from '../../types/permission-types';
import {
  matchForCondition,
  permissionDraftError,
  ruleCondition,
  type RuleCondition,
} from './permission-policy-editor';

export const PERMISSION_DECISION_LABELS: Record<PermissionDecision, string> = {
  allow: '允许',
  ask: '询问',
  deny: '拒绝',
};

const DECISION_OPTIONS = (Object.keys(PERMISSION_DECISION_LABELS) as PermissionDecision[])
  .map((value) => ({ value, label: PERMISSION_DECISION_LABELS[value] }));

const SCOPE_LABELS: Record<PermissionScope, string> = {
  user: '全局',
  workspace: '当前工作区',
  session: '当前会话',
};

const CONDITION_LABELS: Record<RuleCondition, string> = {
  tool: '工具本身',
  commandPrefix: '命令前缀',
  commandExact: '完整命令',
  pathWithin: '仅工作区路径',
  pathGlob: '路径通配符',
  pathExact: '精确路径',
};

const PREVIEW_TOOL_OPTIONS = [
  'bash',
  'read',
  'write',
  'edit',
  'mcp__github__search',
  'custom_tool',
].map((value) => ({ value, label: value }));

const FALLBACK_MODE_CATALOG: PermissionPolicyState['catalog'] = {
  modes: [
    {
      id: 'ask',
      label: '严格确认',
      description: '读取和检索类只读工具外，写文件、命令执行和未知工具均先确认。',
      defaultDecision: 'ask',
    },
    {
      id: 'smart',
      label: '帮我批准（默认）',
      description: '自动允许只读和工作区内安全操作；跨工作区、外部脚本与高风险动作需要确认。',
      defaultDecision: 'ask',
    },
    {
      id: 'full',
      label: '完全权限',
      description: '普通工具、跨工作区操作与脚本直接执行；显式拒绝规则与高危删除保护仍然生效。',
      defaultDecision: 'allow',
    },
  ],
  presetDefaults: {
    ask: 'ask',
    smart: 'ask',
    full: 'allow',
  },
  decisions: [
    { id: 'allow', label: '允许' },
    { id: 'ask', label: '询问' },
    { id: 'deny', label: '拒绝' },
  ],
  decisionsAreValid: ['allow', 'ask', 'deny'],
};

function conditionValue(rule: PermissionRule) {
  return rule.match.commandPrefix
    || rule.match.commandExact
    || rule.match.pathExact
    || rule.match.pathGlob
    || '';
}

function conditionsForTool(tool: string): RuleCondition[] {
  if (tool === '*') return ['commandPrefix', 'commandExact', 'pathWithin', 'pathGlob', 'pathExact', 'tool'];
  if (tool === 'bash') return ['commandPrefix', 'commandExact', 'tool'];
  if (['read', 'write', 'edit', 'ls', 'find', 'grep'].includes(tool)) {
    return ['pathWithin', 'pathGlob', 'pathExact', 'tool'];
  }
  return ['tool'];
}

function conditionPlaceholder(condition: RuleCondition) {
  if (condition === 'commandPrefix') return '例如 git status';
  if (condition === 'commandExact') return '例如 git push origin main';
  if (condition === 'pathExact') return '例如 src/config.ts';
  if (condition === 'pathGlob') return '例如 **/.env*';
  if (condition === 'pathWithin') return '工作区内的全部路径';
  return '工具名本身已足够精确';
}

export function PermissionPolicyFormFields({
  policy,
  catalog = FALLBACK_MODE_CATALOG,
  busy = false,
  dirty = false,
  variant = 'cards',
  previewLabel = '方案预览',
  onChange,
  onEvaluate,
}: {
  policy: PermissionPolicy;
  catalog?: PermissionPolicyState['catalog'];
  busy?: boolean;
  dirty?: boolean;
  variant?: 'cards' | 'embedded';
  previewLabel?: string;
  onChange: (next: PermissionPolicy) => void;
  onEvaluate: (policy: PermissionPolicy, call: { name: string; arguments?: Record<string, unknown> }) => Promise<PermissionEvaluation>;
}) {
  const showToast = useSettingsToast();
  const actionConfirmation = useActionConfirmation();
  const [newTool, setNewTool] = useState('');
  const [newDecision, setNewDecision] = useState<PermissionDecision>('ask');
  const [rulesOpen, setRulesOpen] = useState(false);
  const [previewTool, setPreviewTool] = useState('bash');
  const [previewCommand, setPreviewCommand] = useState('git status');
  const [previewPath, setPreviewPath] = useState('src/App.tsx');
  const previewUsesPath = ['read', 'write', 'edit'].includes(previewTool);
  const [preview, setPreview] = useState<PermissionEvaluation | null>(null);
  const [previewError, setPreviewError] = useState('');
  const [previewing, setPreviewing] = useState(false);

  const toolOverrides = useMemo(
    () => Object.entries(policy.tools || {}).sort(([left], [right]) => left.localeCompare(right)),
    [policy.tools],
  );

  function clearPreview() {
    setPreview(null);
    setPreviewError('');
  }

  function patch(partial: Partial<PermissionPolicy>) {
    clearPreview();
    onChange({ ...policy, ...partial });
  }

  async function applyPreset(mode: PermissionMode) {
    if (busy) return;
    if (mode === 'full' && policy.preset !== 'full') {
      const accepted = await actionConfirmation.confirm({
        title: '启用完全权限？',
        description: '普通工具、跨工作区操作和无法静态确认的脚本会直接执行。你显式设置为“询问/拒绝”的规则，以及明显的删除和系统破坏命令仍会生效。',
        confirmLabel: '启用完全权限',
        tone: 'danger',
      });
      if (!accepted) return;
    }
    patch({
      preset: mode,
      default: catalog.presetDefaults[mode],
    });
  }

  function addToolOverride() {
    if (!newTool.trim()) return;
    patch({ tools: { ...policy.tools, [newTool.trim()]: newDecision } });
    setNewTool('');
    setNewDecision('ask');
  }

  function addRule() {
    const rule: PermissionRule = {
      id: `rule-${globalThis.crypto?.randomUUID?.() || Date.now()}`,
      label: '自定义规则',
      decision: 'ask',
      match: { tool: '*' },
    };
    patch({ rules: [...policy.rules, rule] });
  }

  function updateRule(id: string, updater: (rule: PermissionRule) => PermissionRule) {
    patch({ rules: policy.rules.map(rule => rule.id === id ? updater(rule) : rule) });
  }

  function removeRule(id: string) {
    patch({ rules: policy.rules.filter(rule => rule.id !== id) });
  }

  async function runPreview() {
    const validation = permissionDraftError(policy);
    if (validation) {
      showToast(validation, 'error');
      setRulesOpen(true);
      return;
    }
    setPreviewing(true);
    clearPreview();
    try {
      const args = previewTool === 'bash'
        ? { command: previewCommand }
        : previewUsesPath
          ? { path: previewPath }
          : {};
      const result = await onEvaluate(policy, { name: previewTool, arguments: args });
      setPreview(result);
    } catch (reason) {
      setPreviewError(errorText(reason));
    } finally {
      setPreviewing(false);
    }
  }

  const sectionClass = variant === 'embedded' ? 'permission-embedded-section' : 'settings-preference-card permission-policy-card';
  const previewClass = variant === 'embedded' ? 'permission-embedded-preview permission-policy-preview' : 'settings-preference-card permission-policy-preview';

  return <>
    <section className={sectionClass}>
      <header className="permission-policy-section-head"><h3>基础模式</h3></header>
      <div className="permission-policy-presets" role="group" aria-label="权限基础模式">
        {catalog.modes.map((mode) => {
          const selected = policy.preset === mode.id;
          const customDefault = selected && policy.default !== catalog.presetDefaults[mode.id];
          const description = !customDefault ? mode.description
            : mode.id === 'ask' ? `已自定义默认决定为${PERMISSION_DECISION_LABELS[policy.default]}；显式规则与保护检查仍生效。`
              : mode.id === 'smart' ? `读取、检索和长期任务管理工具自动允许，其他调用默认${PERMISSION_DECISION_LABELS[policy.default]}；显式规则与保护检查优先。`
                : `读取、检索和长期任务管理工具自动允许，其他调用默认${PERMISSION_DECISION_LABELS[policy.default]}；跨工作区与脚本检查不再额外要求确认，显式规则和高危命令拦截仍生效。`;
          const tierLabel = mode.id === 'ask' ? '严格' : mode.id === 'smart' ? '推荐' : '高权限';
          return <button
            key={mode.id}
            type="button"
            disabled={busy}
            aria-pressed={selected}
            className={`permission-preset${selected ? ' is-active' : ''}`}
            onClick={() => void applyPreset(mode.id)}
          >
            <span className="permission-preset-copy">
              <span className="permission-preset-head">
                <strong>{mode.label}</strong>
                <span className={`permission-preset-tier is-${mode.id}`}>{tierLabel}</span>
              </span>
              <small>{description}</small>
            </span>
            <span className="permission-preset-check" aria-hidden="true">{selected && <Check />}</span>
          </button>;
        })}
      </div>
      <div className="permission-policy-default">
        <div><span>默认决定</span></div>
        <Select
          disabled={busy}
          label="未命中时的权限决定"
          value={policy.default}
          options={DECISION_OPTIONS}
          onChange={(value) => patch({ default: value as PermissionDecision })}
        />
      </div>
    </section>

    <section className={sectionClass}>
      <header className="permission-policy-section-head"><h3>例外规则</h3></header>
      <Accordion className="permission-disclosure permission-overrides" summary="工具覆盖" badge={toolOverrides.length ? `${toolOverrides.length} 条` : '未设置'}>
        <div className="permission-disclosure-body">
          {toolOverrides.length > 0 && <div className="permission-policy-rows">
            {toolOverrides.map(([pattern, decision]) => <div className="permission-policy-row" key={pattern}>
              <span className="permission-policy-row-key"><code>{pattern}</code></span>
              <Select
                disabled={busy}
                label={`${pattern} 的权限决定`}
                value={decision}
                options={DECISION_OPTIONS}
                onChange={(value) => patch({ tools: { ...policy.tools, [pattern]: value as PermissionDecision } })}
              />
              <button
                type="button"
                className="icon-button resource-delete"
                disabled={busy}
                aria-label={`删除 ${pattern} 的覆盖`}
                onClick={() => {
                  const tools = { ...policy.tools };
                  delete tools[pattern];
                  patch({ tools });
                }}
              ><Trash2 /></button>
            </div>)}
          </div>}

          <div className="permission-policy-add">
            <label>
              <span>工具或通配符</span>
              <input
                value={newTool}
                disabled={busy}
                onChange={(event) => setNewTool(event.target.value)}
                placeholder="例如 mcp__service__*"
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && !isComposingKey(event.nativeEvent)) {
                    event.preventDefault();
                    addToolOverride();
                  }
                }}
              />
            </label>
            <label>
              <span>决定</span>
              <Select
                disabled={busy}
                label="新工具覆盖的权限决定"
                value={newDecision}
                options={DECISION_OPTIONS}
                onChange={(value) => setNewDecision(value as PermissionDecision)}
              />
            </label>
            <button type="button" className="settings-add-button" onClick={addToolOverride} disabled={busy || !newTool.trim()}>
              <Plus />添加覆盖
            </button>
          </div>
        </div>
      </Accordion>

      <Accordion
        className="permission-disclosure permission-policy-rules"
        open={rulesOpen}
        onToggle={event => setRulesOpen(event.currentTarget.open)}
        summary="高级规则"
        badge={policy.rules.length ? `${policy.rules.length} 条` : '未设置'}
      >
        <div className="permission-disclosure-body">
          {policy.rules.length > 0 && <div className="permission-rule-list">
            {policy.rules.map((rule) => {
              const condition = ruleCondition(rule);
              const supported = conditionsForTool(rule.match.tool);
              const conditions = supported.includes(condition) ? supported : [condition, ...supported];
              return <article className="permission-rule" key={rule.id}>
                <div className="permission-rule-title">
                  <label>
                    <span>规则名称</span>
                    <input
                      disabled={busy}
                      value={rule.label}
                      onChange={(event) => updateRule(rule.id, (current) => ({ ...current, label: event.target.value }))}
                    />
                  </label>
                  <button type="button" className="icon-button resource-delete" disabled={busy} aria-label="删除规则" onClick={() => removeRule(rule.id)}>
                    <Trash2 />
                  </button>
                </div>
                <div className="permission-rule-fields">
                  <label className="permission-rule-tool">
                    <span>工具</span>
                    <input
                      disabled={busy}
                      value={rule.match.tool}
                      onChange={(event) => updateRule(rule.id, (current) => ({
                        ...current,
                        match: { ...current.match, tool: event.target.value },
                      }))}
                    />
                  </label>
                  <label>
                    <span>条件</span>
                    <Select
                      disabled={busy}
                      label={`${rule.label || '自定义规则'}的条件`}
                      value={condition}
                      options={conditions.map((item) => ({ value: item, label: CONDITION_LABELS[item] }))}
                      onChange={(value) => updateRule(rule.id, (current) => ({
                        ...current,
                        match: matchForCondition(current.match.tool, value as RuleCondition, ''),
                      }))}
                    />
                  </label>
                  <label>
                    <span>权限决定</span>
                    <Select
                      disabled={busy}
                      label={`${rule.label || '自定义规则'}的权限决定`}
                      value={rule.decision}
                      options={DECISION_OPTIONS}
                      onChange={(value) => updateRule(rule.id, (current) => ({
                        ...current,
                        decision: value as PermissionDecision,
                      }))}
                    />
                  </label>
                  {condition !== 'tool' && condition !== 'pathWithin' && <label className="permission-rule-value">
                    <span>{condition.startsWith('command') ? '命令' : '路径'}</span>
                    <input
                      disabled={busy}
                      value={conditionValue(rule)}
                      placeholder={conditionPlaceholder(condition)}
                      onChange={(event) => updateRule(rule.id, (current) => ({
                        ...current,
                        match: matchForCondition(
                          current.match.tool,
                          ruleCondition(current),
                          event.target.value,
                        ),
                      }))}
                    />
                  </label>}
                </div>
              </article>;
            })}
          </div>}
          <button type="button" className="settings-outline permission-add-rule" disabled={busy} onClick={addRule}>
            <Plus />新规则
          </button>
        </div>
      </Accordion>
    </section>

    <Accordion
      className={previewClass}
      summary="策略预览"
    >
      <div className="permission-preview-body">
        <div className="permission-preview-form">
          <label>
            <span>工具</span>
            <Select
              disabled={busy || previewing}
              label="预览工具"
              value={previewTool}
              options={PREVIEW_TOOL_OPTIONS}
              onChange={(value) => { setPreviewTool(value); clearPreview(); }}
            />
          </label>
          {previewTool === 'bash' && <label>
            <span>命令</span>
            <input value={previewCommand} onChange={event => { setPreviewCommand(event.target.value); clearPreview(); }} placeholder="例如 git status" />
          </label>}
          {previewUsesPath && <label>
            <span>路径</span>
            <input value={previewPath} onChange={event => { setPreviewPath(event.target.value); clearPreview(); }} placeholder="例如 src/App.tsx" />
          </label>}
          <button type="button" className="settings-outline" disabled={busy || previewing} onClick={() => void runPreview()}>
            {previewing ? '预览中…' : '预览结果'}
          </button>
        </div>
        {previewError && <p className="settings-error" role="alert">{previewError}</p>}
        {preview && <div className="permission-preview-result" role="status">
          <header>
            <strong>{PERMISSION_DECISION_LABELS[preview.decision]}</strong>
            <small>{dirty ? '未保存草稿' : '当前编辑策略'} · {previewLabel}</small>
          </header>
          <span>{preview.explanation}</span>
          <code>{preview.risk.title}{preview.risk.detail ? ` · ${preview.risk.detail}` : ''}</code>
          {preview.matches.length > 0 && <div className="permission-preview-matches">
            <span>命中规则</span>
            <ul>
              {preview.matches.map((match, index) => <li key={`${match.scope}:${match.source}:${match.ruleId || match.pattern}:${index}`}>
                <code>{match.label || match.ruleId || match.pattern}</code>
                <span>{SCOPE_LABELS[match.scope] || match.scope} · {PERMISSION_DECISION_LABELS[match.decision]}</span>
              </li>)}
            </ul>
          </div>}
        </div>}
      </div>
    </Accordion>
    {actionConfirmation.dialog}
  </>;
}
