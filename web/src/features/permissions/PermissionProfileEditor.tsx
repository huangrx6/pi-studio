import { useId, useState } from 'react';
import { Check, ChevronUp, Copy, RotateCcw } from 'lucide-react';
import { ActionMenu } from '../../shared/ActionMenu';
import { useActionConfirmation } from '../../shared/ConfirmDialog';
import { InfoHint } from '../../shared/InfoHint';
import { SettingsDialog } from '../../shared/SettingsDialog';
import { useSettingsDraftGuard } from '../../shared/SettingsDraftGuard';
import { useSettingsToast } from '../../shared/SettingsToast';
import type { ModalDismiss } from '../../shared/useModalDialog';
import type {
  PermissionPolicyState,
  PermissionProfile,
  PermissionProfilePatch,
  PermissionProfilesSnapshot,
} from '../../types/permission-types';
import { permissionDraftError } from './permission-policy-editor';
import { PermissionPolicyFormFields } from './PermissionPolicyFormFields';

export type PermissionProfileBindingScope = 'workspace' | 'global' | 'inherit' | 'temporary';

function cloneProfile(profile: PermissionProfile): PermissionProfile {
  return JSON.parse(JSON.stringify(profile)) as PermissionProfile;
}

export function PermissionProfileEditor({
  creating,
  source,
  snapshot,
  catalog,
  cwd,
  busy,
  onSave,
  onApply,
  onReset,
  onDelete,
  onCopy,
  onClose,
}: {
  creating: boolean;
  source: PermissionProfile;
  snapshot: PermissionProfilesSnapshot;
  catalog?: PermissionPolicyState['catalog'];
  cwd: string;
  busy: boolean;
  onSave: (payload: { mode: 'create' | 'edit'; profile: PermissionProfilePatch }, dismiss: ModalDismiss) => Promise<void>;
  onApply: (id: string, scope: PermissionProfileBindingScope) => Promise<void>;
  onReset: (id: string, dismiss: ModalDismiss) => Promise<void>;
  onDelete: (id: string, dismiss: ModalDismiss) => Promise<void>;
  onCopy: (profile: PermissionProfile) => void;
  onClose: () => void;
}) {
  const showToast = useSettingsToast();
  const confirmation = useActionConfirmation();
  const [initial] = useState<PermissionProfile>(() =>
    creating
      ? { ...cloneProfile(source), id: '', name: '', builtin: false }
      : cloneProfile(source));
  const [draft, setDraft] = useState<PermissionProfile>(() => cloneProfile(initial));
  const [manualId, setManualId] = useState<string | null>(null);
  const [fallbackId] = useState(() => creating ? 'perm-' + crypto.randomUUID().slice(0, 8) : '');
  const [scope, setScope] = useState<'workspace' | 'global' | 'temporary'>(cwd ? 'workspace' : 'global');
  const [menuAnchor, setMenuAnchor] = useState<HTMLButtonElement | null>(null);
  const menuId = useId();

  const nameSlug = draft.name.trim().toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[^a-z0-9]+|[-]+$/g, '')
    .slice(0, 64);
  const suggestedId = nameSlug.length >= 2 ? nameSlug : draft.name.trim() ? fallbackId : '';
  const id = creating ? (manualId ?? suggestedId).trim() : initial.id;

  const identityChanged = draft.name !== initial.name || draft.description !== initial.description;
  const iconChanged = draft.icon?.shape !== initial.icon?.shape || draft.icon?.ink !== initial.icon?.ink;
  const policyChanged = JSON.stringify(draft.policy) !== JSON.stringify(initial.policy);
  const dirty = identityChanged || iconChanged || policyChanged
    || (creating && manualId !== null && manualId !== suggestedId);
  useSettingsDraftGuard({ label: '权限方案', dirty, saving: busy });

  let idIssue: string | null = null;
  if (creating && (draft.name.trim() || manualId !== null)) {
    if (!/^[a-z0-9][a-z0-9._-]{1,63}$/.test(id) || ['__proto__', 'constructor', 'prototype'].includes(id)) {
      idIssue = '请输入有效的方案 ID（2-64 位小写字母、数字、点、横线或下划线）。';
    } else if (snapshot.profiles.some(item => item.id === id)) {
      idIssue = '这个方案 ID 已存在，请更换其他 ID。';
    }
  }
  const canSave = (creating || dirty) && Boolean(id && draft.name.trim()) && !idIssue;

  const scopeId = scope === 'global'
    ? snapshot.mainProfileId
    : scope === 'temporary'
      ? snapshot.temporaryProfileId
      : snapshot.workspaceProfileId;
  const applied = scopeId === initial.id;
  const boundId = scopeId || snapshot.mainProfileId;
  const boundName = snapshot.profiles.find(item => item.id === boundId)?.name || boundId;

  function handleSave(dismiss: ModalDismiss) {
    if (!canSave) return;
    const ruleError = (creating || policyChanged) && permissionDraftError(draft.policy);
    if (ruleError) {
      showToast(ruleError, 'error');
      return;
    }
    void onSave({
      mode: creating ? 'create' : 'edit',
      profile: {
        id,
        ...((creating || identityChanged) && { name: draft.name.trim(), description: draft.description.trim() }),
        ...((creating || iconChanged) && { icon: draft.icon ?? null }),
        ...((creating || policyChanged) && { policy: draft.policy }),
      },
    }, dismiss);
  }

  async function handleReset(dismiss: ModalDismiss) {
    if (await confirmation.confirm({
      title: '恢复内置权限方案默认值？',
      description: `「${initial.name}」的预设模式、工具覆盖和高级规则将恢复为系统默认。`,
      confirmLabel: '恢复默认',
    })) {
      await onReset(initial.id, dismiss);
    }
  }

  async function handleDelete(dismiss: ModalDismiss) {
    if (!initial.builtin && await confirmation.confirm({
      title: '删除权限方案？',
      description: `删除「${initial.name}」后，引用它的主对话工作区、临时对话或子智能体会自动回退。`,
      confirmLabel: '删除方案',
      tone: 'danger',
    })) {
      await onDelete(initial.id, dismiss);
    }
  }

  return <>
    <SettingsDialog
      wide
      className="permission-profile-dialog"
      title={creating ? '新建权限方案' : `编辑权限方案 · ${initial.name}`}
      action={creating ? '创建方案' : '保存方案'}
      busy={busy}
      loading={false}
      unavailable={!canSave}
      error={idIssue}
      onClose={onClose}
      onSubmit={handleSave}
      onRequestClose={async dismiss => {
        if (!dirty || await confirmation.confirm({
          title: '放弃未保存的权限方案更改？',
          confirmLabel: '放弃更改',
          tone: 'danger',
        })) {
          await dismiss(onClose);
        }
      }}
      footerHint={!creating && (dismiss => <>
        <button
          type="button"
          className="settings-outline harness-actions-trigger"
          aria-label="更多方案操作"
          aria-haspopup="menu"
          aria-expanded={Boolean(menuAnchor)}
          aria-controls={menuAnchor ? menuId : undefined}
          disabled={busy}
          onClick={event => setMenuAnchor(menuAnchor ? null : event.currentTarget)}
        >
          更多操作<ChevronUp aria-hidden="true" />
        </button>
        {menuAnchor && <ActionMenu
          id={menuId}
          anchor={menuAnchor}
          placement="above"
          className="harness-actions-menu"
          onClose={() => setMenuAnchor(null)}
          items={[
            { label: '复制为新方案', icon: Copy, disabled: dirty, run: () => onCopy(initial) },
            ...(initial.builtin ? [{ label: '恢复系统默认', icon: RotateCcw, run: () => void handleReset(dismiss) }] : []),
            ...(!initial.builtin ? [{ label: '删除方案', destructive: true, run: () => void handleDelete(dismiss) }] : []),
          ]}
        />}
      </>)}
    >
      <div className="settings-form-sections permission-profile-editor">
        <section className="settings-form-section">
          <h3>基本信息与绑定</h3>
          <div className="profile-identity-grid">
            <label className="profile-identity-field">
              <span>方案名称</span>
              <input
                required
                maxLength={80}
                value={draft.name}
                placeholder="例如，只读审阅策略 / 临时沙箱确认"
                onChange={event => setDraft(current => ({ ...current, name: event.target.value }))}
              />
            </label>
            <div className="profile-identity-field profile-identity-id">
              <span className="settings-field-heading">
                {creating ? <label htmlFor="permission-profile-id">方案 ID</label> : <span>方案 ID</span>}
                {creating && <InfoHint label="2 至 64 个小写字母、数字、点、横线或下划线，创建后不可更改。" />}
              </span>
              {creating ? <input
                id="permission-profile-id"
                maxLength={64}
                required
                value={manualId ?? suggestedId}
                aria-invalid={Boolean(idIssue)}
                placeholder="strict-review"
                onChange={event => setManualId(event.target.value)}
              /> : <code className="harness-stored-id">{id}</code>}
            </div>
            <label className="profile-identity-field profile-identity-desc">
              <span>说明</span>
              <input
                maxLength={240}
                value={draft.description}
                placeholder="简要说明这套权限规则适用的对话场景"
                onChange={event => setDraft(current => ({ ...current, description: event.target.value }))}
              />
            </label>
          </div>

          {!creating && <div className="harness-setting-row harness-editor-context">
            <div>
              <span>应用范围</span>
              <p>当前：{boundName}{scope === 'workspace' && !scopeId ? '（继承全局）' : ''}</p>
            </div>
            <div className="harness-binding-controls">
              <div className="settings-segments" role="group" aria-label="权限方案应用范围">
                {(['workspace', 'global', 'temporary'] as const).map(item => (
                  <button
                    key={item}
                    type="button"
                    aria-pressed={scope === item}
                    disabled={item === 'workspace' && !cwd}
                    onClick={() => setScope(item)}
                  >
                    {item === 'workspace' ? '当前工作区' : item === 'global' ? '主对话默认' : '临时对话'}
                  </button>
                ))}
              </div>
              <button
                type="button"
                className="settings-outline"
                disabled={dirty || applied || busy}
                title={dirty ? '请先保存方案修改' : undefined}
                onClick={() => void onApply(id, scope)}
              >
                {applied && <Check aria-hidden="true" />}
                {applied ? '已应用' : scope === 'global' ? '设为主对话默认' : scope === 'temporary' ? '设为临时对话' : '应用到工作区'}
              </button>
              {scope === 'workspace' && applied && (
                <button
                  type="button"
                  className="settings-text-button"
                  disabled={dirty || busy}
                  onClick={() => void onApply(id, 'inherit')}
                >
                  恢复继承
                </button>
              )}
            </div>
          </div>}
        </section>

        <PermissionPolicyFormFields
          policy={draft.policy}
          catalog={catalog}
          busy={busy}
          dirty={dirty}
          variant="embedded"
          previewLabel={draft.name.trim() || id}
          onChange={policy => setDraft(current => ({ ...current, policy }))}
          onEvaluate={(policy, call) => window.piApi.permissionEvaluateProfile({ cwd, policy, call })}
        />
      </div>
    </SettingsDialog>
    {confirmation.dialog}
  </>;
}
