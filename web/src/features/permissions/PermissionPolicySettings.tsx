import { LoadingState } from '../../shared/LoadingState';
import { useSettingsDraftGuard } from '../../shared/SettingsDraftGuard';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Check,
  Plus,
  Trash2,
} from 'lucide-react';
import { errorText } from '../../shared/error-text';
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
import { useActionConfirmation } from '../../shared/ConfirmDialog';
import { Accordion } from '../../shared/Accordion';
import { Select } from '../../shared/Select';
import { SettingsPageHeader } from '../../shared/SettingsPageHeader';
import { matchForCondition, permissionDraftError, permissionScopeKey, permissionWrites, ruleCondition, type RuleCondition } from './permission-policy-editor';
import { isComposingKey } from '../../shared/keyboard-navigation';
import './styles/permission-policy.css';

type PermissionPolicySettingsProps = {
  cwd?: string;
  sessionId?: string;
  className?: string;
  onPolicyChanged?: (state: PermissionPolicyState) => void;
};

const SCOPE_LABELS: Record<PermissionScope, string> = {
  user: '全局',
  workspace: '当前工作区',
  session: '当前会话',
};

const DECISION_LABELS: Record<PermissionDecision, string> = {
  allow: '允许',
  ask: '询问',
  deny: '拒绝',
};

const DECISION_OPTIONS = (Object.keys(DECISION_LABELS) as PermissionDecision[])
  .map((value) => ({ value, label: DECISION_LABELS[value] }));

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

function modeLabel(snapshot: PermissionPolicyState, mode: PermissionMode) {
  return snapshot.catalog.modes.find((item) => item.id === mode)?.label || mode;
}

function clonePolicy(policy: PermissionPolicy): PermissionPolicy {
  return JSON.parse(JSON.stringify(policy)) as PermissionPolicy;
}

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

function scopeAvailable(scope: PermissionScope, cwd?: string, sessionId?: string) {
  if (scope === 'workspace') return Boolean(cwd);
  if (scope === 'session') return Boolean(sessionId);
  return true;
}

function policyForScope(snapshot: PermissionPolicyState, scope: PermissionScope) {
  const configured = snapshot.scopes[scope];
  if (configured) return configured;
  if (scope === 'session') return snapshot.scopes.workspace || snapshot.scopes.user;
  if (scope === 'workspace') return snapshot.scopes.user;
  return snapshot.scopes.user;
}

export function PermissionPolicySettings(props: PermissionPolicySettingsProps) {
  return <PermissionPolicyEditor key={JSON.stringify([props.cwd || '', props.sessionId || ''])} {...props} />;
}

function PermissionPolicyEditor({
  cwd = '',
  sessionId = '',
  className = '',
  onPolicyChanged,
}: PermissionPolicySettingsProps) {
  const actionConfirmation = useActionConfirmation();
  const [snapshot, setSnapshot] = useState<PermissionPolicyState | null>(null);
  const [scope, setScope] = useState<PermissionScope>('user');
  const [draft, setDraft] = useState<PermissionPolicy | null>(null);
  const [loading, setLoading] = useState(true);
  const [operation, setOperation] = useState<'' | 'save' | 'reset' | 'preview'>('');
  const busy = Boolean(operation);
  const operationRef = useRef(false);
  const generation = useRef(0);
  const [reload, setReload] = useState(0);
  const [edited, setEdited] = useState(false);
  const [error, setError] = useState('');
  const showToast = useSettingsToast();
  const [newTool, setNewTool] = useState('');
  const [newDecision, setNewDecision] = useState<PermissionDecision>('ask');
  const [rulesOpen, setRulesOpen] = useState(false);
  const [previewTool, setPreviewTool] = useState('bash');
  const [previewCommand, setPreviewCommand] = useState('git status');
  const [previewPath, setPreviewPath] = useState('src/App.tsx');
  const previewUsesPath = ['read', 'write', 'edit'].includes(previewTool);
  const [preview, setPreview] = useState<PermissionEvaluation | null>(null);
  const [previewError, setPreviewError] = useState('');

  // A previously inherited policy can be saved as an explicit override, even with identical values.
  const savedPolicy = snapshot?.scopes[scope];
  const dirty = edited && (!savedPolicy || JSON.stringify(draft) !== JSON.stringify(savedPolicy));
  useSettingsDraftGuard({ label: '权限策略', dirty });

  function clearPreview() {
    setPreview(null);
    setPreviewError('');
  }

  function adoptSnapshot(next: PermissionPolicyState, preferredScope = scope) {
    setSnapshot(next);
    const selected = scopeAvailable(preferredScope, next.cwd, next.sessionId)
      ? preferredScope
      : 'user';
    setScope(selected);
    setDraft(clonePolicy(policyForScope(next, selected)));
    setEdited(false);
    clearPreview();
  }

  useEffect(() => {
    const ticket = ++generation.current;
    const current = () => generation.current === ticket;
    setLoading(true);
    setSnapshot(null);
    setDraft(null);
    setEdited(false);
    clearPreview();
    setError('');
    void permissionWrites.waitForContext(cwd, sessionId)
      .then(() => current() ? window.piApi.permissionPolicyGet({ cwd, sessionId }) : null)
      .then((next) => {
        if (!current() || !next) return;
        setSnapshot(next);
        setScope('user');
        setDraft(clonePolicy(next.scopes.user));
      })
      .catch((reason) => { if (current()) setError(errorText(reason)); })
      .finally(() => { if (current()) setLoading(false); });
    return () => { generation.current++; };
  }, [cwd, sessionId, reload]);

  const toolOverrides = useMemo(
    () => Object.entries(draft?.tools || {}).sort(([left], [right]) => left.localeCompare(right)),
    [draft],
  );

  function patchDraft(patch: Partial<PermissionPolicy>) {
    if (operationRef.current) return;
    setDraft((current) => current ? { ...current, ...patch } : current);
    clearPreview();
    setEdited(true);
    setError('');
  }

  async function selectScope(nextScope: PermissionScope) {
    if (operationRef.current || !snapshot || !scopeAvailable(nextScope, snapshot.cwd, snapshot.sessionId)) return;
    const ticket = generation.current;
    if (nextScope === scope) return;
    if (dirty) {
      const accepted = await actionConfirmation.confirm({
        title: '丢弃未保存的权限更改？',
        description: '切换后会载入所选范围的策略，当前未保存的模式和规则将丢失。',
        confirmLabel: '丢弃并切换',
        tone: 'danger',
      });
      if (!accepted || generation.current !== ticket || operationRef.current) return;
    }
    setScope(nextScope);
    setNewTool('');
    setNewDecision('ask');
    setDraft(clonePolicy(policyForScope(snapshot, nextScope)));
    clearPreview();
    setEdited(false);
    setError('');
  }

  async function applyPreset(mode: PermissionMode) {
    if (!draft || !snapshot || operationRef.current) return;
    const ticket = generation.current;
    if (mode === 'full' && draft.preset !== 'full') {
      const accepted = await actionConfirmation.confirm({
        title: '启用完全权限？',
        description: '普通工具、跨工作区操作和无法静态确认的脚本会直接执行。你显式设置为“询问/拒绝”的规则，以及明显的删除和系统破坏命令仍会生效。',
        confirmLabel: '启用完全权限',
        tone: 'danger',
      });
      if (!accepted || generation.current !== ticket || operationRef.current) return;
    }
    patchDraft({
      preset: mode,
      default: snapshot.catalog.presetDefaults[mode],
    });
  }

  function beginOperation(kind: 'save' | 'reset' | 'preview') {
    if (operationRef.current || !snapshot || !draft) return null;
    operationRef.current = true;
    setOperation(kind);
    setError('');
    const ticket = generation.current;
    return {
      current: () => generation.current === ticket,
      finish: () => {
        if (generation.current !== ticket) return;
        operationRef.current = false;
        setOperation('');
      },
    };
  }

  function validateDraft() {
    const message = draft ? permissionDraftError(draft) : '权限策略不可用';
    if (message) {
      showToast(message, 'error');
      setRulesOpen(true);
    }
    return !message;
  }

  async function savePolicy() {
    if (!draft || !validateDraft()) return;
    const request = beginOperation('save');
    if (!request) return;
    try {
      const next = await permissionWrites.run(permissionScopeKey(scope, cwd, sessionId), () =>
        window.piApi.permissionPolicySet({ scope, cwd, sessionId, policy: draft }));
      if (!request.current()) return;
      adoptSnapshot(next, scope);
      onPolicyChanged?.(next);
      showToast('权限策略已保存，并从下一次工具调用开始生效。');
    } catch (reason) {
      if (request.current()) showToast(errorText(reason), 'error');
    } finally { request.finish(); }
  }

  async function resetPolicy() {
    if (operationRef.current || !snapshot || !draft) return;
    const ticket = generation.current;
    const message = scope === 'user'
      ? '将全局权限策略恢复为“帮我批准”默认值？自定义规则会一起清除。'
      : `删除${SCOPE_LABELS[scope]}的权限覆盖并恢复继承？`;
    const accepted = await actionConfirmation.confirm({
      title: scope === 'user' ? '恢复默认权限策略？' : '恢复权限继承？',
      description: message,
      confirmLabel: scope === 'user' ? '恢复默认' : '删除覆盖',
      tone: 'danger',
    });
    if (!accepted || generation.current !== ticket) return;
    const request = beginOperation('reset');
    if (!request) return;
    try {
      const next = await permissionWrites.run(permissionScopeKey(scope, cwd, sessionId), () =>
        window.piApi.permissionPolicyReset({ scope, cwd, sessionId }));
      if (!request.current()) return;
      adoptSnapshot(next, scope);
      onPolicyChanged?.(next);
      showToast(scope === 'user' ? '已恢复默认权限策略。' : '已恢复继承。');
    } catch (reason) {
      if (request.current()) showToast(errorText(reason), 'error');
    } finally { request.finish(); }
  }

  function addToolOverride() {
    if (!draft || !newTool.trim()) return;
    patchDraft({
      tools: { ...draft.tools, [newTool.trim()]: newDecision },
    });
    setNewTool('');
    setNewDecision('ask');
  }

  function updateToolOverride(pattern: string, decision: PermissionDecision) {
    if (!draft) return;
    patchDraft({ tools: { ...draft.tools, [pattern]: decision } });
  }

  function removeToolOverride(pattern: string) {
    if (!draft) return;
    const tools = { ...draft.tools };
    delete tools[pattern];
    patchDraft({ tools });
  }

  function addRule() {
    if (!draft) return;
    const rule: PermissionRule = {
      id: `rule-${globalThis.crypto?.randomUUID?.() || Date.now()}`,
      label: '自定义规则',
      decision: 'ask',
      match: { tool: '*' },
    };
    patchDraft({ rules: [...draft.rules, rule] });
  }

  function updateRule(id: string, updater: (rule: PermissionRule) => PermissionRule) {
    if (!draft) return;
    patchDraft({ rules: draft.rules.map((rule) => rule.id === id ? updater(rule) : rule) });
  }

  function removeRule(id: string) {
    if (!draft) return;
    patchDraft({ rules: draft.rules.filter((rule) => rule.id !== id) });
  }

  async function evaluatePreview() {
    if (!draft || !validateDraft()) return;
    const request = beginOperation('preview');
    if (!request) return;
    clearPreview();
    try {
      const args = previewTool === 'bash'
        ? { command: previewCommand }
        : previewUsesPath
          ? { path: previewPath }
          : {};
      // Preview calls the same policy engine as the runtime, but only returns
      // the decision and match chain; the requested tool is never executed.
      const result = await window.piApi.permissionEvaluate({
        cwd,
        sessionId,
        scope,
        policy: draft,
        call: { name: previewTool, arguments: args },
      });
      if (request.current()) setPreview(result);
    } catch (reason) {
      if (request.current()) setPreviewError(errorText(reason));
    } finally { request.finish(); }
  }

  const header = <SettingsPageHeader title="权限策略" iconPosition="end" meta="设置工具调用何时需要批准。保存后从下一次调用起生效。"
    icon={<svg viewBox="0 0 32 32" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M16 2.5c3.3 2.3 7.4 3.8 12 4.5v8c0 6.2-4.7 11-12 14.5C8.7 26 4 21.2 4 15V7c4.6-.7 8.7-2.2 12-4.5Z" />
      <path d="m11 15.5 3.4 3.4 6.8-7.1" stroke="var(--accent)" />
    </svg>} />;
  const pageClass = `settings-preference-page permission-policy ${className}`.trim();
  if (loading || !snapshot || !draft) {
    return <div className={pageClass}>{header}
      {loading ? <LoadingState variant="section">正在读取权限策略…</LoadingState> : <div className="permission-load-error">
        <p className="settings-error" role="alert">{error || '权限策略不可用'}</p>
        <button type="button" className="settings-outline" onClick={() => setReload((value) => value + 1)}>重新加载</button>
      </div>}
    </div>;
  }

  const scopeNote = scope === 'user' ? '适用于所有工作区和会话。工作区与会话可以单独配置。'
    : snapshot.scopes[scope] ? '此范围已单独配置。恢复继承后将使用上一级策略。'
      : `当前继承${scope === 'session' && snapshot.scopes.workspace ? '工作区' : '全局'}策略。保存后将为此范围创建独立配置。`;
  return <div className={pageClass} aria-label="权限策略">
    {header}
    <fieldset className="settings-preference-groups permission-policy-editor" disabled={busy} aria-label="权限策略编辑" aria-busy={busy}>
      <section className="settings-preference-card permission-policy-card" aria-labelledby="permission-scope-title">
        <header className="permission-policy-section-head">
          <h2 id="permission-scope-title">作用范围</h2>
          <p>{scopeNote}</p>
        </header>

        <div className="settings-segments permission-policy-scopes" role="group" aria-label="权限作用域">
          {(Object.keys(SCOPE_LABELS) as PermissionScope[]).map((item) => {
            const available = scopeAvailable(item, snapshot.cwd, snapshot.sessionId);
            const configured = item === 'user' || Boolean(snapshot.scopes[item]);
            return <button
              type="button"
              aria-pressed={scope === item}
              disabled={!available || busy}
              title={!available ? item === 'workspace' ? '打开工作区后可配置' : '打开会话后可配置' : undefined}
              key={item}
              onClick={() => void selectScope(item)}
            >
              <span>{SCOPE_LABELS[item]}</span>
              <small>{item === 'user' ? '默认' : !available ? '未打开' : configured ? '已覆盖' : '继承'}</small>
            </button>;
          })}
        </div>

        <Accordion className="permission-policy-chain permission-disclosure" summary="当前生效"
          badge={`${SCOPE_LABELS[snapshot.effectiveScope]} · ${modeLabel(snapshot, snapshot.effectivePolicy.preset)}`}>
          <div className="permission-chain-details">
            <p>最具体的范围决定基础模式，各层的显式规则都参与判断。</p>
            <dl>{snapshot.layers.map(layer => <div key={layer.scope}>
              <dt>{SCOPE_LABELS[layer.scope]}</dt>
              <dd>{modeLabel(snapshot, layer.policy.preset)} · 默认{DECISION_LABELS[layer.policy.default]}</dd>
            </div>)}</dl>
          </div>
        </Accordion>
      </section>

      <section className="settings-preference-card permission-policy-card" aria-labelledby="permission-mode-title">
        <header className="permission-policy-section-head"><h2 id="permission-mode-title">基础模式</h2></header>
        <div className="permission-policy-presets" role="group" aria-labelledby="permission-mode-title">
          {snapshot.catalog.modes.map((mode) => {
            const selected = draft.preset === mode.id;
            const customDefault = selected && draft.default !== snapshot.catalog.presetDefaults[mode.id];
            const description = !customDefault ? mode.description
              : mode.id === 'ask' ? `已自定义默认决定为${DECISION_LABELS[draft.default]}；显式规则与保护检查仍生效。`
                : mode.id === 'smart' ? `读取、检索和长期任务管理工具自动允许，其他调用默认${DECISION_LABELS[draft.default]}；显式规则与保护检查优先。`
                  : `读取、检索和长期任务管理工具自动允许，其他调用默认${DECISION_LABELS[draft.default]}；跨工作区与脚本检查不再额外要求确认，显式规则和高危命令拦截仍生效。`;
            const tierLabel = mode.id === 'ask' ? '严格' : mode.id === 'smart' ? '推荐' : '高权限';
            return <button
              type="button"
              aria-pressed={selected}
              className={`permission-preset${selected ? ' is-active' : ''}`}
              key={mode.id}
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
          <div><span>默认决定</span><p>规则、保护检查和基础模式均未决定时使用。</p></div>
          <Select disabled={busy} label="未命中时的权限决定" value={draft.default} options={DECISION_OPTIONS}
            onChange={(value) => patchDraft({ default: value as PermissionDecision })} />
        </div>
      </section>

      <section className="settings-preference-card permission-policy-card" aria-labelledby="permission-exceptions-title">
        <header className="permission-policy-section-head"><h2 id="permission-exceptions-title">例外规则</h2></header>
        <Accordion className="permission-disclosure permission-overrides" summary="工具覆盖" badge={toolOverrides.length ? `${toolOverrides.length} 条` : '未设置'}>
          <div className="permission-disclosure-body">
            <p>按工具名称或通配符设置决定，匹配时优先于基础模式。</p>
            {toolOverrides.length > 0 && <div className="permission-policy-rows">
              {toolOverrides.map(([pattern, decision]) => <div className="permission-policy-row" key={pattern}>
                <span className="permission-policy-row-key"><code>{pattern}</code></span>
                <Select
                  disabled={busy}
                  label={`${pattern} 的权限决定`}
                  value={decision}
                  options={DECISION_OPTIONS}
                  onChange={(value) => updateToolOverride(pattern, value as PermissionDecision)}
                />
                <button type="button" className="icon-button resource-delete" aria-label={`删除 ${pattern} 的覆盖`} onClick={() => removeToolOverride(pattern)}>
                  <Trash2 />
                </button>
              </div>)}
            </div>}

            <div className="permission-policy-add">
              <label>
                <span>工具或通配符</span>
                <input
                  value={newTool}
                  onChange={(event) => setNewTool(event.target.value)}
                  placeholder="例如 mcp__service__*"
                  onKeyDown={(event) => { if (event.key === 'Enter' && !isComposingKey(event.nativeEvent)) addToolOverride(); }}
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
              <button type="button" className="settings-add-button" onClick={addToolOverride} disabled={!newTool.trim()}><Plus />添加覆盖</button>
            </div>
          </div>
        </Accordion>
        <Accordion className="permission-disclosure permission-policy-rules" open={rulesOpen} onToggle={event => setRulesOpen(event.currentTarget.open)}
          summary="高级规则" badge={draft.rules.length ? `${draft.rules.length} 条` : '未设置'}>
          <div className="permission-disclosure-body">
            <p>按命令或工作区路径细分条件。多条规则命中时，依次优先采用拒绝、询问、允许。</p>
            {draft.rules.length > 0 && <div className="permission-rule-list">
              {draft.rules.map((rule) => {
                const condition = ruleCondition(rule);
                const supported = conditionsForTool(rule.match.tool);
                const conditions = supported.includes(condition) ? supported : [condition, ...supported];
                return <article className="permission-rule" key={rule.id}>
                  <div className="permission-rule-title">
                    <label>
                      <span>规则名称</span>
                      <input
                        value={rule.label}
                        onChange={(event) => updateRule(rule.id, (current) => ({ ...current, label: event.target.value }))}
                      />
                    </label>
                    <button type="button" className="icon-button resource-delete" aria-label="删除规则" onClick={() => removeRule(rule.id)}><Trash2 /></button>
                  </div>
                  <div className="permission-rule-fields">
                    <label className="permission-rule-tool">
                      <span>工具</span>
                      <input
                        value={rule.match.tool}
                        onChange={(event) => updateRule(rule.id, (current) => {
                          // Editing a tool name must not silently discard a restrictive condition.
                          return { ...current, match: { ...current.match, tool: event.target.value } };
                        })}
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
            <button type="button" className="settings-outline permission-add-rule" onClick={addRule}><Plus />新规则</button>
          </div>
        </Accordion>
      </section>

      <Accordion className="settings-preference-card permission-policy-preview" summary="策略预览"
        description="模拟一次工具调用，查看当前草稿的决定和命中规则。">
        <div className="permission-preview-body">
          <div className="permission-preview-form">
            <label>
              <span>工具</span>
              <Select
                disabled={busy}
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
            <button type="button" className="settings-outline" disabled={busy} onClick={() => void evaluatePreview()}>{operation === 'preview' ? '预览中…' : '预览结果'}</button>
          </div>
          {previewError && <p className="settings-error" role="alert">{previewError}</p>}
          {preview && <div className="permission-preview-result" role="status">
            <header><strong>{DECISION_LABELS[preview.decision]}</strong>
              <small>{dirty ? '未保存草稿' : '当前编辑策略'} · {SCOPE_LABELS[preview.previewScope || scope]}</small></header>
            <span>{preview.explanation}</span>
            <code>{preview.risk.title}{preview.risk.detail ? ` · ${preview.risk.detail}` : ''}</code>
            {preview.matches.length > 0 && <div className="permission-preview-matches">
              <span>命中规则</span><ul>{preview.matches.map((match, index) => <li
                key={`${match.scope}:${match.source}:${match.ruleId || match.pattern}:${index}`}>
                <code>{match.label || match.ruleId || match.pattern}</code>
                <span>{SCOPE_LABELS[match.scope]} · {DECISION_LABELS[match.decision]}</span>
              </li>)}</ul>
            </div>}
          </div>}
        </div>
      </Accordion>

      <footer className={`settings-preference-card permission-policy-actions${dirty ? ' is-dirty' : ''}`}>
        <div className="permission-save-state"><strong>{SCOPE_LABELS[scope]}策略</strong>
          <span>{dirty ? '有未保存的更改' : savedPolicy ? '与已保存策略一致' : '正在继承上一级策略'}</span></div>
        <div className="permission-save-buttons">
          {(scope === 'user' || snapshot.scopes[scope]) && <button type="button" className="settings-outline" disabled={busy} onClick={() => void resetPolicy()}>
            {operation === 'reset' ? '恢复中…' : scope === 'user' ? '恢复默认' : '恢复继承'}
          </button>}
          <button type="button" className="settings-save" disabled={!dirty || busy} onClick={() => void savePolicy()}>
            {operation === 'save' ? '保存中…' : '保存权限策略'}
          </button>
        </div>
      </footer>
    </fieldset>
    {actionConfirmation.dialog}
  </div>;
}
