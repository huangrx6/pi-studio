import { useCallback, useEffect, useRef, useState } from 'react';
import { Plus } from 'lucide-react';
import { Accordion } from '../../shared/Accordion';
import { useActionConfirmation } from '../../shared/ConfirmDialog';
import { errorText } from '../../shared/error-text';
import { LoadingState } from '../../shared/LoadingState';
import { useDeferredEnter } from '../../shared/useDeferredEnter';
import { useSettingsDraftGuard } from '../../shared/SettingsDraftGuard';
import { SettingsPageHeader } from '../../shared/SettingsPageHeader';
import { automaticProfileIcon } from '../../shared/profile-icon';
import { SettingsProfileLibrary } from '../../shared/SettingsProfileLibrary';
import { useSettingsToast } from '../../shared/SettingsToast';
import type { ModalDismiss } from '../../shared/useModalDialog';
import type {
  PermissionMode,
  PermissionPolicy,
  PermissionPolicyState,
  PermissionProfile,
  PermissionProfilePatch,
  PermissionProfilesSnapshot,
  PermissionScope,
} from '../../types/permission-types';
import { permissionDraftError, permissionScopeKey, permissionWrites } from './permission-policy-editor';
import { PERMISSION_DECISION_LABELS, PermissionPolicyFormFields } from './PermissionPolicyFormFields';
import { PermissionPresetGlyph } from './PermissionPresetGlyph';
import { PermissionProfileEditor, type PermissionProfileBindingScope } from './PermissionProfileEditor';
import './styles/permission-policy.css';

type PermissionPolicySettingsProps = {
  cwd?: string;
  sessionId?: string;
  className?: string;
  initialProfiles?: PermissionProfilesSnapshot;
  onPolicyChanged?: (state: PermissionPolicyState) => void;
  onProfilesUpdated?: (snapshot: PermissionProfilesSnapshot) => void;
};

type EditorState = {
  kind: 'create' | 'edit';
  source: PermissionProfile;
};

const SCOPE_LABELS: Record<PermissionScope, string> = {
  user: '全局',
  workspace: '当前工作区',
  session: '当前会话',
};

const PRESET_LABEL: Record<PermissionMode, string> = {
  ask: '严格确认',
  smart: '帮我批准',
  full: '完全权限',
};

function clonePolicy(policy: PermissionPolicy): PermissionPolicy {
  return JSON.parse(JSON.stringify(policy)) as PermissionPolicy;
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
  return <PermissionPolicyWorkspace key={JSON.stringify([props.cwd || '', props.sessionId || ''])} {...props} />;
}

function PermissionPolicyWorkspace({
  cwd = '',
  sessionId = '',
  className = '',
  initialProfiles,
  onPolicyChanged,
  onProfilesUpdated,
}: PermissionPolicySettingsProps) {
  const showToast = useSettingsToast();
  const actionConfirmation = useActionConfirmation();
  const [profilesSnapshot, setProfilesSnapshot] = useState<PermissionProfilesSnapshot | undefined>(initialProfiles);
  const [policyState, setPolicyState] = useState<PermissionPolicyState | null>(null);
  const [loading, setLoading] = useState(!initialProfiles);
  const [loadError, setLoadError] = useState('');
  const [busy, setBusy] = useState(false);
  const [editor, setEditor] = useState<EditorState | null>(null);

  const [overrideScope, setOverrideScope] = useState<PermissionScope>(sessionId ? 'session' : cwd ? 'workspace' : 'user');
  const [overrideDraft, setOverrideDraft] = useState<PermissionPolicy | null>(null);
  const [overrideEdited, setOverrideEdited] = useState(false);
  const [overrideOp, setOverrideOp] = useState<'' | 'save' | 'reset'>('');

  const generation = useRef(0);
  const updatedProfilesRef = useRef(onProfilesUpdated);
  updatedProfilesRef.current = onProfilesUpdated;
  const policyChangedRef = useRef(onPolicyChanged);
  policyChangedRef.current = onPolicyChanged;

  useEffect(() => {
    if (initialProfiles) setProfilesSnapshot(initialProfiles);
  }, [initialProfiles]);

  const adoptPolicyState = useCallback((next: PermissionPolicyState, preferredScope = overrideScope) => {
    setPolicyState(next);
    const chosen = scopeAvailable(preferredScope, next.cwd, next.sessionId)
      ? preferredScope
      : next.sessionId
        ? 'session'
        : next.cwd
          ? 'workspace'
          : 'user';
    setOverrideScope(chosen);
    setOverrideDraft(clonePolicy(policyForScope(next, chosen)));
    setOverrideEdited(false);
  }, [overrideScope]);

  const loadAll = useCallback(async () => {
    const ticket = ++generation.current;
    setLoading(true);
    setLoadError('');
    try {
      await permissionWrites.waitForContext(cwd, sessionId);
      const [profilesNext, policyNext] = await Promise.all([
        window.piApi.permissionProfiles(cwd),
        window.piApi.permissionPolicyGet({ cwd, sessionId }),
      ]);
      if (generation.current !== ticket) return;
      setProfilesSnapshot(profilesNext);
      updatedProfilesRef.current?.(profilesNext);
      adoptPolicyState(policyNext, sessionId ? 'session' : cwd ? 'workspace' : 'user');
    } catch (reason) {
      if (generation.current === ticket) setLoadError(errorText(reason));
    } finally {
      if (generation.current === ticket) setLoading(false);
    }
  }, [cwd, sessionId, adoptPolicyState]);

  useEffect(() => {
    void loadAll();
    return () => { generation.current += 1; };
  }, [loadAll]);

  const savedOverridePolicy = policyState?.scopes[overrideScope];
  const overrideDirty = overrideEdited && (!savedOverridePolicy || JSON.stringify(overrideDraft) !== JSON.stringify(savedOverridePolicy));
  useSettingsDraftGuard({ label: '工作区/会话权限覆盖', dirty: overrideDirty, saving: Boolean(overrideOp) });

  function acceptProfiles(next: PermissionProfilesSnapshot) {
    setProfilesSnapshot(next);
    updatedProfilesRef.current?.(next);
  }

  async function refreshLivePolicy() {
    try {
      const nextPolicy = await window.piApi.permissionPolicyGet({ cwd, sessionId });
      adoptPolicyState(nextPolicy, overrideScope);
      policyChangedRef.current?.(nextPolicy);
    } catch {
      // Live override refresh stays best-effort alongside profile operations.
    }
  }

  async function handleSaveProfile(
    payload: { mode: 'create' | 'edit'; profile: PermissionProfilePatch },
    dismiss: ModalDismiss,
  ) {
    setBusy(true);
    try {
      const next = await window.piApi.savePermissionProfile({ cwd, ...payload });
      acceptProfiles(next);
      await dismiss(() => setEditor(null));
      if (payload.profile.policy) await refreshLivePolicy();
      showToast(payload.mode === 'create' ? '权限方案已创建。' : '权限方案已保存。');
    } catch (reason) {
      showToast(errorText(reason), 'error');
    } finally {
      setBusy(false);
    }
  }

  async function handleApplyProfile(id: string, scope: PermissionProfileBindingScope) {
    setBusy(true);
    try {
      const next = await window.piApi.selectPermissionProfile({ cwd, id, scope });
      acceptProfiles(next);
      await refreshLivePolicy();
      showToast(
        scope === 'global'
          ? '已设为主对话全局默认权限方案。'
          : scope === 'inherit'
            ? '当前工作区已恢复继承全局主对话方案。'
            : scope === 'temporary'
              ? '已设为临时对话默认权限方案。'
              : '已应用到当前工作区。',
      );
    } catch (reason) {
      showToast(errorText(reason), 'error');
    } finally {
      setBusy(false);
    }
  }

  async function handleResetProfile(id: string, dismiss: ModalDismiss) {
    setBusy(true);
    try {
      const next = await window.piApi.resetPermissionProfile({ cwd, id });
      acceptProfiles(next);
      await dismiss(() => setEditor(null));
      await refreshLivePolicy();
      showToast('已恢复权限方案默认值。');
    } catch (reason) {
      showToast(errorText(reason), 'error');
    } finally {
      setBusy(false);
    }
  }

  async function handleDeleteProfile(id: string, dismiss: ModalDismiss) {
    setBusy(true);
    try {
      const next = await window.piApi.deletePermissionProfile({ cwd, id });
      acceptProfiles(next);
      await dismiss(() => setEditor(null));
      await refreshLivePolicy();
      showToast('权限方案已删除。');
    } catch (reason) {
      showToast(errorText(reason), 'error');
    } finally {
      setBusy(false);
    }
  }

  async function selectOverrideScope(nextScope: PermissionScope) {
    if (!policyState || !scopeAvailable(nextScope, policyState.cwd, policyState.sessionId) || nextScope === overrideScope) return;
    if (overrideDirty) {
      const accepted = await actionConfirmation.confirm({
        title: '丢弃未保存的覆盖更改？',
        description: '切换后会载入所选作用域当前规则。',
        confirmLabel: '丢弃并切换',
        tone: 'danger',
      });
      if (!accepted) return;
    }
    setOverrideScope(nextScope);
    setOverrideDraft(clonePolicy(policyForScope(policyState, nextScope)));
    setOverrideEdited(false);
  }

  async function saveOverride() {
    if (!overrideDraft) return;
    const err = permissionDraftError(overrideDraft);
    if (err) {
      showToast(err, 'error');
      return;
    }
    setOverrideOp('save');
    try {
      const next = await permissionWrites.run(
        permissionScopeKey(overrideScope, cwd, sessionId),
        () => window.piApi.permissionPolicySet({ scope: overrideScope, cwd, sessionId, policy: overrideDraft }),
      );
      adoptPolicyState(next, overrideScope);
      policyChangedRef.current?.(next);
      if (overrideScope === 'user') {
        const latestProfiles = await window.piApi.permissionProfiles(cwd);
        acceptProfiles(latestProfiles);
      }
      showToast('动态权限覆盖已保存，从下一次工具调用开始生效。');
    } catch (reason) {
      showToast(errorText(reason), 'error');
    } finally {
      setOverrideOp('');
    }
  }

  async function resetOverride() {
    if (!policyState) return;
    const accepted = await actionConfirmation.confirm({
      title: overrideScope === 'user' ? '恢复全局默认权限策略？' : '恢复权限继承？',
      description: overrideScope === 'user'
        ? '将全局默认策略恢复为“帮我批准”默认值？'
        : `删除${SCOPE_LABELS[overrideScope]}的覆盖并恢复继承？`,
      confirmLabel: overrideScope === 'user' ? '恢复默认' : '删除覆盖',
      tone: 'danger',
    });
    if (!accepted) return;
    setOverrideOp('reset');
    try {
      const next = await permissionWrites.run(
        permissionScopeKey(overrideScope, cwd, sessionId),
        () => window.piApi.permissionPolicyReset({ scope: overrideScope, cwd, sessionId }),
      );
      adoptPolicyState(next, overrideScope);
      policyChangedRef.current?.(next);
      if (overrideScope === 'user') {
        const latestProfiles = await window.piApi.permissionProfiles(cwd);
        acceptProfiles(latestProfiles);
      }
      showToast(overrideScope === 'user' ? '已恢复全局默认策略。' : '已恢复继承。');
    } catch (reason) {
      showToast(errorText(reason), 'error');
    } finally {
      setOverrideOp('');
    }
  }

  function createProfile() {
    if (!profilesSnapshot) return;
    const base = profilesSnapshot.profiles.find(item => item.id === profilesSnapshot.activeMainProfileId)
      ?? profilesSnapshot.profiles[0];
    if (!base) return;
    setEditor({ kind: 'create', source: { ...base, icon: null } });
  }

  const ready = Boolean(profilesSnapshot) && !loadError;
  const bodyReveal = useDeferredEnter(ready);
  const pageClass = `settings-preference-page permission-policy ${className}`.trim();

  return <div className={pageClass} aria-label="权限策略">
    <SettingsPageHeader
      title="权限策略"
      iconPosition="end"
      meta="管理权限方案与工具确认边界。"
      icon={<svg viewBox="0 0 32 32" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M16 2.5c3.3 2.3 7.4 3.8 12 4.5v8c0 6.2-4.7 11-12 14.5C8.7 26 4 21.2 4 15V7c4.6-.7 8.7-2.2 12-4.5Z" />
        <path d="m11 15.5 3.4 3.4 6.8-7.1" stroke="var(--accent)" />
      </svg>}
    />

    <SettingsProfileLibrary
      title="权限方案"
      count={ready && profilesSnapshot ? profilesSnapshot.profiles.length : 0}
      actions={
        <button
          type="button"
          className="settings-save"
          aria-haspopup="dialog"
          disabled={!ready || busy}
          onClick={createProfile}
        >
          <Plus aria-hidden="true" />新建方案
        </button>
      }
    >
      {loading && !profilesSnapshot && <div className="settings-loading-card"><LoadingState variant="section">正在读取权限方案…</LoadingState></div>}
      {loadError && <div className="settings-load-error">
        <p role="alert">{loadError}</p>
        <button type="button" className="settings-outline" onClick={() => void loadAll()}>重新加载权限策略</button>
      </div>}
      {ready && profilesSnapshot && (() => {
        const tierOrder: Record<string, number> = { 'strict-ask': 0, 'smart-default': 1, 'full-access': 2 };
        const builtins = profilesSnapshot.profiles
          .filter(p => p.builtin)
          .sort((a, b) => (tierOrder[a.id] ?? 9) - (tierOrder[b.id] ?? 9));
        const customs = profilesSnapshot.profiles.filter(p => !p.builtin);

        const renderMeta = (profile: PermissionProfile) => {
          const isMain = profile.id === profilesSnapshot.mainProfileId;
          const isWorkspace = Boolean(cwd) && profile.id === profilesSnapshot.workspaceProfileId;
          const isWorkspaceInherited = Boolean(cwd) && isMain && !profilesSnapshot.workspaceProfileId;
          const isTemporary = profile.id === profilesSnapshot.temporaryProfileId;
          const binding = [
            isMain && '主对话默认',
            isWorkspace && '当前工作区',
            isWorkspaceInherited && '工作区继承',
            isTemporary && '临时对话',
          ].filter(Boolean).join(' · ');
          const preset = profile.policy.preset;
          const overrideCount = Object.keys(profile.policy.tools || {}).length;
          const ruleCount = profile.policy.rules.length;
          const defaultDecision = PERMISSION_DECISION_LABELS[profile.policy.default];
          const extras = [
            overrideCount > 0 && `${overrideCount} 项工具例外`,
            ruleCount > 0 && `${ruleCount} 条规则`,
          ].filter(Boolean).join(' · ') || '内置规则';
          return { binding, isActive: Boolean(binding), preset, defaultDecision, extras };
        };

        return <>
          <div className={`settings-preference-card perm-console${bodyReveal ? ' settings-async-ready' : ''}`} role="list" aria-label="安全策略矩阵">
            {builtins.map((profile, idx) => {
              const { binding, isActive, preset, defaultDecision, extras } = renderMeta(profile);
              return <button
                key={profile.id}
                type="button"
                role="listitem"
                className={`perm-col${isActive ? ' is-active' : ''}`}
                aria-label={'编辑' + profile.name}
                aria-haspopup="dialog"
                onClick={() => setEditor({ kind: 'edit', source: profile })}
              >
                <div className="perm-col-top">
                  <span className="perm-col-index">0{idx + 1}</span>
                  {binding
                    ? <span className="perm-live-tag"><i aria-hidden="true" />{binding}</span>
                    : <span className="perm-idle-tag">备用</span>}
                </div>

                <div className="perm-col-emblem">
                  <span className="perm-glyph-tile"><PermissionPresetGlyph preset={preset} /></span>
                  <div className="perm-col-heading">
                    <strong>{profile.name}</strong>
                    <span>{PRESET_LABEL[preset] || preset}</span>
                  </div>
                </div>

                {profile.description && <p className="perm-col-desc">{profile.description}</p>}

                <dl className="perm-spec-list">
                  <div>
                    <dt>默认决策</dt>
                    <dd>{defaultDecision}</dd>
                  </div>
                  <div>
                    <dt>策略规则</dt>
                    <dd>{extras}</dd>
                  </div>
                </dl>
              </button>;
            })}
          </div>

          {customs.length > 0 && <div className="permission-custom-section">
            <h3 className="permission-custom-heading">自定义方案 <span>{customs.length}</span></h3>
            <div className="settings-preference-card perm-custom-deck">
              {customs.map(profile => {
                const { binding, preset, defaultDecision, extras } = renderMeta(profile);
                return <button
                  key={profile.id}
                  type="button"
                  className="perm-custom-row"
                  aria-label={'编辑' + profile.name}
                  aria-haspopup="dialog"
                  onClick={() => setEditor({ kind: 'edit', source: profile })}
                >
                  <span className="perm-glyph-tile is-compact"><PermissionPresetGlyph preset={preset} /></span>
                  <div className="perm-custom-copy">
                    <div className="perm-custom-head">
                      <strong>{profile.name}</strong>
                      {binding && <span className="perm-live-tag"><i aria-hidden="true" />{binding}</span>}
                    </div>
                    <p>{profile.description || `${PRESET_LABEL[preset] || preset} · 默认${defaultDecision}`}</p>
                  </div>
                  <div className="perm-custom-end">
                    <span>{PRESET_LABEL[preset] || preset} · {extras}</span>
                  </div>
                </button>;
              })}
            </div>
          </div>}
        </>;
      })()}
    </SettingsProfileLibrary>

    {policyState && overrideDraft && <div className="settings-preference-groups permission-live-groups">
      <Accordion
        className="settings-preference-card permission-live-overrides"
        summary="工作区与会话动态覆盖"
        badge={`${SCOPE_LABELS[policyState.effectiveScope]} · ${PRESET_LABEL[policyState.effectivePolicy.preset]}`}
      >
        <div className="permission-live-body">
          <div className="settings-segments permission-policy-scopes" role="group" aria-label="权限覆盖作用域">
            {(Object.keys(SCOPE_LABELS) as PermissionScope[]).map((item) => {
              const available = scopeAvailable(item, policyState.cwd, policyState.sessionId);
              const configured = item === 'user' || Boolean(policyState.scopes[item]);
              return <button
                key={item}
                type="button"
                aria-pressed={overrideScope === item}
                disabled={!available || Boolean(overrideOp)}
                title={!available ? item === 'workspace' ? '打开工作区后可配置' : '打开会话后可配置' : undefined}
                onClick={() => void selectOverrideScope(item)}
              >
                <span>{SCOPE_LABELS[item]}</span>
                <small>{item === 'user' ? '同步主默认' : !available ? '未打开' : configured ? '已覆盖' : '继承'}</small>
              </button>;
            })}
          </div>

          <PermissionPolicyFormFields
            policy={overrideDraft}
            catalog={policyState.catalog}
            busy={Boolean(overrideOp)}
            dirty={overrideDirty}
            variant="embedded"
            previewLabel={SCOPE_LABELS[overrideScope]}
            onChange={(next) => { setOverrideDraft(next); setOverrideEdited(true); }}
            onEvaluate={(policy, call) => window.piApi.permissionEvaluate({
              cwd,
              sessionId,
              scope: overrideScope,
              policy,
              call,
            })}
          />

          <footer className={`permission-policy-actions permission-live-footer${overrideDirty ? ' is-dirty' : ''}`}>
            <div className="permission-save-state">
              <strong>{SCOPE_LABELS[overrideScope]}覆盖</strong>
              <span>{overrideDirty ? '有未保存的更改' : savedOverridePolicy ? '与已保存策略一致' : '正在继承上一级策略'}</span>
            </div>
            <div className="permission-save-buttons">
              {(overrideScope === 'user' || policyState.scopes[overrideScope]) && (
                <button type="button" className="settings-outline" disabled={Boolean(overrideOp)} onClick={() => void resetOverride()}>
                  {overrideOp === 'reset' ? '恢复中…' : overrideScope === 'user' ? '恢复默认' : '恢复继承'}
                </button>
              )}
              <button type="button" className="settings-save" disabled={!overrideDirty || Boolean(overrideOp)} onClick={() => void saveOverride()}>
                {overrideOp === 'save' ? '保存中…' : '保存覆盖'}
              </button>
            </div>
          </footer>
        </div>
      </Accordion>
    </div>}

    {editor && profilesSnapshot && <PermissionProfileEditor
      key={`${editor.kind}:${editor.source.id}`}
      creating={editor.kind === 'create'}
      source={editor.source}
      snapshot={profilesSnapshot}
      catalog={policyState?.catalog}
      cwd={cwd}
      busy={busy}
      onSave={handleSaveProfile}
      onApply={handleApplyProfile}
      onReset={handleResetProfile}
      onDelete={handleDeleteProfile}
      onCopy={source => setEditor({ kind: 'create',
        source: { ...source, icon: source.icon ?? automaticProfileIcon('permissions', source.id) } })}
      onClose={() => setEditor(null)}
    />}
    {actionConfirmation.dialog}
  </div>;
}
