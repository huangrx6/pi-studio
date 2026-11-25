import { useId, useMemo, useState } from 'react';
import { Check, ChevronDown, ChevronUp, Copy, RotateCcw } from 'lucide-react';
import { Accordion } from '../../shared/Accordion';
import { ActionMenu } from '../../shared/ActionMenu';
import { useActionConfirmation } from '../../shared/ConfirmDialog';
import { InfoHint } from '../../shared/InfoHint';
import { SettingsDialog } from '../../shared/SettingsDialog';
import { useSettingsDraftGuard } from '../../shared/SettingsDraftGuard';
import type { ModalDismiss } from '../../shared/useModalDialog';
import type { HarnessProfile, HarnessSectionId, HarnessSettingsSnapshot } from '../../types/harness-types';
import { cloneHarnessProfile, guidanceDraft, type CommitHarnessChange, type GuidanceRow } from './harness-state';
import { HarnessIconPicker } from './HarnessIconPicker';
import { automaticHarnessIcon, HarnessProfileMark } from './HarnessProfileMark';
import { HarnessPromptSections } from './HarnessPromptSections';
import { HarnessToolGuidance } from './HarnessToolGuidance';

export type HarnessScope = 'workspace' | 'global' | 'inherit';

export function HarnessProfileEditor({ source, creating, snapshot, cwd, enabledTools, busy, commit, onApply, onCopy, onClose }: {
  source: HarnessProfile; creating: boolean; snapshot: HarnessSettingsSnapshot; cwd: string;
  enabledTools: string[]; busy: boolean; commit: CommitHarnessChange;
  onApply: (id: string, scope: HarnessScope) => void; onCopy: (source: HarnessProfile) => void; onClose: () => void;
}) {
  const confirmation = useActionConfirmation();
  const [initial] = useState(() => creating ? { ...source, id: '', name: '', builtin: false } : source);
  const [draft, setDraft] = useState(() => cloneHarnessProfile(initial));
  const [guidanceRows, setGuidanceRows] = useState<GuidanceRow[]>(() =>
    Object.entries(initial.toolGuidance).map(([name, guidance], key) => ({ key, name, guidance })));
  const [manualId, setManualId] = useState<string | null>(null);
  const [fallbackId] = useState(() => creating ? 'profile-' + crypto.randomUUID().slice(0, 8) : '');
  const [scope, setScope] = useState<'workspace' | 'global'>(cwd ? 'workspace' : 'global');
  const [menuAnchor, setMenuAnchor] = useState<HTMLButtonElement | null>(null);
  const [iconsOpen, setIconsOpen] = useState(false);
  const iconPickerId = useId();
  const menuId = useId();
  const nameSlug = draft.name.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^[^a-z0-9]+|[-]+$/g, '').slice(0, 64);
  const suggestedId = nameSlug.length >= 2 ? nameSlug : draft.name.trim() ? fallbackId : '';
  const id = creating ? (manualId ?? suggestedId).trim() : initial.id;
  const icon = draft.icon ?? automaticHarnessIcon(id || fallbackId, draft.builtin);
  const guidance = useMemo(() => guidanceDraft(guidanceRows), [guidanceRows]);
  const incompleteGuidance = Boolean(guidance.error) || guidanceRows.some(row => !row.guidance.trim());
  const profile = { ...draft, toolGuidance: guidance.value };
  const dirty = Boolean(incompleteGuidance || (creating && manualId !== null && manualId !== suggestedId)
    || JSON.stringify(profile) !== JSON.stringify(initial));
  useSettingsDraftGuard({ label: 'Harness 配置', dirty });
  let idIssue: string | null = null;
  if (creating && (draft.name.trim() || manualId !== null)) {
    if (!/^[a-z0-9][a-z0-9._-]{1,63}$/.test(id) || ['constructor', 'prototype'].includes(id)) idIssue = '请输入有效的配置 ID，例如 review-first。';
    else if (snapshot.profiles.some(item => item.id === id)) idIssue = '这个配置 ID 已存在，请使用其他 ID。';
  }
  const canSave = dirty && Boolean(id && draft.name.trim()) && !incompleteGuidance && !idIssue;
  const addendumInactive = draft.sections.addendum === false || Boolean(draft.sectionOverrides.addendum?.trim());
  const instructionStatus = { present: '已配置', unreadable: '无法读取', missing: '未配置' }[snapshot.globalInstructionsStatus];
  const scopeId = scope === 'global' ? snapshot.globalProfileId : snapshot.workspaceProfileId;
  const applied = scopeId === initial.id;
  const boundId = scopeId || snapshot.globalProfileId;
  const boundName = snapshot.profiles.find(item => item.id === boundId)?.name || boundId;
  const scopeHelp = scope === 'global' ? `未指定方案的工作区使用「${boundName}」。`
    : scopeId ? `当前工作区使用「${boundName}」。` : `当前工作区继承全局方案「${boundName}」。`;

  function updateSection(section: HarnessSectionId, enabled: boolean) {
    setDraft(current => ({ ...current, sections: { ...current.sections, [section]: enabled } }));
  }
  function updateSectionOverride(section: HarnessSectionId, value: string) {
    setDraft(current => {
      const sectionOverrides = { ...current.sectionOverrides };
      if (value) sectionOverrides[section] = value;
      else delete sectionOverrides[section];
      return { ...current, sectionOverrides };
    });
  }
  function save(dismiss: ModalDismiss) {
    if (!canSave) return;
    void commit(() => window.piApi.saveHarnessProfile({ cwd, mode: creating ? 'create' : 'edit',
      profile: { ...profile, id, name: draft.name.trim() } }), creating ? '新配置已创建。' : '配置已保存。', () => dismiss(onClose));
  }
  async function reset(dismiss: ModalDismiss) {
    if (await confirmation.confirm({ title: '恢复 Studio 编码基线？', description: `「${initial.name}」的提示词、工具说明和附加指令将替换为基线内容并保存。`, confirmLabel: '恢复基线' })) {
      await commit(() => window.piApi.resetHarnessProfile({ cwd, id }), '已恢复并保存基线配置。', () => dismiss(onClose));
    }
  }
  async function remove(dismiss: ModalDismiss) {
    if (!initial.builtin && await confirmation.confirm({ title: '删除 Harness 配置？', description: `引用「${initial.name}」的工作区将恢复继承全局默认。`, confirmLabel: '删除配置', tone: 'danger' })) {
      await commit(() => window.piApi.deleteHarnessProfile({ cwd, id }), '配置已删除。', () => dismiss(onClose));
    }
  }

  return <><SettingsDialog wide className="harness-profile-dialog" title={creating ? '新建 Harness 配置' : '编辑 Harness 配置'}
    description={creating && source.name ? `以「${source.name}」为起点，保存后可按工作区或全局应用。` : undefined}
    action={creating ? '创建配置' : '保存配置'} busy={busy} loading={false} unavailable={!canSave}
    error={idIssue || guidance.error} onClose={onClose} onSubmit={save}
    onRequestClose={async dismiss => {
      if (!dirty || await confirmation.confirm({ title: '放弃未保存的 Harness 更改？', confirmLabel: '放弃更改', tone: 'danger' })) await dismiss(onClose);
    }}
    footerHint={!creating && (dismiss => <>
      <button type="button" className="settings-outline harness-actions-trigger" aria-label="更多配置操作" aria-haspopup="menu"
        aria-expanded={Boolean(menuAnchor)} aria-controls={menuAnchor ? menuId : undefined} disabled={busy}
        onClick={event => setMenuAnchor(menuAnchor ? null : event.currentTarget)}>
        更多操作<ChevronUp aria-hidden="true" />
      </button>
      {menuAnchor && <ActionMenu id={menuId} anchor={menuAnchor} placement="above" className="harness-actions-menu"
        onClose={() => setMenuAnchor(null)} items={[
        { label: '复制为新配置', icon: Copy, disabled: dirty, run: () => onCopy(initial) },
        { label: '恢复 Studio 编码基线', icon: RotateCcw, run: () => void reset(dismiss) },
        ...(!initial.builtin ? [{ label: '删除配置', destructive: true, run: () => void remove(dismiss) }] : []),
      ]} />}
    </>)}>
    <div className="settings-form-sections harness-editor">
      <section className="settings-form-section">
        <h3>基本信息</h3>
        <div className="harness-identity-fields">
          <div className="harness-field harness-icon-field"><span>方案图标</span>
            <button type="button" className="harness-icon-trigger settings-row-link" aria-expanded={iconsOpen}
              aria-label="更换方案图标" aria-controls={iconsOpen ? iconPickerId : undefined} onClick={() => setIconsOpen(!iconsOpen)}>
              <HarnessProfileMark icon={icon} /><span>更换</span><ChevronDown className="settings-row-link-indicator" aria-hidden="true" />
            </button>
          </div>
          {iconsOpen && <HarnessIconPicker id={iconPickerId} icon={icon} automatic={!draft.icon}
            onChange={icon => setDraft(current => ({ ...current, icon }))} />}
          <label className="harness-field"><span>方案名称</span><input required maxLength={80}
            value={draft.name} placeholder="例如，代码审查" onChange={event => setDraft(current => ({ ...current, name: event.target.value }))} /></label>
          <div className="harness-field"><span className="settings-field-heading">{creating ? <label htmlFor="harness-profile-id">配置 ID</label> : <span>配置 ID</span>}
            {creating && <InfoHint label="使用 2 至 64 个小写字母、数字、点、横线或下划线，以字母或数字开头。创建后固定。" />}</span>
            {creating ? <input id="harness-profile-id" maxLength={64} required value={manualId ?? suggestedId} aria-invalid={Boolean(idIssue)}
              onChange={event => setManualId(event.target.value)} placeholder="review-first" />
              : <code className="harness-stored-id">{id}</code>}</div>
        </div>
        {!creating && <div className="harness-setting-row harness-editor-context">
          <div><span>应用范围</span><p>{scopeHelp}</p></div>
          <div className="harness-binding-controls"><div className="settings-segments" role="group" aria-label="Harness 应用范围">
            {(['workspace', 'global'] as const).map(item => <button key={item} type="button" aria-pressed={scope === item}
              disabled={item === 'workspace' && !cwd} onClick={() => setScope(item)}>{item === 'workspace' ? '当前工作区' : '全局默认'}</button>)}
          </div>
          <button type="button" className="settings-outline" disabled={dirty || applied}
            title={dirty ? '请先保存配置' : undefined} onClick={() => onApply(id, scope)}>
            {applied && <Check aria-hidden="true" />}{applied ? '已应用' : scope === 'global' ? '设为全局默认' : '应用到工作区'}
          </button>
          {scope === 'workspace' && applied && <button className="settings-text-button" type="button" disabled={dirty}
            onClick={() => onApply(id, 'inherit')}>恢复继承</button>}</div>
        </div>}
      </section>
      <section className="settings-form-section"><h3>提示词与指令</h3>
        <HarnessPromptSections definitions={snapshot.sections} draft={draft}
          onToggle={updateSection} onOverride={updateSectionOverride} />
        <HarnessToolGuidance rows={guidanceRows} enabledTools={enabledTools} onChange={setGuidanceRows} />
        <Accordion className="harness-disclosure harness-extra-instructions" summary="附加指令"
          badge={draft.customInstructions.length ? draft.customInstructions.length.toLocaleString() + ' 字符' : '未填写'}>
          <div className="harness-disclosure-body">
            {addendumInactive && <p>要使用这里的指令，请启用「自定义补充」段落并清空该段的覆盖内容。</p>}
            <textarea aria-label="Harness 附加指令" placeholder="在系统提示词末尾追加的指令" rows={4}
              maxLength={65_536} value={draft.customInstructions}
              onChange={event => setDraft(current => ({ ...current, customInstructions: event.target.value }))} />
            <span className="harness-count">{draft.customInstructions.length.toLocaleString()} / 65,536</span>
          </div>
        </Accordion>
        <Accordion className="harness-disclosure harness-global-instructions" summary="全局指令文件" badge={instructionStatus}>
          <div className="harness-disclosure-body">
            <p>「项目指令」段落默认从此文件读取全局指令。</p>
            <code>{snapshot.globalInstructionsPath}</code>
          </div>
        </Accordion>
      </section>
    </div>
  </SettingsDialog>{confirmation.dialog}</>;
}
