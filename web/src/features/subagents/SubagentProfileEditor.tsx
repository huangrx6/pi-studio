import { useEffect, useId, useRef, useState } from 'react';
import { Check, ChevronDown, Trash2 } from 'lucide-react';
import avatars from '../../../../assets/settings/subagent-avatars.json' with { type: 'json' };
import { SettingsDialog } from '../../shared/SettingsDialog';
import { isComposingKey } from '../../shared/keyboard-navigation';
import { Select, type SelectOption } from '../../shared/Select';
import { useActionConfirmation } from '../../shared/ConfirmDialog';
import { useSettingsDraftGuard } from '../../shared/SettingsDraftGuard';
import { useSettingsToast } from '../../shared/SettingsToast';
import { errorText } from '../../shared/error-text';
import type { ModalDismiss } from '../../shared/useModalDialog';
import type { SubagentProfile, SubagentProfileResources, SubagentRuntimeOverrides } from '../../types/subagent-types';
import { roleThinkingError, RoleRuntimeFields, RoleThinkingField, RoleToolAccess, usesFileTools } from './RoleRuntimeFields';
import { SubagentAvatar } from './SubagentAvatar';
import { replaceSubagentProfiles, refreshSubagentProfiles } from './useSubagentProfiles';

type Option = { id: string; name: string };
type SelectionMode = 'inherit' | 'picked' | 'none';
function selectionMode(value: string[] | null): SelectionMode {
  return value === null ? 'inherit' : value.length ? 'picked' : 'none';
}

function profileSignature(role: SubagentProfile) {
  const overrides = Object.entries(role.runtimeOverrides).sort(([a], [b]) => a.localeCompare(b));
  return JSON.stringify({
    ...role,
    toolProfileId: role.toolProfileId || '',
    permissionProfileId: role.permissionProfileId || '',
    runtimeOverrides: overrides,
  });
}

const avatarGroups = [
  { id: 'girls', label: '女生' }, { id: 'boys', label: '男生' }, { id: 'animals', label: '动物' },
] as const;

function RoleIdentity({ value, name, onChange, onNameChange }: {
  value: string; name: string; onChange: (id: string) => void; onNameChange: (name: string) => void;
}) {
  const selected = avatarGroups.find(group => Object.hasOwn(avatars[group.id], value)) || avatarGroups[0];
  const [open, setOpen] = useState(false);
  const [group, setGroup] = useState<keyof typeof avatars>(selected.id);
  const trigger = useRef<HTMLButtonElement>(null);
  const picker = useRef<HTMLDivElement>(null);
  const pickerId = useId();
  const labels: Record<string, string> = avatars[selected.id];
  useEffect(() => {
    if (open) picker.current?.querySelector<HTMLButtonElement>('.role-avatar-categories [aria-pressed=true]')?.focus({ preventScroll: true });
  }, [open]);
  function closePicker() {
    setOpen(false);
    trigger.current?.focus({ preventScroll: true });
  }
  return <div className="role-identity" onKeyDown={event => {
    if (open && event.key === 'Escape' && !isComposingKey(event.nativeEvent)) {
      event.preventDefault();
      event.stopPropagation();
      closePicker();
    }
  }}>
    <label className="role-field">角色名称<input required maxLength={48} value={name} placeholder="例如，代码审阅"
      onChange={event => onNameChange(event.target.value)} /></label>
    <div className="role-avatar-field">
      <span className="role-field-label">头像</span>
      <button ref={trigger} type="button" className="role-avatar-trigger" aria-expanded={open} aria-describedby={`${pickerId}-current`}
        aria-controls={open ? pickerId : undefined} title={labels[value]} onClick={() => {
          if (!open) setGroup(selected.id);
          setOpen(!open);
        }}>
        <SubagentAvatar id={value} /><span>更换头像</span><ChevronDown aria-hidden="true" />
      </button>
      <span id={`${pickerId}-current`} className="sr-only">当前头像：{labels[value] || '默认头像'}</span>
    </div>
    {open && <div className="role-avatar-picker" id={pickerId} ref={picker}>
      <div className="settings-segments role-avatar-categories" role="group" aria-label="头像分类">{avatarGroups.map(item =>
        <button type="button" key={item.id} aria-pressed={group === item.id} onClick={() => setGroup(item.id)}>{item.label}</button>)}</div>
      <div className="role-avatar-grid" role="group" aria-label="内置头像">{Object.entries(avatars[group]).map(([id, label]) =>
        <button type="button" key={id} aria-label={label} title={label} aria-pressed={value === id} onClick={() => {
          onChange(id);
          closePicker();
        }}><SubagentAvatar id={id} />{value === id && <Check aria-hidden="true" />}</button>)}</div>
    </div>}
  </div>;
}
function selectOptions(options: Option[], current: string, inheritedLabel: string): SelectOption[] {
  return [
    { value: '', label: inheritedLabel },
    ...(current && !options.some(row => row.id === current)
      ? [{ value: current, label: current + '（当前不可用）', disabled: true }] : []),
    ...options.map(row => ({ value: row.id, label: row.name })),
  ];
}

function ResourceField({ title, description, mode, value, options, onMode, onChange, disabled = false }: {
  title: string; description?: string; mode: SelectionMode; value: string[] | null; options: Option[];
  onMode: (mode: SelectionMode) => void; onChange: (values: string[]) => void; disabled?: boolean;
}) {
  const [search, setSearch] = useState('');
  const selected = value ?? [];
  const available = new Set(options.map(row => row.id));
  const rows = [...selected.filter(id => !available.has(id)).map(id => ({
    id, name: (id.split('#')[0] || id) + '（当前不可用）',
  })), ...options];
  const filtered = rows.filter(row => row.name.toLowerCase().includes(search.trim().toLowerCase()));
  return <section className="role-editor-block">
    <div className="role-editor-row"><h3>{title}</h3>
      <Select label={title + '范围'} value={disabled ? 'restricted' : mode} disabled={disabled} onChange={next => onMode(next as SelectionMode)}
        options={disabled ? [{ value: 'restricted', label: '限于文件工具' }] : [{ value: 'inherit', label: '继承' }, { value: 'picked', label: '仅使用所选' }, { value: 'none', label: '不使用' }]} />
    </div>
    {description && <p>{description}</p>}
    {!disabled && mode === 'picked' && <div className="role-resource-choices">
      {rows.length > 8 && <input aria-label={'搜索' + title} type="search" placeholder={'搜索' + title} value={search} onChange={event => setSearch(event.target.value)} />}
      <div className="role-resource-list">
        {filtered.map(row => <label key={row.id}><input type="checkbox" checked={selected.includes(row.id)}
          onChange={event => onChange(event.target.checked ? [...selected, row.id] : selected.filter(id => id !== row.id))} />
          <span>{row.name}</span></label>)}
        {!filtered.length && <p>{search ? '没有匹配项' : '当前工作区没有可选资源'}</p>}
      </div>
    </div>}
  </section>;
}

export function SubagentProfileEditor({ initial, cwd, onClose }: { initial: SubagentProfile; cwd: string; onClose: () => void }) {
  const showToast = useSettingsToast();
  const [draft, setDraft] = useState(initial);
  const [mcpMode, setMcpMode] = useState(() => selectionMode(initial.mcpServers));
  const [skillMode, setSkillMode] = useState(() => selectionMode(initial.skills));
  const [resources, setResources] = useState<SubagentProfileResources | null>(null);
  const [loadError, setLoadError] = useState('');
  const [retry, setRetry] = useState(0);
  const [busy, setBusy] = useState(false);
  const modelFields = useRef<HTMLElement>(null);
  const confirmation = useActionConfirmation('subagent-confirm');
  const fileOnly = usesFileTools(draft.runtimeOverrides.allowedTools);
  const profile = {
    ...draft,
    mcpServers: mcpMode === 'inherit' ? null : mcpMode === 'none' ? [] : draft.mcpServers,
    skills: skillMode === 'inherit' ? null : skillMode === 'none' ? [] : draft.skills,
  };
  const supportedThinking = resources?.models.find(model => model.id === (draft.model || resources.defaults.defaultModel))?.thinkingLevels;
  const defaultModel = resources?.models.find(model => model.id === resources.defaults.defaultModel)?.name || resources?.defaults.defaultModel;
  const dirty = profileSignature(profile) !== profileSignature(initial)
    || mcpMode !== selectionMode(initial.mcpServers) || skillMode !== selectionMode(initial.skills);
  useSettingsDraftGuard({ label: '子智能体角色', dirty });
  useEffect(() => {
    let current = true;
    setLoadError('');
    setResources(null);
    window.piApi.subagentProfileResources(cwd).then(result => { if (current) setResources(result); })
      .catch(cause => { if (current) setLoadError(errorText(cause)); });
    return () => { current = false; };
  }, [cwd, retry]);

  function update<K extends keyof SubagentProfile>(field: K, value: SubagentProfile[K]) {
    setDraft(previous => ({ ...previous, [field]: value }));
  }

  function changeOverride<K extends keyof SubagentRuntimeOverrides>(key: K, value: SubagentRuntimeOverrides[K]) {
    setDraft(previous => {
      const runtimeOverrides = { ...previous.runtimeOverrides };
      if (value === undefined) delete runtimeOverrides[key];
      else runtimeOverrides[key] = value;
      return { ...previous, runtimeOverrides };
    });
    if (key === 'allowedTools' && (value === 'read-only' || value === 'read-write') && mcpMode === 'picked' && !draft.mcpServers?.length) {
      setMcpMode(selectionMode(draft.mcpServers));
    }
  }

  async function persist(dismiss: ModalDismiss, remove = false) {
    if (busy) return;
    if (remove) {
      if (!await confirmation.confirm({ title: '删除这个子智能体？', description: '对话中的运行记录会保留。草稿里引用此角色的位置需要重新选择。', confirmLabel: '删除角色', tone: 'danger' })) return;
    } else {
      if (!(draft.name.trim() && draft.description.trim())) { showToast('请填写角色名称和职责描述。', 'error'); return; }
      if (roleThinkingError(draft.runtimeOverrides, supportedThinking)) {
        modelFields.current?.querySelector<HTMLButtonElement>('.role-thinking-field .pi-select-trigger')?.focus();
        return;
      }
      if ((mcpMode === 'picked' && !draft.mcpServers?.length) || (skillMode === 'picked' && !draft.skills?.length)) {
        showToast('请勾选至少一个资源，或将范围设为“不使用”。', 'error'); return;
      }
    }
    setBusy(true);
    try {
      const rows = remove ? await window.piApi.removeSubagentProfile({ id: initial.id, revision: initial.revision })
        : await window.piApi.saveSubagentProfile(profile);
      replaceSubagentProfiles(rows);
      await dismiss(onClose);
      showToast(remove ? '子智能体已删除' : '子智能体已保存');
    } catch (cause) {
      showToast(errorText(cause), 'error');
      setBusy(false);
      void refreshSubagentProfiles();
    }
  }

  return <><SettingsDialog wide className="subagent-form-dialog" title={initial.id ? '编辑子智能体' : '新建子智能体'} action="保存" busy={busy}
    loading={!resources && !loadError} unavailable={!resources} error={loadError || null}
    onClose={onClose} onSubmit={dismiss => void persist(dismiss)}
    onRequestClose={async dismiss => {
      if (!dirty || await confirmation.confirm({ title: '放弃未保存的角色更改？', description: '这次编辑还没有保存。', confirmLabel: '放弃更改', tone: 'danger' })) void dismiss(onClose);
    }}
    footerHint={initial.id && (dismiss => <button type="button" className="role-delete" disabled={busy} onClick={() => void persist(dismiss, true)}><Trash2 />删除角色</button>)}>
    {loadError && <button type="button" className="settings-outline" onClick={() => setRetry(value => value + 1)}>重新读取资源</button>}
    {resources && <div className="subagent-form role-editor">
      <section className="role-identity-section" aria-label="身份与职责">
        <RoleIdentity value={draft.avatarId} name={draft.name} onChange={id => update('avatarId', id)}
          onNameChange={name => update('name', name)} />
        <label className="role-field">何时使用<input required maxLength={180} value={draft.description} placeholder="描述适合交给这个角色的任务"
          onChange={event => update('description', event.target.value)} /></label>
        <label className="role-field">角色指令<textarea rows={3} maxLength={16000} value={draft.instructions} placeholder="说明工作方式和期望的输出"
          onChange={event => update('instructions', event.target.value)} /></label>
      </section>
      <section ref={modelFields} className="role-model-fields" aria-label="模型与思考强度">
        <div className="role-field"><span>模型</span><Select label="角色模型" value={draft.model}
          options={selectOptions([{ id: 'parent', name: '跟随父智能体' }, ...resources.models], draft.model,
            defaultModel ? '跟随运行默认值 · ' + defaultModel : '跟随运行默认值')} onChange={value => update('model', value)} /></div>
        <RoleThinkingField overrides={draft.runtimeOverrides} defaults={resources.defaults} supportedThinking={supportedThinking} onChange={changeOverride} />
      </section>
      <section className="role-resources" aria-label="权限与资源">
        <RoleToolAccess access={draft.runtimeOverrides.allowedTools} common={resources.defaults.allowedTools} tools={resources.tools}
          onChange={value => changeOverride('allowedTools', value)} />
        <ResourceField title="MCP 服务" disabled={fileOnly} description={fileOnly ? '文件工具模式下暂停 MCP。' : undefined}
          mode={mcpMode} value={draft.mcpServers} options={resources.mcpServers.map(name => ({ id: name, name }))}
          onMode={setMcpMode} onChange={value => update('mcpServers', value)} />
        <ResourceField title="技能"
          mode={skillMode} value={draft.skills} options={resources.skills} onMode={setSkillMode} onChange={value => update('skills', value)} />
      </section>
      <RoleRuntimeFields overrides={draft.runtimeOverrides} defaults={resources.defaults} onChange={changeOverride}
        harnessCustomized={Boolean(draft.harnessId)}>
        <div className="role-editor-row role-runtime-wide-field"><span>Harness 配置</span><Select label="角色 Harness 配置" value={draft.harnessId}
          options={selectOptions(resources.harnesses, draft.harnessId, '跟随当前工作区')} onChange={value => update('harnessId', value)} /></div>
        {resources.toolProfiles && <div className="role-editor-row role-runtime-wide-field"><span>工具方案</span><Select label="角色工具方案" value={draft.toolProfileId || ''}
          options={selectOptions(resources.toolProfiles, draft.toolProfileId || '', '跟随父智能体')} onChange={value => update('toolProfileId', value || undefined)} /></div>}
        {resources.permissionProfiles && <div className="role-editor-row role-runtime-wide-field"><span>权限方案</span><Select label="角色权限方案" value={draft.permissionProfileId || ''}
          options={selectOptions(resources.permissionProfiles, draft.permissionProfileId || '', '跟随当前工作区')} onChange={value => update('permissionProfileId', value || undefined)} /></div>}
      </RoleRuntimeFields>
    </div>}
  </SettingsDialog>{confirmation.dialog}</>;
}
