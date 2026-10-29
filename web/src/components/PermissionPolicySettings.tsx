import { useEffect, useMemo, useState } from 'react';
import {
  BadgeCheck,
  Check,
  ChevronRight,
  CircleHelp,
  FlaskConical,
  ListFilter,
  Plus,
  RotateCcw,
  Save,
  ShieldAlert,
  ShieldCheck,
  ShieldQuestion,
  SlidersHorizontal,
  Trash2,
} from 'lucide-react';
import type {
  PermissionDecision,
  PermissionEvaluation,
  PermissionMode,
  PermissionPolicy,
  PermissionPolicyState,
  PermissionRule,
  PermissionScope,
} from '../types/permission-types';
import { useActionConfirmation } from './ConfirmDialog';
import { Select } from './Select';
import { SettingsPageHeader } from './SettingsPageHeader';
import '../styles/permission-policy.css';

type PermissionPolicySettingsProps = {
  cwd?: string;
  sessionId?: string;
  className?: string;
  onPolicyChanged?: (state: PermissionPolicyState) => void;
};

type RuleCondition = 'tool' | 'commandPrefix' | 'commandExact' | 'pathExact' | 'pathGlob' | 'pathWithin';

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

function modeIcon(mode: PermissionMode) {
  if (mode === 'ask') return ShieldQuestion;
  if (mode === 'smart') return BadgeCheck;
  if (mode === 'full') return ShieldAlert;
  return CircleHelp;
}

function modeLabel(snapshot: PermissionPolicyState, mode: PermissionMode) {
  return snapshot.catalog.modes.find((item) => item.id === mode)?.label || mode;
}

function clonePolicy(policy: PermissionPolicy): PermissionPolicy {
  return JSON.parse(JSON.stringify(policy)) as PermissionPolicy;
}

function errorText(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function ruleCondition(rule: PermissionRule): RuleCondition {
  if (rule.match.commandPrefix) return 'commandPrefix';
  if (rule.match.commandExact) return 'commandExact';
  if (rule.match.pathExact) return 'pathExact';
  if (rule.match.pathGlob) return 'pathGlob';
  if (rule.match.pathWithin) return 'pathWithin';
  return 'tool';
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

function matchForCondition(tool: string, condition: RuleCondition, value: string): PermissionRule['match'] {
  const match: PermissionRule['match'] = { tool };
  if (condition === 'commandPrefix' && value.trim()) match.commandPrefix = value.trim();
  else if (condition === 'commandExact' && value.trim()) match.commandExact = value.trim();
  else if (condition === 'pathExact' && value.trim()) match.pathExact = value.trim();
  else if (condition === 'pathGlob' && value.trim()) match.pathGlob = value.trim();
  else if (condition === 'pathWithin') match.pathWithin = 'workspace';
  return match;
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

export function PermissionPolicySettings({
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
  const [busy, setBusy] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [newTool, setNewTool] = useState('');
  const [newDecision, setNewDecision] = useState<PermissionDecision>('ask');
  const [previewTool, setPreviewTool] = useState('bash');
  const [previewCommand, setPreviewCommand] = useState('git status');
  const [previewPath, setPreviewPath] = useState('src/App.tsx');
  const [preview, setPreview] = useState<PermissionEvaluation | null>(null);

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
    let active = true;
    setLoading(true);
    setError('');
    void window.piApi.permissionPolicyGet({ cwd, sessionId })
      .then((next) => {
        if (!active) return;
        setSnapshot(next);
        setScope('user');
        setDraft(clonePolicy(next.scopes.user));
      })
      .catch((reason) => { if (active) setError(errorText(reason)); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [cwd, sessionId]);

  const inherited = scope !== 'user' && !snapshot?.scopes[scope];
  const toolOverrides = useMemo(
    () => Object.entries(draft?.tools || {}).sort(([left], [right]) => left.localeCompare(right)),
    [draft],
  );

  function patchDraft(patch: Partial<PermissionPolicy>) {
    setDraft((current) => current ? { ...current, ...patch } : current);
    setPreview(null);
    setDirty(true);
    setError('');
    setNotice('');
  }

  async function selectScope(nextScope: PermissionScope) {
    if (!snapshot || !scopeAvailable(nextScope, snapshot.cwd, snapshot.sessionId)) return;
    if (nextScope === scope) return;
    if (dirty) {
      const accepted = await actionConfirmation.confirm({
        title: '丢弃未保存的权限更改？',
        description: '切换作用域会重新读取已保存的策略，当前草稿中的工具覆盖和高级规则将丢失。',
        confirmLabel: '丢弃并切换',
        tone: 'danger',
      });
      if (!accepted) return;
    }
    setScope(nextScope);
    setDraft(clonePolicy(policyForScope(snapshot, nextScope)));
    setPreview(null);
    setDirty(false);
    setNotice('');
    setError('');
  }

  async function applyPreset(mode: PermissionMode) {
    if (!draft || !snapshot) return;
    if (mode === 'full' && draft.preset !== 'full') {
      const accepted = await actionConfirmation.confirm({
        title: '启用完全权限？',
        description: '普通工具、跨工作区操作和无法静态确认的脚本会直接执行。你显式设置为“询问/拒绝”的规则，以及明显的删除和系统破坏命令仍会生效。',
        confirmLabel: '启用完全权限',
        tone: 'danger',
      });
      if (!accepted) return;
    }
    patchDraft({
      preset: mode,
      default: snapshot.catalog.presetDefaults[mode],
    });
  }

  async function savePolicy() {
    if (!draft || busy) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const next = await window.piApi.permissionPolicySet({
        scope,
        cwd,
        sessionId,
        policy: draft,
      });
      adoptSnapshot(next, scope);
      onPolicyChanged?.(next);
      setNotice('权限策略已保存，并从下一次工具调用开始生效。');
    } catch (reason) {
      setError(errorText(reason));
    } finally {
      setBusy(false);
    }
  }

  async function resetPolicy() {
    if (busy) return;
    const message = scope === 'user'
      ? '将全局权限策略恢复为“帮我批准”默认值？自定义规则会一起清除。'
      : `删除${SCOPE_LABELS[scope]}的权限覆盖并恢复继承？`;
    const accepted = await actionConfirmation.confirm({
      title: scope === 'user' ? '恢复默认权限策略？' : '恢复权限继承？',
      description: message,
      confirmLabel: scope === 'user' ? '恢复默认' : '删除覆盖',
      tone: 'danger',
    });
    if (!accepted) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const next = await window.piApi.permissionPolicyReset({ scope, cwd, sessionId });
      adoptSnapshot(next, scope);
      onPolicyChanged?.(next);
      setNotice(scope === 'user' ? '已恢复默认权限策略。' : '已恢复继承。');
    } catch (reason) {
      setError(errorText(reason));
    } finally {
      setBusy(false);
    }
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
    if (busy) return;
    if (!draft) return;
    setBusy(true);
    setError('');
    try {
      const args = previewTool === 'bash'
        ? { command: previewCommand }
        : ['read', 'write', 'edit', 'ls', 'find', 'grep'].includes(previewTool)
          ? { path: previewPath }
          : {};
      setPreview(await window.piApi.permissionEvaluate({
        cwd,
        sessionId,
        scope,
        policy: draft,
        call: { name: previewTool, arguments: args },
      }));
    } catch (reason) {
      setError(errorText(reason));
    } finally {
      setBusy(false);
    }
  }

  if (loading) {
    return <div className={`settings-sections permission-policy is-loading ${className}`.trim()}>
      <section className="settings-card permission-policy-loader">
        <div />
        <span>正在读取权限策略…</span>
      </section>
    </div>;
  }

  if (!snapshot || !draft) {
    return <div className={`settings-sections permission-policy ${className}`.trim()}>
      <div className="permission-policy-error settings-card" role="alert">{error || '权限策略不可用'}</div>
    </div>;
  }

  return <div className={`settings-sections permission-policy ${className}`.trim()} aria-label="Agent 权限策略">
    <SettingsPageHeader
      className="permission-policy-page-head"
      icon={<ShieldCheck />}
      title="Agent 权限"
      meta={<span className="permission-policy-live"><i />实时生效</span>}
      description="按工具、命令或路径配置允许、询问和拒绝。更改从下一次工具调用开始生效，不中断当前任务。"
      actions={<button type="button" className="settings-outline permission-policy-reset" disabled={busy} onClick={() => void resetPolicy()}>
        <RotateCcw />{scope === 'user' ? '恢复默认' : '恢复继承'}
      </button>}
    />

    <section className="settings-card permission-policy-card permission-policy-scope-card">
      <div className="settings-card-head permission-policy-section-head">
        <div>
          <h2>作用范围</h2>
          <p>窄范围策略会覆盖上层规则；删除覆盖后会重新继承。</p>
        </div>
        <span className="permission-policy-effective">
          当前生效
          <strong>{SCOPE_LABELS[snapshot.effectiveScope]}</strong>
        </span>
      </div>

      <div className="permission-policy-scopes" role="tablist" aria-label="权限作用域">
        {(Object.keys(SCOPE_LABELS) as PermissionScope[]).map((item) => {
          const available = scopeAvailable(item, snapshot.cwd, snapshot.sessionId);
          const configured = item === 'user' || Boolean(snapshot.scopes[item]);
          return <button
            type="button"
            role="tab"
            aria-selected={scope === item}
            className={scope === item ? 'is-active' : ''}
            disabled={!available}
            key={item}
            onClick={() => void selectScope(item)}
          >
            <span>{SCOPE_LABELS[item]}</span>
            <small>{item === 'user' ? '所有工作区' : configured ? '已覆盖' : '继承'}</small>
          </button>;
        })}
      </div>

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

      {inherited && <div className="permission-policy-inherit-note">
        当前作用域正在继承上层策略。保存后会创建独立覆盖。
      </div>}
    </section>

    <section className="settings-card permission-policy-card">
      <div className="settings-card-head permission-policy-section-head">
        <div>
          <h2>默认模式</h2>
          <p>现有规则始终优先；没有命中规则时，使用这里的预设和默认决定。</p>
        </div>
        <label className="permission-policy-select">
          <span>未命中时</span>
          <Select
            label="未命中时的权限决定"
            value={draft.default}
            options={DECISION_OPTIONS}
            onChange={(value) => patchDraft({ default: value as PermissionDecision })}
          />
        </label>
      </div>
      <div className="permission-policy-presets">
        {snapshot.catalog.modes.map((mode) => {
          const ModeIcon = modeIcon(mode.id);
          const selected = draft.preset === mode.id;
          return <button
            type="button"
            aria-pressed={selected}
            className={`permission-preset ${selected ? 'is-active' : ''} ${mode.id === 'full' ? 'is-sensitive' : ''}`}
            key={mode.id}
            onClick={() => void applyPreset(mode.id)}
          >
            <span className="permission-preset-top">
              <span className="permission-preset-icon"><ModeIcon /></span>
              <span className="permission-preset-check">{selected && <Check />}</span>
            </span>
            <span className="permission-preset-copy">
              <strong>{mode.label}</strong>
              <small>{mode.description}</small>
            </span>
          </button>;
        })}
      </div>
    </section>

    <section className="settings-card permission-policy-card">
      <div className="settings-card-head permission-policy-section-head">
        <div>
          <h2>工具覆盖</h2>
          <p>支持精确名称和通配符，例如 <code>mcp__github__*</code>。工具覆盖优先于默认模式。</p>
        </div>
        <span className="permission-policy-count" aria-label={`${toolOverrides.length} 条工具覆盖`}>
          <ListFilter />
          {toolOverrides.length}
        </span>
      </div>

      {toolOverrides.length === 0
        ? <div className="permission-policy-empty">
          <ListFilter />
          <span><strong>没有工具覆盖</strong><small>所有工具都会使用上方默认模式。</small></span>
        </div>
        : <div className="permission-policy-rows">
          {toolOverrides.map(([pattern, decision]) => <div className="permission-policy-row" key={pattern}>
            <span className="permission-policy-row-key"><code>{pattern}</code><small>工具或通配符</small></span>
            <Select
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
            onKeyDown={(event) => { if (event.key === 'Enter') addToolOverride(); }}
          />
        </label>
        <label>
          <span>决定</span>
          <Select
            label="新工具覆盖的权限决定"
            value={newDecision}
            options={DECISION_OPTIONS}
            onChange={(value) => setNewDecision(value as PermissionDecision)}
          />
        </label>
        <button type="button" className="settings-add-button" onClick={addToolOverride} disabled={!newTool.trim()}><Plus />添加覆盖</button>
      </div>
    </section>

    <section className="settings-card permission-policy-card permission-policy-rules">
      <div className="settings-card-head permission-policy-section-head">
        <div>
          <h2>高级规则 <span className="count-badge">{draft.rules.length}</span></h2>
          <p>拒绝优先于询问，询问优先于允许。路径规则相对当前工作区解析。</p>
        </div>
        <button type="button" className="settings-add-button" onClick={addRule}><Plus />新规则</button>
      </div>

      {draft.rules.length === 0
        ? <div className="permission-policy-empty">
          <SlidersHorizontal />
          <span><strong>没有高级规则</strong><small>添加命令或路径条件，精确控制例外情况。</small></span>
        </div>
        : <div className="permission-rule-list">
          {draft.rules.map((rule) => {
            const condition = ruleCondition(rule);
            const conditions = conditionsForTool(rule.match.tool);
            return <article className="permission-rule" key={rule.id}>
              <div className="permission-rule-title">
                <input
                  aria-label="规则说明"
                  value={rule.label}
                  placeholder="说明这条规则"
                  onChange={(event) => updateRule(rule.id, (current) => ({ ...current, label: event.target.value }))}
                />
                <Select
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
                      const currentCondition = ruleCondition(current);
                      const nextCondition = conditionsForTool(event.target.value).includes(currentCondition)
                        ? currentCondition
                        : 'tool';
                      return {
                        ...current,
                        match: matchForCondition(
                          event.target.value,
                          nextCondition,
                          nextCondition === currentCondition ? conditionValue(current) : '',
                        ),
                      };
                    })}
                  />
                </label>
                <label>
                  <span>条件</span>
                  <Select
                    label={`${rule.label || '自定义规则'}的条件`}
                    value={conditions.includes(condition) ? condition : 'tool'}
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

    <section className="settings-card permission-policy-card permission-policy-preview">
      <div className="settings-card-head permission-policy-section-head">
        <div>
          <h2>策略预览</h2>
          <p>使用与运行时相同的规则引擎，验证结果但不会执行工具。</p>
        </div>
        <span className="permission-policy-section-icon"><FlaskConical aria-hidden="true" /></span>
      </div>
      <div className="permission-preview-form">
        <label>
          <span>工具</span>
          <Select
            label="预览工具"
            value={previewTool}
            options={PREVIEW_TOOL_OPTIONS}
            onChange={setPreviewTool}
          />
        </label>
        <label className="is-wide">
          <span>{previewTool === 'bash' ? '命令' : ['read', 'write', 'edit'].includes(previewTool) ? '路径' : '调用参数'}</span>
          {previewTool === 'bash'
            ? <input value={previewCommand} onChange={(event) => setPreviewCommand(event.target.value)} placeholder="command" />
            : ['read', 'write', 'edit'].includes(previewTool)
              ? <input value={previewPath} onChange={(event) => setPreviewPath(event.target.value)} placeholder="path" />
              : <span className="permission-preview-empty-args">无路径或命令参数</span>}
        </label>
        <button type="button" className="settings-outline" disabled={busy} onClick={() => void evaluatePreview()}>预览结果</button>
      </div>
      {preview && <div className={`permission-preview-result is-${preview.decision}`}>
        <strong>{DECISION_LABELS[preview.decision]}</strong>
        <small className="permission-preview-draft">未保存草稿 · {SCOPE_LABELS[preview.previewScope || scope]}</small>
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

    {error && <div className="permission-policy-message is-error" role="alert">{error}</div>}
    {notice && <div className="permission-policy-message is-success" role="status">{notice}</div>}
    <footer className="settings-card permission-policy-actions">
      <span>
        <small>{dirty ? '有未保存更改' : '策略已同步'}</small>
        <strong>生效范围：{SCOPE_LABELS[snapshot.effectiveScope]}</strong>
      </span>
      <button type="button" className="settings-save" disabled={!dirty || busy} onClick={() => void savePolicy()}>
        <Save />{busy ? '保存中…' : '保存权限策略'}
      </button>
    </footer>
    {actionConfirmation.dialog}
  </div>;
}
