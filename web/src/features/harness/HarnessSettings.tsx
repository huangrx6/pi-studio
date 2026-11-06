import { useSettingsDraftGuard } from '../../shared/SettingsDraftGuard';
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { Check, ChevronRight, Code2, LoaderCircle, MoreHorizontal, Plus, RotateCcw, Save, Trash2, X } from 'lucide-react';
import { ActionMenu } from '../../shared/ActionMenu';
import { SettingsDialog } from '../../shared/SettingsDialog';
import { InfoHint } from '../../shared/InfoHint';
import { SettingsPageHeader } from '../../shared/SettingsPageHeader';
import { Select } from '../../shared/Select';
import { useActionConfirmation } from '../../shared/ConfirmDialog';
import { errorText } from '../../shared/error-text';
import type { HarnessProfile, HarnessSectionId, HarnessSettingsSnapshot, RuntimePolicy } from '../../types/harness-types';
import { runtimeRefreshFailure } from '../../shared/runtime-refresh';
import { cloneHarnessProfile as cloneProfile, cloneRuntimePolicy, createHarnessRequestOwner, createHarnessWriteQueue, guidanceDraft, type GuidanceRow } from './harness-state';
import './harness-settings.css';

function slugify(value: string): string { return value.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^[^a-z0-9]+/, '').slice(0, 64); }
class HarnessReloadError extends Error {}
const harnessWrites = createHarnessWriteQueue();

export function HarnessSettings({ cwd, initial, enabledTools, onUpdated }: { cwd: string; initial: HarnessSettingsSnapshot; enabledTools: string[]; onUpdated?: (snapshot: HarnessSettingsSnapshot) => void }) {
  const actionConfirmation = useActionConfirmation();
  const [snapshot, setSnapshot] = useState(initial);
  const [selectedId, setSelectedId] = useState(initial.activeProfile.id);
  const [draft, setDraft] = useState(() => cloneProfile(initial.activeProfile));
  const guidanceId = useRef(0);
  const rowsFor = (profile: HarnessProfile) => Object.entries(profile.toolGuidance).map(([name, guidance]) => ({ key: ++guidanceId.current, name, guidance }));
  const [guidanceRows, setGuidanceRows] = useState<GuidanceRow[]>(() => rowsFor(initial.activeProfile));
  const [policyDraft, setPolicyDraft] = useState(() => cloneRuntimePolicy(initial.runtimePolicy));
  const [scope, setScope] = useState<'workspace' | 'global'>(cwd ? 'workspace' : 'global');
  const [loading, setLoading] = useState(true);
  const [readyScope, setReadyScope] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [policySaving, setPolicySaving] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [newProfileOpen, setNewProfileOpen] = useState(false);
  const [newProfile, setNewProfile] = useState({ name: '', id: '' });
  const [profileMenu, setProfileMenu] = useState<{ x: number; y: number } | null>(null);
  const owner = useRef(createHarnessRequestOwner(cwd)).current;
  owner.setScope(cwd);
  const mutationLock = useRef(false);
  const updated = useRef(onUpdated); updated.current = onUpdated;
  const guidance = useMemo(() => guidanceDraft(guidanceRows), [guidanceRows]);
  const effectiveDraft = useMemo(() => ({ ...draft, toolGuidance: guidance.value }), [draft, guidance.value]);
  const selectedStored = snapshot.profiles.find((profile) => profile.id === selectedId) || snapshot.profiles.find((profile) => profile.id === snapshot.activeProfileId) || snapshot.profiles[0];
  const dirty = Boolean(guidance.error || selectedStored && JSON.stringify(effectiveDraft) !== JSON.stringify(selectedStored));
  const policyDirty = JSON.stringify(policyDraft) !== JSON.stringify(snapshot.runtimePolicy);
  useSettingsDraftGuard({ label: 'Harness 配置', dirty });
  useSettingsDraftGuard({ label: '全局运行策略', dirty: policyDirty });
  const activeForScope = scope === 'global' ? snapshot.globalProfileId : snapshot.workspaceProfileId || snapshot.globalProfileId;
  const applied = activeForScope === selectedId;
  const blocked = loading || readyScope !== cwd || Boolean(loadError) || saving || policySaving;
  const toolSuggestions = useMemo(() => enabledTools.filter((name) => name !== '*').sort((a, b) => a.localeCompare(b)), [enabledTools]);

  function installProfile(profile: HarnessProfile) { setSelectedId(profile.id); setDraft(cloneProfile(profile)); setGuidanceRows(rowsFor(profile)); }
  function acceptSnapshot(next: HarnessSettingsSnapshot, profileId: string, updateProfile: boolean, updatePolicy: boolean) {
    setSnapshot(next);
    if (updateProfile) {
      const profile = next.profiles.find((item) => item.id === profileId) || next.activeProfile;
      installProfile(profile);
    }
    if (updatePolicy) setPolicyDraft(cloneRuntimePolicy(next.runtimePolicy));
    updated.current?.(next);
  }
  async function reload(preserveDrafts: boolean) {
    if (mutationLock.current) return;
    const ticket = owner.begin();
    setLoading(true); setLoadError(null); setError(null); setMessage(null);
    try {
      await harnessWrites.wait();
      if (!owner.current(ticket)) return;
      const next = await window.piApi.harnessSettings(cwd);
      if (!owner.current(ticket)) return;
      acceptSnapshot(next, preserveDrafts ? selectedId : next.activeProfile.id, !preserveDrafts, !preserveDrafts);
      setReadyScope(cwd);
    } catch (cause) { if (owner.current(ticket)) setLoadError(errorText(cause)); }
    finally { if (owner.current(ticket)) setLoading(false); }
  }
  useEffect(() => {
    owner.activate(); mutationLock.current = false;
    setScope(cwd ? 'workspace' : 'global'); setSaving(false); setPolicySaving(false);
    setNewProfileOpen(false); setProfileMenu(null); setReadyScope(null);
    void reload(false);
    return () => owner.dispose();
  }, [cwd]);

  async function mutate(kind: 'profile' | 'policy', operation: () => Promise<HarnessSettingsSnapshot>, profileId: string, updateProfile: boolean, success: string) {
    if (blocked || mutationLock.current) return false;
    mutationLock.current = true;
    const ticket = owner.begin();
    if (kind === 'policy') setPolicySaving(true); else setSaving(true);
    setError(null); setMessage(null);
    try {
      const next = await harnessWrites.run(operation);
      if (!owner.current(ticket)) return false;
      acceptSnapshot(next, profileId, updateProfile, kind === 'policy');
      const refreshFailure = runtimeRefreshFailure(next.runtimeRefresh);
      if (refreshFailure) setError(refreshFailure); else setMessage(success);
      return true;
    } catch (cause) {
      if (owner.current(ticket)) {
        if (cause instanceof HarnessReloadError) setLoadError(cause.message);
        else setError(errorText(cause));
      }
      return false;
    } finally {
      if (owner.current(ticket)) { mutationLock.current = false; setSaving(false); setPolicySaving(false); }
    }
  }
  async function selectProfile(profile: HarnessProfile): Promise<boolean> {
    if (blocked) return false;
    if (profile.id === selectedId) return true;
    const ticket = owner.begin();
    if (dirty) {
      const accepted = await actionConfirmation.confirm({ title: '丢弃未保存的 Harness 更改？', description: '切换配置会使用已保存版本重新填充编辑器，未保存的提示词、工具说明和附加指令将丢失。全局运行策略草稿会保留。', confirmLabel: '丢弃并切换', tone: 'danger' });
      if (!accepted || !owner.current(ticket)) return false;
    }
    installProfile(profile); setError(null); setMessage(null); return true;
  }
  function handleProfileTabKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    if (event.nativeEvent.isComposing || blocked) return;
    const size = snapshot.profiles.length;
    const next = ['ArrowRight', 'ArrowDown'].includes(event.key) ? (index + 1) % size : ['ArrowLeft', 'ArrowUp'].includes(event.key) ? (index - 1 + size) % size : event.key === 'Home' ? 0 : event.key === 'End' ? size - 1 : -1;
    if (next < 0) return;
    event.preventDefault(); const profile = snapshot.profiles[next];
    void selectProfile(profile).then((changed) => { if (changed) requestAnimationFrame(() => document.getElementById(`harness-profile-tab-${profile.id}`)?.focus()); });
  }
  function updateSection(id: HarnessSectionId, enabled: boolean) { setDraft((current) => ({ ...current, sections: { ...current.sections, [id]: enabled } })); }
  function updateSectionOverride(id: HarnessSectionId, value: string) {
    setDraft((current) => { const sectionOverrides = { ...current.sectionOverrides }; if (value) sectionOverrides[id] = value; else delete sectionOverrides[id]; return { ...current, sectionOverrides }; });
  }
  function addGuidance() {
    let index = 1; let name = 'new-tool';
    while (guidanceRows.some((row) => row.name === name)) name = `new-tool-${++index}`;
    setGuidanceRows((current) => [...current, { key: ++guidanceId.current, name, guidance: '' }]);
  }
  async function saveProfile() {
    if (!dirty || guidance.error || !draft.name.trim()) return;
    await mutate('profile', () => window.piApi.saveHarnessProfile({ cwd, profile: effectiveDraft }), draft.id, true, '配置已保存。');
  }
  async function applyProfile() {
    if (dirty || applied) return;
    await mutate('profile', async () => {
      const next = await window.piApi.selectHarnessProfile({ cwd, id: selectedId, scope });
      if (scope !== 'global' || !cwd) return next;
      try { return { ...await window.piApi.harnessSettings(cwd), runtimeRefresh: next.runtimeRefresh }; }
      catch (cause) { throw new HarnessReloadError(`全局默认已保存，但当前工作区配置刷新失败：${errorText(cause)}`); }
    }, selectedId, false, scope === 'global' ? '已设为全局默认；已有工作区覆盖保持不变。' : '已应用到当前工作区；下一条请求生效。');
  }
  async function savePolicy() {
    if (!policyDirty) return;
    await mutate('policy', () => window.piApi.saveRuntimePolicy({ cwd, policy: policyDraft }), selectedId, false, '全局运行策略已保存；运行时将在安全边界读取新设置。');
  }
  async function resetProfile() {
    if (!selectedStored || blocked) return;
    const ticket = owner.begin();
    const accepted = await actionConfirmation.confirm({ title: '恢复 Studio 编码基线？', description: `“${selectedStored.name}”的提示词开关、覆盖内容、工具说明和附加指令会被基线替换，并保存到此配置。`, confirmLabel: '恢复基线' });
    if (accepted && owner.current(ticket)) await mutate('profile', () => window.piApi.resetHarnessProfile({ cwd, id: selectedId }), selectedId, true, '已恢复并保存基线配置。');
  }
  async function deleteProfile() {
    if (!selectedStored || selectedStored.builtin || blocked) return;
    const ticket = owner.begin();
    const accepted = await actionConfirmation.confirm({ title: '删除 Harness 配置？', description: `“${selectedStored.name}”会被删除；引用它的工作区将恢复继承全局默认。`, confirmLabel: '删除配置', tone: 'danger' });
    if (accepted && owner.current(ticket)) await mutate('profile', () => window.piApi.deleteHarnessProfile({ cwd, id: selectedId }), '', true, '配置已删除。');
  }
  async function createProfile() {
    const id = slugify(newProfile.id || newProfile.name);
    if (!/^[a-z0-9][a-z0-9._-]{1,63}$/.test(id) || ['constructor', 'prototype'].includes(id)) { setError('Harness ID 需要 2–64 个小写字母、数字、点、横线或下划线。'); return; }
    if (snapshot.profiles.some((profile) => profile.id === id)) { setError('这个配置 ID 已存在，请使用其他 ID。'); return; }
    if (!newProfile.name.trim()) { setError('请填写 Harness 名称。'); return; }
    if (guidance.error) { setError(guidance.error); return; }
    const saved = await mutate('profile', () => window.piApi.saveHarnessProfile({ cwd, profile: { ...effectiveDraft, id, name: newProfile.name.trim(), builtin: false } }), id, true, '新配置已创建，尚未更改应用范围。');
    if (saved) { setNewProfileOpen(false); setNewProfile({ name: '', id: '' }); }
  }

  return <div className="settings-sections harness-settings">
    <SettingsPageHeader
      icon={<Code2 />}
      title="Harness 配置"
    />
    <section className="harness-overview">
      <div className="harness-profile-switcher">
        <div className="harness-profile-tabs-head">
          <div>
            <h2>配置方案</h2>
          </div>
          <button type="button" className="settings-add-button" disabled={blocked} onClick={() => setNewProfileOpen(true)}>
            新建配置
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
              disabled={blocked}
              title={[profile.id, usageLabel].filter(Boolean).join(" · ")}
              aria-selected={profile.id === selectedId}
              aria-controls="harness-profile-panel"
              tabIndex={profile.id === selectedId ? 0 : -1}
              className={`harness-profile-tab ${profile.id === selectedId ? 'is-active' : ''}`}
              onClick={() => void selectProfile(profile)}
              onKeyDown={(event) => handleProfileTabKeyDown(event, index)}
            >
              <span className="harness-profile-tab-copy">
                <strong>{profile.name}</strong>
              </span>

            </button>;
          })}
        </div>
      </div>
      <details className="harness-global-instructions">
        <summary>
          <span className={`harness-global-instructions-status ${snapshot.globalInstructionsStatus === 'present'
            ? 'is-ready'
            : snapshot.globalInstructionsStatus === 'unreadable'
              ? 'is-pending'
              : ''}`}
          >
            <span>全局指令</span>
            <strong>
              {snapshot.globalInstructionsStatus === 'present'
                ? '已配置'
                : snapshot.globalInstructionsStatus === 'unreadable'
                  ? '无法读取'
                  : '未配置'}
            </strong>
          </span>
          <span className="harness-global-instructions-action">查看路径<ChevronRight /></span>
        </summary>
        <div className="harness-global-instructions-path">
          <span>文件</span>
          <code>{snapshot.globalInstructionsPath}</code>
        </div>
      </details>
    </section>

    {loadError && <div className="harness-load-error"><p role="alert">{loadError}</p><button type="button" className="settings-text-button" disabled={loading} onClick={() => void reload(readyScope === cwd)}>重新加载 Harness 配置</button></div>}
    {!newProfileOpen && (error || message) && <p className={`harness-notice ${error ? 'is-error' : ''}`} role={error ? 'alert' : 'status'}>{error || message}</p>}
    {loading && <p className="harness-loading" role="status"><LoaderCircle className="spin" />正在刷新 Harness 配置…</p>}

    <fieldset
      disabled={blocked}
      className="harness-editor"
      id="harness-profile-panel"
      role="tabpanel"
      aria-labelledby={`harness-profile-tab-${selectedId}`}
    >
      <section className="harness-block">
        <div className="harness-editor-head">
          <div className="harness-editor-identity">
            <span className={`harness-editor-status ${dirty ? 'is-dirty' : ''}`}>{dirty ? '未保存修改' : '已保存'}</span>
            <input
              aria-label="Harness 名称"
              value={draft.name}
              onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))}
            />
          </div>
          <div className="harness-editor-actions">
            <button
              type="button"
              className="icon-button harness-profile-more"
              aria-label="更多配置操作"
              title="更多配置操作"
              disabled={saving}
              onClick={(event) => {
                const rect = event.currentTarget.getBoundingClientRect();
                setProfileMenu({ x: rect.right - 224, y: rect.bottom + 4 });
              }}
            >
              <MoreHorizontal />
            </button>
            <button type="button" className="settings-outline" disabled={!dirty || saving} onClick={() => selectedStored && installProfile(selectedStored)}>撤销</button>
            <div className="harness-editor-action-group is-primary">
              <button type="button" className="settings-save" disabled={!dirty || saving || Boolean(guidance.error) || !draft.name.trim()} onClick={() => void saveProfile()}>
                {saving ? <LoaderCircle className="spin" /> : <Save />}保存配置
              </button>
            </div>
          </div>
        </div>
        <div className="harness-editor-context">
          <div className="harness-editor-context-copy">
            <strong>应用范围</strong>
            <p>
              {scope === 'global'
                ? '设为全局默认；已有工作区覆盖保持不变。'
                : '只影响当前工作区，并优先于全局默认。'}
            </p>
          </div>
          <div className="harness-editor-context-actions">
            <div className="settings-scope-tabs" role="tablist" aria-label="Harness 应用范围">
              <button type="button" role="tab" aria-selected={scope === 'workspace'} className={scope === 'workspace' ? 'is-active' : ''} disabled={!cwd} onClick={() => setScope('workspace')}>当前工作区</button>
              <button type="button" role="tab" aria-selected={scope === 'global'} className={scope === 'global' ? 'is-active' : ''} onClick={() => setScope('global')}>全局默认</button>
            </div>
            <button
              type="button"
              className={`settings-outline harness-apply-button ${applied ? 'is-applied' : ''}`}
              disabled={saving || applied || dirty}
              title={dirty ? '请先保存配置' : undefined}
              onClick={() => void applyProfile()}
            >
              {saving ? <LoaderCircle className="spin" /> : <Check />}
              {applied ? '已应用' : scope === 'global' ? '设为全局默认' : '应用到工作区'}
            </button>
          </div>
        </div>

          <div className="harness-section-heading">
            <div><h3>提示词组成 <InfoHint label="所选指令从下一次请求开始生效。" /></h3></div>
          </div>
          <div className="harness-section-grid">
            {snapshot.sections.map((section) => {
              const enabled = draft.sections[section.id] !== false;
              return <button
                type="button"
                key={section.id}
                className={`harness-section-card ${enabled ? 'is-enabled' : ''}`}
                role="switch"
                aria-checked={enabled}
                aria-label={`${section.label}：${section.description}`}
                title={section.description}
                onClick={() => updateSection(section.id, !enabled)}
              >
                <span>
                  <strong>{section.label}</strong>
                </span>
                <span className={`switch ${enabled ? 'is-on' : ''}`} aria-hidden="true"><span /></span>
              </button>;
            })}
          </div>
          <div className="harness-section-overrides">
            <div className="harness-section-overrides-head">
              <div><h3>精细覆盖 <InfoHint label="留空时使用 Studio 基线；填写内容后会替换对应部分。动态工具、项目指令和技能内容也可以固定。" /></h3></div>
            </div>
            {snapshot.sections.map((section) => {
              const enabled = draft.sections[section.id] !== false;
              const value = draft.sectionOverrides[section.id] || '';
              const state = !enabled ? '已关闭' : value.trim() ? '已覆盖' : '';
              return <details className={`harness-section-override ${!enabled ? 'is-disabled' : ''}`} key={section.id}>
                <summary>
                  <span className="harness-section-override-main">
                    <span className="harness-section-override-copy">
                      <strong>{section.label}</strong>
                      {state && <small className={!enabled ? 'is-off' : 'is-overridden'}>{state}</small>}
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

        <section className="harness-block">
          <div className="harness-block-head">
            <div><h2>工具策略 <InfoHint label="自定义说明优先于内置策略，并且只应用于当前开放的 Tool。" /></h2></div>
            <button type="button" className="settings-outline" onClick={addGuidance}><Plus />添加工具说明</button>
          </div>
          <div className="harness-tool-guidance-list">
            {guidanceRows.map((row) => (
              <div className="harness-tool-guidance-row" key={row.key} data-guidance-key={row.key}>
                <label>
                  <span>工具</span>
                  <input
                    list="harness-tool-suggestions"
                    value={row.name}
                    onChange={(event) => setGuidanceRows((current) => current.map((item) => item.key === row.key ? { ...item, name: event.target.value } : item))}
                    placeholder="edit"
                  />
                </label>
                <label>
                  <span>补充说明</span>
                  <textarea
                    rows={2}
                    value={row.guidance}
                    onChange={(event) => setGuidanceRows((current) => current.map((item) => item.key === row.key ? { ...item, guidance: event.target.value } : item))}
                    placeholder="例如：修改后优先运行该模块最相关的测试。"
                  />
                </label>
                <button type="button" className="icon-button" aria-label={`删除 ${row.name || "未命名工具"} 的工具说明`} title="删除" onClick={() => setGuidanceRows((current) => current.filter((item) => item.key !== row.key))}>
                  <Trash2 />
                </button>
              </div>
            ))}
            <datalist id="harness-tool-suggestions">
              {toolSuggestions.map((name) => <option value={name} key={name} />)}
            </datalist>
            {guidanceRows.length === 0 && <p className="harness-guidance-empty">沿用内置工具策略</p>}
            {guidance.error && <p className="harness-guidance-error" role="alert">{guidance.error}</p>}
          </div>
        </section>

        <section className="harness-block">
          <div className="harness-block-head">
            <div><h2>附加指令 <InfoHint label="追加在项目指令和其他提示词组成之后。" /></h2></div>
            <span className="harness-char-count">{draft.customInstructions.length.toLocaleString()} / 65,536</span>
          </div>
          <textarea
            className="harness-instructions"
            aria-label="Harness 附加指令"
            rows={7}
            maxLength={65_536}
            value={draft.customInstructions}
            onChange={(event) => setDraft((current) => ({ ...current, customInstructions: event.target.value }))}
          />
        </section>

    </fieldset>

    <fieldset className="harness-policy-editor" disabled={blocked}>
        <section className="harness-block harness-policy-block">
          <div className="harness-block-head harness-policy-head">
            <div>
              <h2>全局运行策略 <InfoHint label="控制重试、上下文压缩、工具调度和故障恢复；正在执行的任务阶段不会被打断。" /></h2>
              <p className="harness-scope-description">独立保存，不随上方配置方案切换。</p>
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

          <div className="harness-policy-grid">
            <section className="harness-policy-group">
              <header><span className="harness-policy-heading"><strong>请求与重试</strong><InfoHint label="失败请求会按指数退避重试；首次等待是最初间隔，超时限制单次请求。" /></span></header>
              <div className="harness-policy-row">
                <span><strong>自动重试</strong></span>
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
              <header><span className="harness-policy-heading"><strong>工具调度与恢复</strong></span></header>
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
                  <span>崩溃重启上限 <InfoHint label="连续中断达到上限后暂停任务，避免崩溃循环。" /></span>
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
                </label>
              </div>
            </section>

            <section className="harness-policy-group is-wide">
              <header><span className="harness-policy-heading"><strong>上下文压缩</strong><InfoHint label="触发阈值按模型上下文窗口计算；保留最近决定摘要后原样保留的 tokens。窗口未知时使用回答预留，后台提前量可先启动压缩。关闭后仍可在输入区手动压缩。" /></span></header>
              <div className="harness-policy-row">
                <span><strong>自动压缩</strong></span>
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
              <div className="harness-policy-fields">
                <label>
                  <span>触发阈值</span>
                  <input
                    type="number"
                    min={0}
                    max={95}
                    step={5}
                    aria-label="自动压缩触发阈值（百分比）"
                    value={policyDraft.compaction.autoCompactPercent}
                    disabled={!policyDraft.compaction.enabled}
                    onChange={(event) => setPolicyDraft((current) => ({
                      ...current,
                      compaction: {
                        ...current.compaction,
                        autoCompactPercent: Number(event.target.value),
                      },
                    }))}
                  />
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
                </label>
              </div>
              {/* 比例阈值按每个模型自己的窗口换算；这里保留 token 字段作为回退。 */}
              <details className="harness-policy-details">
                <summary>按 token 细调</summary>
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
                  </label>
                </div>
              </details>
            </section>

            <section className="harness-policy-group is-wide">
              <header><span className="harness-policy-heading"><strong>长期目标安全阀</strong><InfoHint label="达到轮次上限后暂停并等待确认；连续无进展达到上限时也会停下。" /></span></header>
              <div className="harness-policy-fields">
                <label>
                  <span>单次运行轮次上限</span>
                  <input
                    type="number"
                    min={1}
                    max={500}
                    value={policyDraft.longTask.maxContinuations}
                    onChange={(event) => setPolicyDraft((current) => ({
                      ...current,
                      longTask: {
                        ...current.longTask,
                        maxContinuations: Number(event.target.value),
                      },
                    }))}
                  />
                </label>
                <label>
                  <span>连续无进展上限</span>
                  <input
                    type="number"
                    min={1}
                    max={50}
                    value={policyDraft.longTask.maxStalledContinuations}
                    onChange={(event) => setPolicyDraft((current) => ({
                      ...current,
                      longTask: {
                        ...current.longTask,
                        maxStalledContinuations: Number(event.target.value),
                      },
                    }))}
                  />
                </label>
              </div>
            </section>

            <section className="harness-policy-group is-wide">
              <header><span className="harness-policy-heading"><strong>内存缓存</strong></span></header>
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

    </fieldset>

    {profileMenu && <ActionMenu
      {...profileMenu}
      onClose={() => setProfileMenu(null)}
      items={[
        ...(!selectedStored?.builtin
          ? [{ label: '删除配置', run: () => void deleteProfile(), disabled: saving }]
          : []),
        { label: '恢复 Studio 编码基线', run: () => void resetProfile(), disabled: saving },
      ]}
    />}

    {newProfileOpen && <SettingsDialog
      title="新建 Harness 配置"
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
        <div className="settings-field">
          <span className="settings-field-heading"><label htmlFor="new-harness-profile-id">配置 ID</label><InfoHint label="用于 SQLite 和工作区绑定，创建后不能修改。" /></span>
          <input id="new-harness-profile-id" required value={newProfile.id} onChange={(event) => setNewProfile((current) => ({ ...current, id: slugify(event.target.value) }))} placeholder="review-first" />
        </div>
      </div>
    </SettingsDialog>}
    {actionConfirmation.dialog}
  </div>;
}
