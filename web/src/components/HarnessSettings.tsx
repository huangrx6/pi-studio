import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import {
  BrainCircuit,
  Check,
  ChevronRight,
  CircleAlert,
  FileCode2,
  Info,
  LoaderCircle,
  Plus,
  RotateCcw,
  Save,
  Sparkles,
  Trash2,
  Workflow,
  Wrench,
  X,
} from 'lucide-react';
import { SettingsDialog } from './SettingsDialog';
import { Select } from './Select';
import { useActionConfirmation } from './ConfirmDialog';
import type {
  HarnessProfile,
  HarnessSectionId,
  HarnessSettingsSnapshot,
  RuntimePolicy,
} from '../types/harness-types';
import { runtimeRefreshFailure } from '../lib/runtime-refresh';

const SECTION_ICONS = {
  preamble: BrainCircuit,
  tools: Wrench,
  rules: FileCode2,
  repositoryDocs: FileCode2,
  projectContext: Workflow,
  skills: Sparkles,
  cwd: Workflow,
  addendum: Info,
} satisfies Record<HarnessSectionId, typeof BrainCircuit>;

function cloneProfile(profile: HarnessProfile): HarnessProfile {
  return {
    ...profile,
    sections: { ...profile.sections },
    sectionOverrides: { ...profile.sectionOverrides },
    toolGuidance: { ...profile.toolGuidance },
  };
}

function cloneRuntimePolicy(policy: RuntimePolicy): RuntimePolicy {
  return {
    ...policy,
    retry: { ...policy.retry },
    compaction: { ...policy.compaction },
  };
}

function slugify(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[^a-z0-9]+/, '')
    .slice(0, 64);
}

function profileSignature(profile: HarnessProfile): string {
  return JSON.stringify(profile);
}

export function HarnessSettings({
  cwd,
  initial,
  enabledTools,
  onUpdated,
}: {
  cwd: string;
  initial: HarnessSettingsSnapshot;
  enabledTools: string[];
  onUpdated?: (snapshot: HarnessSettingsSnapshot) => void;
}) {
  const actionConfirmation = useActionConfirmation();
  const [snapshot, setSnapshot] = useState(initial);
  const [selectedId, setSelectedId] = useState(initial.activeProfile.id);
  const [draft, setDraft] = useState(() => cloneProfile(initial.activeProfile));
  const [policyDraft, setPolicyDraft] = useState(() => cloneRuntimePolicy(initial.runtimePolicy));
  const [scope, setScope] = useState<'workspace' | 'global'>(cwd ? 'workspace' : 'global');
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [policySaving, setPolicySaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [newProfileOpen, setNewProfileOpen] = useState(false);
  const [newProfile, setNewProfile] = useState({ name: '', id: '' });
  const requestRef = useRef(0);

  const selectedStored = snapshot.profiles.find((profile) => profile.id === selectedId)
    || snapshot.profiles.find((profile) => profile.id === snapshot.activeProfileId)
    || snapshot.profiles[0];
  const dirty = Boolean(selectedStored && profileSignature(draft) !== profileSignature(selectedStored));
  const policyDirty = JSON.stringify(policyDraft) !== JSON.stringify(snapshot.runtimePolicy);
  const activeForScope = scope === 'global'
    ? snapshot.globalProfileId
    : cwd
      ? snapshot.workspaceProfileId || snapshot.globalProfileId
      : snapshot.globalProfileId;
  const applied = activeForScope === selectedId;
  const toolSuggestions = useMemo(
    () => enabledTools.filter((name) => name !== '*').sort((left, right) => left.localeCompare(right)),
    [enabledTools],
  );

  useEffect(() => {
    setScope(cwd ? 'workspace' : 'global');
  }, [cwd]);

  useEffect(() => {
    const request = ++requestRef.current;
    setLoading(true);
    setError(null);
    void window.piApi.harnessSettings(cwd)
      .then((next) => {
        if (request !== requestRef.current) return;
        setSnapshot(next);
        setSelectedId(next.activeProfile.id);
        setDraft(cloneProfile(next.activeProfile));
        setPolicyDraft(cloneRuntimePolicy(next.runtimePolicy));
        onUpdated?.(next);
      })
      .catch((cause) => {
        if (request === requestRef.current) setError(cause instanceof Error ? cause.message : String(cause));
      })
      .finally(() => {
        if (request === requestRef.current) setLoading(false);
      });
  }, [cwd]);

  function acceptSnapshot(next: HarnessSettingsSnapshot, profileId = selectedId) {
    const refreshFailure = runtimeRefreshFailure(next.runtimeRefresh);
    if (refreshFailure) setError(refreshFailure);
    setSnapshot(next);
    const profile = next.profiles.find((item) => item.id === profileId)
      || next.profiles.find((item) => item.id === next.activeProfileId)
      || next.profiles[0];
    if (profile) {
      setSelectedId(profile.id);
      setDraft(cloneProfile(profile));
    }
    setPolicyDraft(cloneRuntimePolicy(next.runtimePolicy));
    onUpdated?.(next);
  }

  async function selectProfile(profile: HarnessProfile): Promise<boolean> {
    if (profile.id === selectedId) return true;
    if (dirty) {
      const accepted = await actionConfirmation.confirm({
        title: '丢弃未保存的 Harness 更改？',
        description: '切换配置会使用已保存版本重新填充编辑器，尚未保存的 section、指令和工具 guidance 将丢失。',
        confirmLabel: '丢弃并切换',
        tone: 'danger',
      });
      if (!accepted) return false;
    }
    setSelectedId(profile.id);
    setDraft(cloneProfile(profile));
    setError(null);
    setMessage(null);
    return true;
  }

  function handleProfileTabKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    let nextIndex: number | null = null;
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
      nextIndex = (index + 1) % snapshot.profiles.length;
    } else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
      nextIndex = (index - 1 + snapshot.profiles.length) % snapshot.profiles.length;
    } else if (event.key === 'Home') {
      nextIndex = 0;
    } else if (event.key === 'End') {
      nextIndex = snapshot.profiles.length - 1;
    }
    if (nextIndex === null) return;
    event.preventDefault();
    const profile = snapshot.profiles[nextIndex];
    void selectProfile(profile).then((changed) => {
      if (!changed) return;
      requestAnimationFrame(() => {
        document.getElementById(`harness-profile-tab-${profile.id}`)?.focus();
      });
    });
  }

  function updateSection(id: HarnessSectionId, enabled: boolean) {
    setDraft((current) => ({
      ...current,
      sections: { ...current.sections, [id]: enabled },
    }));
  }

  function updateSectionOverride(id: HarnessSectionId, value: string) {
    setDraft((current) => {
      const sectionOverrides = { ...current.sectionOverrides };
      if (value) sectionOverrides[id] = value;
      else delete sectionOverrides[id];
      return { ...current, sectionOverrides };
    });
  }

  function updateGuidance(previousName: string, name: string, guidance: string) {
    setDraft((current) => {
      const toolGuidance = { ...current.toolGuidance };
      if (previousName && previousName !== name) delete toolGuidance[previousName];
      if (name.trim() && guidance.trim()) toolGuidance[name.trim()] = guidance;
      else if (name.trim()) delete toolGuidance[name.trim()];
      return { ...current, toolGuidance };
    });
  }

  function addGuidance() {
    let index = 1;
    let name = 'new-tool';
    while (Object.hasOwn(draft.toolGuidance, name)) {
      index += 1;
      name = `new-tool-${index}`;
    }
    setDraft((current) => ({
      ...current,
      toolGuidance: { ...current.toolGuidance, [name]: '' },
    }));
  }

  function removeGuidance(name: string) {
    setDraft((current) => {
      const toolGuidance = { ...current.toolGuidance };
      delete toolGuidance[name];
      return { ...current, toolGuidance };
    });
  }

  async function saveProfile() {
    setSaving(true);
    setError(null);
    setMessage(null);
    try {
      const next = await window.piApi.saveHarnessProfile({ cwd, profile: draft });
      acceptSnapshot(next, draft.id);
      setMessage('配置已保存。下一条请求会使用新的 Harness。');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  }

  async function applyProfile() {
    setSaving(true);
    setError(null);
    setMessage(null);
    try {
      const next = await window.piApi.selectHarnessProfile({
        cwd,
        id: selectedId,
        scope,
      });
      acceptSnapshot(next, selectedId);
      setMessage(scope === 'global'
        ? '已设为所有工作区的默认 Harness。'
        : '已应用到当前工作区。');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  }

  async function savePolicy() {
    setPolicySaving(true);
    setError(null);
    setMessage(null);
    try {
      const next = await window.piApi.saveRuntimePolicy({ cwd, policy: policyDraft });
      acceptSnapshot(next, selectedId);
      setMessage('Durable 运行策略已保存；下一条请求或工具轮次会读取新设置。');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setPolicySaving(false);
    }
  }

  async function resetProfile() {
    if (!selectedStored) return;
    const accepted = await actionConfirmation.confirm({
      title: '恢复 Studio 编码基线？',
      description: `“${selectedStored.name}”当前的 section 开关、覆盖内容、工具 guidance 和附加指令会被基线配置替换。`,
      confirmLabel: '恢复基线',
    });
    if (!accepted) return;
    setSaving(true);
    setError(null);
    setMessage(null);
    try {
      const next = await window.piApi.resetHarnessProfile({ cwd, id: selectedId });
      acceptSnapshot(next, selectedId);
      setMessage('已恢复基线配置。');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  }

  async function deleteProfile() {
    if (!selectedStored || selectedStored.builtin) return;
    const accepted = await actionConfirmation.confirm({
      title: '删除 Harness 配置？',
      description: `“${selectedStored.name}”会从当前 Harness 列表删除；引用它的工作区将恢复继承全局默认。`,
      confirmLabel: '删除配置',
      tone: 'danger',
    });
    if (!accepted) return;
    setSaving(true);
    setError(null);
    setMessage(null);
    try {
      const next = await window.piApi.deleteHarnessProfile({ cwd, id: selectedId });
      acceptSnapshot(next, next.activeProfileId);
      setMessage('配置已删除。');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  }

  async function createProfile() {
    const id = slugify(newProfile.id || newProfile.name);
    if (!/^[a-z0-9][a-z0-9._-]{1,63}$/.test(id) || ['constructor', 'prototype'].includes(id)) {
      setError('Harness ID 需要 2–64 个小写字母、数字、点、横线或下划线。');
      return;
    }
    if (!newProfile.name.trim()) {
      setError('请填写 Harness 名称。');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const next = await window.piApi.saveHarnessProfile({
        cwd,
        profile: {
          ...draft,
          id,
          name: newProfile.name.trim(),
          builtin: false,
        },
      });
      acceptSnapshot(next, id);
      setNewProfileOpen(false);
      setNewProfile({ name: '', id: '' });
      setMessage('新 Harness 已创建。');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  }

  return <div className="settings-sections harness-settings">
    <section className="settings-card harness-overview-card">
      <div className="settings-card-head">
        <div>
          <h2>Harness 配置 <span className="count-badge">{snapshot.profiles.length}</span></h2>
          <p>Studio 自己构建 System Prompt、项目上下文和工具策略，不依赖 Coding Agent SDK 的隐式默认值。保存后从下一条请求开始热加载。</p>
        </div>
      </div>
      <div className="harness-runtime-line">
        <span className={applied ? 'is-ready' : 'is-pending'}>
          {applied ? <Check /> : <CircleAlert />}
          {applied ? '当前范围正在使用' : '尚未应用到当前范围'}
        </span>
        <code>{snapshot.path}</code>
        <span>SQLite 持久化 · 下一请求生效</span>
      </div>
      <div className="harness-runtime-line harness-instruction-line">
        <span className={snapshot.globalInstructionsStatus === 'present'
          ? 'is-ready'
          : snapshot.globalInstructionsStatus === 'unreadable'
            ? 'is-pending'
            : undefined}
        >
          {snapshot.globalInstructionsStatus === 'present' ? <Check /> : <FileCode2 />}
          {snapshot.globalInstructionsStatus === 'present'
            ? '全局指令已配置'
            : snapshot.globalInstructionsStatus === 'unreadable'
              ? '全局指令无法读取'
              : '未配置全局指令'}
        </span>
        <code title={snapshot.globalInstructionsPath}>{snapshot.globalInstructionsPath}</code>
      </div>
      <div className="harness-profile-switcher">
        <div className="harness-profile-tabs-head">
          <div>
            <strong>Profiles</strong>
            <span>每个标签是一套独立配置，切换后只编辑当前 profile。</span>
          </div>
          <button type="button" className="settings-add-button" disabled={saving} onClick={() => setNewProfileOpen(true)}>
            <Plus />新建配置
          </button>
        </div>
        <div className="harness-profile-tabs" role="tablist" aria-label="Harness Profile">
          {snapshot.profiles.map((profile, index) => {
            const globalApplied = profile.id === snapshot.globalProfileId;
            const workspaceApplied = Boolean(cwd && profile.id === snapshot.workspaceProfileId);
            const usageLabel = globalApplied && workspaceApplied
              ? '全局与当前工作区默认使用'
              : globalApplied
                ? '全局默认使用'
                : workspaceApplied
                  ? '当前工作区使用'
                  : '';
            return <button
              type="button"
              role="tab"
              id={`harness-profile-tab-${profile.id}`}
              key={profile.id}
              aria-selected={profile.id === selectedId}
              aria-controls="harness-profile-panel"
              tabIndex={profile.id === selectedId ? 0 : -1}
              className={`harness-profile-tab ${profile.id === selectedId ? 'is-active' : ''}`}
              onClick={() => void selectProfile(profile)}
              onKeyDown={(event) => handleProfileTabKeyDown(event, index)}
            >
              <span className="harness-profile-tab-icon"><BrainCircuit /></span>
              <span className="harness-profile-tab-copy">
                <strong>{profile.name}</strong>
                <code>{profile.id}</code>
              </span>
              <span className="harness-profile-tab-meta">
                {profile.builtin && <em>基线</em>}
                {usageLabel && <i title={usageLabel} aria-label={usageLabel} />}
              </span>
            </button>;
          })}
        </div>
      </div>
    </section>

    {(error || message) && <div className={`harness-notice ${error ? 'is-error' : 'is-success'}`} role={error ? 'alert' : 'status'}>
      {error ? <CircleAlert /> : <Check />}
      <span>{error || message}</span>
    </div>}

    <div className={loading ? 'harness-loading is-visible' : 'harness-loading'} role="status">
      <LoaderCircle className="spin" />正在刷新 Harness 配置
    </div>

    <div
      className="harness-editor"
      id="harness-profile-panel"
      role="tabpanel"
      aria-labelledby={`harness-profile-tab-${selectedId}`}
    >
      <section className="settings-card">
        <div className="harness-editor-head">
          <div className="harness-editor-identity">
            <span>
              {draft.builtin ? 'Studio 基线' : '自定义 Harness'}
              {dirty && <em>未保存</em>}
            </span>
            <input
              aria-label="Harness 名称"
              value={draft.name}
              onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))}
            />
            <code>{draft.id}</code>
          </div>
          <div className="harness-editor-actions">
            <div className="harness-editor-action-group is-secondary">
              {!selectedStored?.builtin && <button type="button" className="settings-text-button is-danger" disabled={saving} onClick={() => void deleteProfile()}><Trash2 />删除</button>}
              <button type="button" className="settings-text-button" disabled={saving} onClick={() => void resetProfile()}><RotateCcw />恢复基线</button>
              <button type="button" className="settings-outline" disabled={!dirty || saving} onClick={() => selectedStored && setDraft(cloneProfile(selectedStored))}>撤销</button>
            </div>
            <div className="harness-editor-action-group is-primary">
              <button type="button" className="settings-save" disabled={!dirty || saving || !draft.name.trim()} onClick={() => void saveProfile()}>
                {saving ? <LoaderCircle className="spin" /> : <Save />}保存配置
              </button>
              <button
                type="button"
                className={`settings-outline harness-apply-button ${applied ? 'is-applied' : ''}`}
                disabled={saving || applied || dirty}
                onClick={() => void applyProfile()}
              >
                {saving ? <LoaderCircle className="spin" /> : <Check />}
                {dirty ? '先保存' : applied ? '已应用' : scope === 'global' ? '设为全局默认' : '应用到工作区'}
              </button>
            </div>
          </div>
        </div>
        <div className="harness-editor-context">
          <div>
            <span className={applied ? 'is-ready' : 'is-pending'}>
              {applied ? <Check /> : <CircleAlert />}
              {dirty ? '有未保存的更改' : applied ? '当前范围正在使用' : '配置已保存但尚未应用'}
            </span>
            <small>{dirty ? '保存后可应用；保存与选择分开，不会影响其他 profile。' : '工作区配置优先于全局默认；下一条请求生效。'}</small>
          </div>
          <div className="settings-scope-tabs" role="tablist" aria-label="Harness 应用范围">
            <button type="button" role="tab" aria-selected={scope === 'workspace'} className={scope === 'workspace' ? 'is-active' : ''} disabled={!cwd} onClick={() => setScope('workspace')}>当前工作区</button>
            <button type="button" role="tab" aria-selected={scope === 'global'} className={scope === 'global' ? 'is-active' : ''} onClick={() => setScope('global')}>全局默认</button>
          </div>
        </div>

          <div className="harness-section-heading">
            <div><h3>Prompt Sections</h3><p>关闭一个 section 后，下一条请求不会再生成这段提示词。</p></div>
          </div>
          <div className="harness-section-grid">
            {snapshot.sections.map((section) => {
              const Icon = SECTION_ICONS[section.id];
              const enabled = draft.sections[section.id] !== false;
              return <button
                type="button"
                key={section.id}
                className={`harness-section-card ${enabled ? 'is-enabled' : ''}`}
                aria-pressed={enabled}
                onClick={() => updateSection(section.id, !enabled)}
              >
                <span className="harness-section-icon"><Icon /></span>
                <span>
                  <strong>{section.label}</strong>
                  <small>{section.description}</small>
                </span>
                <span className="harness-section-state">{enabled ? <Check /> : <X />}</span>
              </button>;
            })}
          </div>
          <div className="harness-section-overrides">
            <div className="harness-section-overrides-head">
              <div><h3>精细覆盖</h3><p>留空时使用 Studio 基线；只有填写内容才替换对应 section。动态工具、项目指令和技能内容也可按需固定。</p></div>
              <span className="settings-scope-badge">可选</span>
            </div>
            {snapshot.sections.map((section) => {
              const enabled = draft.sections[section.id] !== false;
              const value = draft.sectionOverrides[section.id] || '';
              const Icon = SECTION_ICONS[section.id];
              const state = !enabled ? '已关闭' : value.trim() ? '已覆盖' : 'Studio 默认';
              return <details className={`harness-section-override ${!enabled ? 'is-disabled' : ''}`} key={section.id}>
                <summary>
                  <span className="harness-section-override-main">
                    <span className="harness-section-override-icon"><Icon /></span>
                    <span className="harness-section-override-copy">
                      <strong>{section.label}</strong>
                      <small className={!enabled ? 'is-off' : value.trim() ? 'is-overridden' : ''}>{state}</small>
                    </span>
                  </span>
                  <ChevronRight className="harness-section-override-chevron" />
                </summary>
                <div className="harness-section-override-body">
                  <textarea
                    aria-label={`${section.label}覆盖内容`}
                    rows={5}
                    maxLength={32 * 1024}
                    disabled={!enabled}
                    value={value}
                    placeholder={`留空以使用 Studio 的「${section.label}」基线。`}
                    onChange={(event) => updateSectionOverride(section.id, event.target.value)}
                  />
                  <div>
                    <span>{value.length.toLocaleString()} / 32,768</span>
                    <button
                      type="button"
                      className="settings-text-button"
                      disabled={!value}
                      onClick={() => updateSectionOverride(section.id, '')}
                    >
                      恢复此段默认
                    </button>
                  </div>
                </div>
              </details>;
            })}
          </div>
        </section>

        <section className="settings-card">
          <div className="settings-card-head">
            <div><h2>工具策略</h2><p>只给本次真正开放的 Tool 添加使用说明。Studio 的自定义说明优先于内置策略。</p></div>
            <button type="button" className="settings-outline" onClick={addGuidance}><Plus />添加工具说明</button>
          </div>
          <div className="harness-tool-guidance-list">
            {Object.entries(draft.toolGuidance).map(([name, guidance]) => (
              <div className="harness-tool-guidance-row" key={name}>
                <label>
                  <span>工具</span>
                  <input
                    list="harness-tool-suggestions"
                    value={name}
                    onChange={(event) => updateGuidance(name, event.target.value, guidance)}
                    placeholder="edit"
                  />
                </label>
                <label>
                  <span>补充说明</span>
                  <textarea
                    rows={2}
                    value={guidance}
                    onChange={(event) => updateGuidance(name, name, event.target.value)}
                    placeholder="例如：修改后优先运行该模块最相关的测试。"
                  />
                </label>
                <button type="button" className="icon-button" aria-label={`删除 ${name} 的工具说明`} title="删除" onClick={() => removeGuidance(name)}>
                  <Trash2 />
                </button>
              </div>
            ))}
            <datalist id="harness-tool-suggestions">
              {toolSuggestions.map((name) => <option value={name} key={name} />)}
            </datalist>
            {Object.keys(draft.toolGuidance).length === 0 && <div className="harness-guidance-empty"><Wrench /><span><strong>沿用内置工具策略</strong><small>Studio 会继续为当前开放的工具注入默认编码指导。</small></span></div>}
          </div>
        </section>

        <section className="settings-card harness-policy-card">
          <div className="settings-card-head harness-policy-head">
            <div>
              <h2>Durable 运行策略 <span className="settings-scope-badge">全局</span></h2>
              <p>控制所有 Studio 会话的重试、上下文压缩、工具调度和故障恢复。Durable 在运行期读取这些值，正在执行的任务阶段不会被打断。</p>
            </div>
            <div className="harness-policy-actions">
              <button
                type="button"
                className="settings-text-button"
                disabled={policySaving}
                onClick={() => setPolicyDraft(cloneRuntimePolicy(snapshot.runtimePolicyDefaults))}
              >
                Studio 默认值
              </button>
              <button
                type="button"
                className="settings-outline"
                disabled={!policyDirty || policySaving}
                onClick={() => setPolicyDraft(cloneRuntimePolicy(snapshot.runtimePolicy))}
              >
                撤销
              </button>
              <button
                type="button"
                className="settings-save"
                disabled={!policyDirty || policySaving}
                onClick={() => void savePolicy()}
              >
                {policySaving ? <LoaderCircle className="spin" /> : <Save />}
                保存策略
              </button>
            </div>
          </div>

          <div className="harness-policy-note">
            <Info />
            <span>运行策略是 Harness 级配置。Prompt profile 可以按全局或工作区选择；这些执行策略由 Durable 共享，因此保持全局，避免界面显示工作区隔离但底层实际共享。</span>
            <code title={snapshot.runtimePolicyPath}>{snapshot.runtimePolicyPath}</code>
          </div>

          <div className="harness-policy-grid">
            <section className="harness-policy-group">
              <header><strong>请求与重试</strong><span>模型请求失败后的恢复方式</span></header>
              <div className="harness-policy-row">
                <span><strong>自动重试</strong><small>失败后按指数退避重新请求</small></span>
                <button
                  type="button"
                  className={`switch ${policyDraft.retry.enabled ? 'is-on' : ''}`}
                  role="switch"
                  aria-checked={policyDraft.retry.enabled}
                  aria-label="自动重试"
                  onClick={() => setPolicyDraft((current) => ({
                    ...current,
                    retry: { ...current.retry, enabled: !current.retry.enabled },
                  }))}
                >
                  <span />
                </button>
              </div>
              <div className="harness-policy-fields">
                <label>
                  <span>最大重试次数</span>
                  <input
                    type="number"
                    min={0}
                    max={10}
                    value={policyDraft.retry.maxRetries}
                    disabled={!policyDraft.retry.enabled}
                    onChange={(event) => setPolicyDraft((current) => ({
                      ...current,
                      retry: { ...current.retry, maxRetries: Number(event.target.value) },
                    }))}
                  />
                </label>
                <label>
                  <span>首次等待</span>
                  <div className="harness-policy-input-suffix">
                    <input
                      type="number"
                      min={100}
                      max={60_000}
                      step={100}
                      value={policyDraft.retry.baseDelayMs}
                      disabled={!policyDraft.retry.enabled}
                      onChange={(event) => setPolicyDraft((current) => ({
                        ...current,
                        retry: { ...current.retry, baseDelayMs: Number(event.target.value) },
                      }))}
                    />
                    <span>ms</span>
                  </div>
                </label>
                <label>
                  <span>单次请求超时</span>
                  <Select
                    label="单次请求超时"
                    value={String(policyDraft.streamTimeoutMs)}
                    options={[
                      { value: '0', label: 'Provider 默认' },
                      { value: '60000', label: '1 分钟' },
                      { value: '120000', label: '2 分钟' },
                      { value: '300000', label: '5 分钟' },
                      { value: '600000', label: '10 分钟' },
                      { value: '1200000', label: '20 分钟' },
                      { value: '1800000', label: '30 分钟' },
                    ]}
                    onChange={(value) => setPolicyDraft((current) => ({
                      ...current,
                      streamTimeoutMs: Number(value),
                    }))}
                  />
                </label>
              </div>
            </section>

            <section className="harness-policy-group">
              <header><strong>工具调度与恢复</strong><span>一轮工具调用如何执行</span></header>
              <div className="harness-policy-fields">
                <label>
                  <span>工具执行顺序</span>
                  <Select
                    label="工具执行顺序"
                    value={policyDraft.toolExecution}
                    options={[
                      { value: 'parallel', label: '并行', description: '同一轮中互不依赖的工具调用同时执行；后续依赖步骤仍按轮次执行。' },
                      { value: 'sequential', label: '顺序', description: '同一轮工具逐个执行，便于审查每一步结果。' },
                    ]}
                    onChange={(value) => setPolicyDraft((current) => ({
                      ...current,
                      toolExecution: value as RuntimePolicy['toolExecution'],
                    }))}
                  />
                </label>
                <label>
                  <span>失败后排队输入</span>
                  <Select
                    label="失败后排队输入"
                    value={policyDraft.afterFailedRun}
                    options={[
                      { value: 'keep', label: '保留等待', description: '保留下一条输入，等待用户继续。' },
                      { value: 'continue', label: '继续执行', description: '像正常回复结束一样启动下一条输入。' },
                      { value: 'withdraw', label: '撤回', description: '将排队输入标记为未回答。' },
                    ]}
                    onChange={(value) => setPolicyDraft((current) => ({
                      ...current,
                      afterFailedRun: value as RuntimePolicy['afterFailedRun'],
                    }))}
                  />
                </label>
                <label>
                  <span>崩溃重启上限</span>
                  <input
                    type="number"
                    min={1}
                    max={50}
                    value={policyDraft.restartLimit}
                    onChange={(event) => setPolicyDraft((current) => ({
                      ...current,
                      restartLimit: Number(event.target.value),
                    }))}
                  />
                  <small>连续中断达到上限后暂停任务，避免崩溃循环。</small>
                </label>
              </div>
            </section>

            <section className="harness-policy-group">
              <header><strong>上下文压缩</strong><span>接近上下文窗口时保留最近工作</span></header>
              <div className="harness-policy-row">
                <span><strong>自动压缩</strong><small>关闭后仍可手动压缩</small></span>
                <button
                  type="button"
                  className={`switch ${policyDraft.compaction.enabled ? 'is-on' : ''}`}
                  role="switch"
                  aria-checked={policyDraft.compaction.enabled}
                  aria-label="自动压缩上下文"
                  onClick={() => setPolicyDraft((current) => ({
                    ...current,
                    compaction: {
                      ...current.compaction,
                      enabled: !current.compaction.enabled,
                    },
                  }))}
                >
                  <span />
                </button>
              </div>
              <div className="harness-policy-fields is-three">
                <label>
                  <span>回答预留</span>
                  <input
                    type="number"
                    min={1_024}
                    max={262_144}
                    step={1_024}
                    value={policyDraft.compaction.reserveTokens}
                    disabled={!policyDraft.compaction.enabled}
                    onChange={(event) => setPolicyDraft((current) => ({
                      ...current,
                      compaction: {
                        ...current.compaction,
                        reserveTokens: Number(event.target.value),
                      },
                    }))}
                  />
                  <small>tokens</small>
                </label>
                <label>
                  <span>保留最近</span>
                  <input
                    type="number"
                    min={0}
                    max={262_144}
                    step={1_024}
                    value={policyDraft.compaction.keepRecentTokens}
                    disabled={!policyDraft.compaction.enabled}
                    onChange={(event) => setPolicyDraft((current) => ({
                      ...current,
                      compaction: {
                        ...current.compaction,
                        keepRecentTokens: Number(event.target.value),
                      },
                    }))}
                  />
                  <small>tokens</small>
                </label>
                <label>
                  <span>后台提前量</span>
                  <input
                    type="number"
                    min={0}
                    max={262_144}
                    step={1_024}
                    value={policyDraft.compaction.backgroundTokens}
                    disabled={!policyDraft.compaction.enabled}
                    onChange={(event) => setPolicyDraft((current) => ({
                      ...current,
                      compaction: {
                        ...current.compaction,
                        backgroundTokens: Number(event.target.value),
                      },
                    }))}
                  />
                  <small>0 表示关闭后台压缩</small>
                </label>
              </div>
            </section>

            <section className="harness-policy-group">
              <header><strong>内存缓存</strong><span>空闲后释放 transcript 与 document 缓存</span></header>
              <div className="harness-policy-fields">
                <label>
                  <span>会话上下文缓存</span>
                  <Select
                    label="会话上下文缓存"
                    value={String(policyDraft.contextRetentionMs)}
                    options={[
                      { value: '0', label: '空闲后立即释放' },
                      { value: '30000', label: '30 秒' },
                      { value: '90000', label: '90 秒' },
                      { value: '300000', label: '5 分钟' },
                      { value: '600000', label: '10 分钟' },
                      { value: '1800000', label: '30 分钟' },
                      { value: '3600000', label: '1 小时' },
                    ]}
                    onChange={(value) => setPolicyDraft((current) => ({
                      ...current,
                      contextRetentionMs: Number(value),
                    }))}
                  />
                </label>
                <label>
                  <span>Assist document 缓存</span>
                  <Select
                    label="Assist document 缓存"
                    value={String(policyDraft.documentRetentionMs)}
                    options={[
                      { value: '0', label: '使用后立即释放' },
                      { value: '30000', label: '30 秒' },
                      { value: '90000', label: '90 秒' },
                      { value: '300000', label: '5 分钟' },
                      { value: '600000', label: '10 分钟' },
                      { value: '1800000', label: '30 分钟' },
                      { value: '3600000', label: '1 小时' },
                    ]}
                    onChange={(value) => setPolicyDraft((current) => ({
                      ...current,
                      documentRetentionMs: Number(value),
                    }))}
                  />
                </label>
              </div>
            </section>
          </div>
        </section>

        <section className="settings-card">
          <div className="settings-card-head">
            <div><h2>附加指令</h2><p>追加在项目指令和所有 section 之后，用于定义团队规则或个人工作方式。</p></div>
            <span className="harness-char-count">{draft.customInstructions.length.toLocaleString()} / 65,536</span>
          </div>
          <textarea
            className="harness-instructions"
            aria-label="Harness 附加指令"
            rows={7}
            maxLength={65_536}
            value={draft.customInstructions}
            placeholder="例如：修改公共 API 前先列出所有调用点；最终回复必须列出实际执行过的验证命令。"
            onChange={(event) => setDraft((current) => ({ ...current, customInstructions: event.target.value }))}
          />
        </section>

    </div>

    {newProfileOpen && <SettingsDialog
      title="新建 Harness 配置"
      description="以当前配置为起点创建独立 profile。之后修改只影响这个 profile。"
      action="创建配置"
      busy={saving}
      loading={false}
      error={error}
      showBackdrop={false}
      onClose={() => {
        if (saving) return;
        setNewProfileOpen(false);
        setError(null);
      }}
      onSubmit={() => void createProfile()}
    >
      <div className="settings-form-grid">
        <label>显示名称<input autoFocus required value={newProfile.name} onChange={(event) => {
          const name = event.target.value;
          setNewProfile((current) => ({
            name,
            id: current.id || slugify(name),
          }));
        }} placeholder="例如：Review First" /></label>
        <label>配置 ID<input required value={newProfile.id} onChange={(event) => setNewProfile((current) => ({ ...current, id: slugify(event.target.value) }))} placeholder="review-first" /><small>用于 SQLite 和工作区绑定，创建后不可修改。</small></label>
      </div>
    </SettingsDialog>}
    {actionConfirmation.dialog}
  </div>;
}
