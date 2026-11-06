import { useSettingsDraftGuard } from '../../shared/SettingsDraftGuard';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Check,
  ChevronRight,
  Plus,
  RotateCcw,
  Save,
  ShieldCheck,
  Trash2,
} from 'lucide-react';
import { errorText } from '../../shared/error-text';
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
import { InfoHint } from '../../shared/InfoHint';
import { Select } from '../../shared/Select';
import { SecretVaultSettings } from './SecretVaultSettings';
import { SettingsPageHeader } from '../../shared/SettingsPageHeader';
import { matchForCondition, permissionDraftError, permissionScopeKey, permissionWrites, ruleCondition, type RuleCondition } from './permission-policy-editor';
import { isComposingKey } from '../../shared/keyboard-navigation';
import './permission-policy.css';

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
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [newTool, setNewTool] = useState('');
  const [newDecision, setNewDecision] = useState<PermissionDecision>('ask');
  const [previewTool, setPreviewTool] = useState('bash');
  const [previewCommand, setPreviewCommand] = useState('git status');
  const [previewPath, setPreviewPath] = useState('src/App.tsx');
  const [preview, setPreview] = useState<PermissionEvaluation | null>(null);

  useSettingsDraftGuard({ label: '权限策略', dirty });

  function adoptSnapshot(next: PermissionPolicyState, preferredScope = scope) {
    setSnapshot(next);
    const selected = scopeAvailable(preferredScope, next.cwd, next.sessionId)
      ? preferredScope
      : 'user';
    setScope(selected);
    setDraft(clonePolicy(policyForScope(next, selected)));
    setDirty(false);
    setPreview(null);
  }

  useEffect(() => {
    const ticket = ++generation.current;
    const current = () => generation.current === ticket;
    setLoading(true);
    setSnapshot(null);
    setDraft(null);
    setDirty(false);
    setNotice('');
    setPreview(null);
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
    setPreview(null);
    setDirty(true);
    setError('');
    setNotice('');
  }

  async function selectScope(nextScope: PermissionScope) {
    if (operationRef.current || !snapshot || !scopeAvailable(nextScope, snapshot.cwd, snapshot.sessionId)) return;
    const ticket = generation.current;
    if (nextScope === scope) return;
    if (dirty) {
      const accepted = await actionConfirmation.confirm({
        title: '丢弃未保存的权限更改？',
        description: '切换作用域会重新读取已保存的策略，当前草稿中的工具覆盖和高级规则将丢失。',
        confirmLabel: '丢弃并切换',
        tone: 'danger',
      });
      if (!accepted || generation.current !== ticket || operationRef.current) return;
    }
    setScope(nextScope);
    setNewTool('');
    setNewDecision('ask');
    setDraft(clonePolicy(policyForScope(snapshot, nextScope)));
    setPreview(null);
    setDirty(false);
    setNotice('');
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
    setNotice('');
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
    if (message) setError(message);
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
      setNotice('权限策略已保存，并从下一次工具调用开始生效。');
    } catch (reason) {
      if (request.current()) setError(errorText(reason));
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
      setNotice(scope === 'user' ? '已恢复默认权限策略。' : '已恢复继承。');
    } catch (reason) {
      if (request.current()) setError(errorText(reason));
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
    setPreview(null);
    try {
      const args = previewTool === 'bash'
        ? { command: previewCommand }
        : ['read', 'write', 'edit', 'ls', 'find', 'grep'].includes(previewTool)
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
      if (request.current()) setError(errorText(reason));
    } finally { request.finish(); }
  }

  if (loading) {
    return <div className={`settings-sections permission-policy is-loading ${className}`.trim()}>
      <section className="permission-policy-loader" role="status">
        <div />
        <span>正在读取权限策略…</span>
      </section>
    </div>;
  }

  if (!snapshot || !draft) {
    return <div className={`settings-sections permission-policy ${className}`.trim()}>
      <div className="permission-policy-error" role="alert">{error || '权限策略不可用'}</div>
      <button type="button" className="settings-outline" onClick={() => setReload((value) => value + 1)}>重新加载</button>
    </div>;
  }

  return <div className={`settings-sections permission-policy ${className}`.trim()} aria-label="智能体权限策略">
    <SettingsPageHeader
      className="permission-policy-page-head"
      icon={<ShieldCheck />}
      title="智能体权限"
      meta={<span>保存后从下一次工具调用生效</span>}
      actions={(scope === 'user' || Boolean(snapshot.scopes[scope]))
        ? <button type="button" className="settings-outline permission-policy-reset" disabled={busy} onClick={() => void resetPolicy()}>
          <RotateCcw />{operation === 'reset' ? '恢复中…' : scope === 'user' ? '恢复默认' : '恢复继承'}
        </button>
        : undefined}
    />

    <fieldset className="permission-policy-editor" disabled={busy} aria-label="权限策略编辑" aria-busy={busy}>
    <section className="permission-policy-card permission-policy-scope-card">
      <div className="permission-policy-section-head">
        <div>
          <h2>作用范围 <InfoHint label="更窄作用域决定默认模式；各层显式规则仍参与判断。保存会创建独立覆盖，删除覆盖后重新继承。" /></h2>
        </div>
        <span className="permission-policy-effective">
          默认模式来源
          <strong>{SCOPE_LABELS[snapshot.effectiveScope]}</strong>
        </span>
      </div>

      <div className="permission-policy-scopes" role="group" aria-label="权限作用域">
        {(Object.keys(SCOPE_LABELS) as PermissionScope[]).map((item) => {
          const available = scopeAvailable(item, snapshot.cwd, snapshot.sessionId);
          const configured = item === 'user' || Boolean(snapshot.scopes[item]);
          return <button
            type="button"
            aria-pressed={scope === item}
            className={scope === item ? 'is-active' : ''}
            disabled={!available || busy}
            key={item}
            onClick={() => void selectScope(item)}
          >
            <span>{SCOPE_LABELS[item]}</span>
            <small>{item === 'user' ? '所有工作区' : configured ? '已覆盖' : '继承'}</small>
          </button>;
        })}
      </div>

      <p className="permission-policy-scope-note">{scope === 'user' ? '全局策略适用于所有工作区；更窄作用域中的策略与规则仍会参与判断。' : snapshot.scopes[scope] ? '正在编辑独立覆盖。恢复继承会删除此作用域的覆盖。' : `当前继承${SCOPE_LABELS[scope === 'session' && snapshot.scopes.workspace ? 'workspace' : 'user']}。保存会创建独立覆盖。`}</p>
      <div className="permission-policy-chain" aria-label="权限策略生效链">
        <span className="permission-policy-chain-label">生效链</span>
        {snapshot.layers.map((layer, index) => <span className="permission-policy-chain-part" key={layer.scope}>
          {index > 0 && <ChevronRight aria-hidden="true" />}
          <span className="permission-policy-chain-node">
            <small>{SCOPE_LABELS[layer.scope]}</small>
            <strong>{modeLabel(snapshot, layer.policy.preset)}</strong>
            <em className={`is-${layer.policy.default}`}>{DECISION_LABELS[layer.policy.default]}</em>
          </span>
        </span>)}
      </div>

    </section>

    <section className="permission-policy-card">
      <div className="permission-policy-section-head">
        <div>
          <h2>基础模式 <InfoHint label="默认决定仅在显式规则、保护检查和基础模式的自动允许均未决定时使用。" /></h2>
        </div>
        <label className="permission-policy-select">
          <span>默认决定</span>
          <Select
            disabled={busy}
            label="未命中时的权限决定"
            value={draft.default}
            options={DECISION_OPTIONS}
            onChange={(value) => patchDraft({ default: value as PermissionDecision })}
          />
        </label>
      </div>
      <div className="permission-policy-presets">
        {snapshot.catalog.modes.map((mode) => {
          const selected = draft.preset === mode.id;
          const customDefault = selected && draft.default !== snapshot.catalog.presetDefaults[mode.id];
          const description = !customDefault ? mode.description
            : mode.id === 'ask' ? `已自定义默认决定为${DECISION_LABELS[draft.default]}；显式规则与保护检查仍生效。`
              : mode.id === 'smart' ? `读取、检索和长期任务管理工具自动允许，其他调用默认${DECISION_LABELS[draft.default]}；显式规则与保护检查优先。`
                : `读取、检索和长期任务管理工具自动允许，其他调用默认${DECISION_LABELS[draft.default]}；跨工作区与脚本检查不再额外要求确认，显式规则和高危命令拦截仍生效。`;
          return <button
            type="button"
            aria-pressed={selected}
            className={`permission-preset ${selected ? 'is-active' : ''} ${mode.id === 'full' ? 'is-sensitive' : ''}`}
            key={mode.id}
            onClick={() => void applyPreset(mode.id)}
          >
            <span className="permission-preset-check" aria-hidden="true">{selected && <Check />}</span>
            <span className="permission-preset-copy">
              <strong>{mode.label}</strong>
              <small>{description}</small>
            </span>
          </button>;
        })}
      </div>
    </section>

    <section className="permission-policy-card">
      <div className="permission-policy-section-head">
        <div>
          <h2>工具覆盖 <InfoHint label="支持精确名称与通配符，例如 mcp__github__*。工具覆盖优先于默认模式。" /></h2>
        </div>
        {toolOverrides.length > 0 && <span className="permission-policy-count" aria-label={`${toolOverrides.length} 条工具覆盖`}>
          {toolOverrides.length}
        </span>}
      </div>

      {toolOverrides.length === 0
        ? <div className="permission-policy-empty">
          <span><strong>没有工具覆盖</strong></span>
        </div>
        : <div className="permission-policy-rows">
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
    </section>

    <section className="permission-policy-card permission-policy-rules">
      <div className="permission-policy-section-head">
        <div>
          <h2>高级规则 {draft.rules.length > 0 && <span className="count-badge">{draft.rules.length}</span>}<InfoHint label="拒绝优先于询问，询问优先于允许。路径规则相对当前工作区解析。" /></h2>
        </div>
        <button type="button" className="settings-add-button" onClick={addRule}><Plus />新规则</button>
      </div>

      {draft.rules.length === 0
        ? <div className="permission-policy-empty">
          <span><strong>没有高级规则</strong></span>
        </div>
        : <div className="permission-rule-list">
          {draft.rules.map((rule) => {
            const condition = ruleCondition(rule);
            const supported = conditionsForTool(rule.match.tool);
            const conditions = supported.includes(condition) ? supported : [condition, ...supported];
            return <article className="permission-rule" key={rule.id}>
              <div className="permission-rule-title">
                <input
                  aria-label="规则说明"
                  value={rule.label}
                  placeholder="规则名称"
                  onChange={(event) => updateRule(rule.id, (current) => ({ ...current, label: event.target.value }))}
                />
                <Select
                  disabled={busy}
                  label={`${rule.label || '自定义规则'}的权限决定`}
                  className={`permission-rule-decision is-${rule.decision}`}
                  value={rule.decision}
                  options={DECISION_OPTIONS}
                  onChange={(value) => updateRule(rule.id, (current) => ({
                    ...current,
                    decision: value as PermissionDecision,
                  }))}
                />
                <button type="button" className="icon-button resource-delete" aria-label="删除规则" onClick={() => removeRule(rule.id)}><Trash2 /></button>
              </div>
              <div className="permission-rule-match">
                <label>
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
                {condition !== 'tool' && condition !== 'pathWithin' && <label className="is-wide">
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
    </section>

    <section className="permission-policy-card permission-policy-preview">
      <div className="permission-policy-section-head">
        <div>
          <h2>策略预览 <InfoHint label="使用与运行时相同的规则引擎；只验证结果，不执行工具。" /></h2>
        </div>
      </div>
      <div className="permission-preview-form">
        <label>
          <span>工具</span>
          <Select
            disabled={busy}
            label="预览工具"
            value={previewTool}
            options={PREVIEW_TOOL_OPTIONS}
            onChange={(value) => { setPreviewTool(value); setPreview(null); }}
          />
        </label>
        <label className="is-wide">
          <span>{previewTool === 'bash' ? '命令' : ['read', 'write', 'edit'].includes(previewTool) ? '路径' : '调用参数'}</span>
          {previewTool === 'bash'
            ? <input value={previewCommand} onChange={(event) => { setPreviewCommand(event.target.value); setPreview(null); }} placeholder="command" />
            : ['read', 'write', 'edit'].includes(previewTool)
              ? <input value={previewPath} onChange={(event) => { setPreviewPath(event.target.value); setPreview(null); }} placeholder="path" />
              : <span className="permission-preview-empty-args">无路径或命令参数</span>}
        </label>
        <button type="button" className="settings-outline" disabled={busy} onClick={() => void evaluatePreview()}>{operation === 'preview' ? '预览中…' : '预览结果'}</button>
      </div>
      {preview && <div className={`permission-preview-result is-${preview.decision}`} role="status">
        <strong>{DECISION_LABELS[preview.decision]}</strong>
        <small className="permission-preview-draft">{dirty ? '未保存草稿' : '当前编辑策略'} · {SCOPE_LABELS[preview.previewScope || scope]}</small>
        <span>{preview.explanation}</span>
        <code>{preview.risk.title}{preview.risk.detail ? ` · ${preview.risk.detail}` : ''}</code>
        {preview.matches.length > 0 && <div className="permission-preview-matches">
          <span>命中规则</span>
          {preview.matches.map((match, index) => <span
            className={`permission-preview-match is-${match.decision}`}
            key={`${match.scope}:${match.source}:${match.ruleId || match.pattern}:${index}`}
            title={match.label || match.ruleId || match.pattern}
          >
            <small>{SCOPE_LABELS[match.scope]}</small>
            <strong>{DECISION_LABELS[match.decision]}</strong>
            <code>{match.label || match.ruleId || match.pattern}</code>
          </span>)}
        </div>}
      </div>}
    </section>

    </fieldset>

    {error && <div className="permission-policy-message is-error" role="alert">{error}</div>}
    {notice && <div className="permission-policy-message is-success" role="status">{notice}</div>}
    <footer className="permission-policy-actions">
      <span>
        <strong>{dirty ? '有未保存更改' : '策略已同步'}</strong>
      </span>
      <button type="button" className="settings-save" disabled={!dirty || busy} onClick={() => void savePolicy()}>
        <Save />{operation === 'save' ? '保存中…' : '保存权限策略'}
      </button>
    </footer>
    <SecretVaultSettings />
    {actionConfirmation.dialog}
  </div>;
}
