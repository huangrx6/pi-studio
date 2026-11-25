import { useEffect, useId, useState } from 'react';
import { ChevronRight, Code2, RotateCcw, ShieldCheck, Wrench } from 'lucide-react';
import { errorText } from '../../shared/error-text';
import { LoadingState } from '../../shared/LoadingState';
import { runtimeRefreshFailure } from '../../shared/runtime-refresh';
import { Select, type SelectOption } from '../../shared/Select';
import { SettingsPageHeader } from '../../shared/SettingsPageHeader';
import { automaticProfileIcon, SettingsProfileMark } from '../../shared/SettingsProfileIcon';
import { SettingsTabs } from '../../shared/SettingsTabs';
import { useSettingsToast } from '../../shared/SettingsToast';
import type { AgentConfigSection, SettingsTab } from '../../shell/app-shell-config';
import type { PiWorkspace } from '../../shell/app-types';
import type { TemporaryCapabilitiesSnapshot, ToolProfilesSnapshot } from '../../types/agent-tool-types';
import type { HarnessSettingsSnapshot } from '../../types/harness-types';
import type { ModelOption } from '../../types/model-types';
import type { PermissionProfilesSnapshot } from '../../types/permission-types';
import type { ProfileIcon, ProfileIconGroup } from '../../types/profile-icon';
import { SubagentSettings } from '../subagents/SubagentSettings';
import './styles/agents-settings.css';

const AGENT_SECTIONS: ReadonlyArray<{ value: AgentConfigSection; label: string }> = [
  { value: 'main', label: '主对话' },
  { value: 'temporary', label: '临时对话' },
  { value: 'subagents', label: '子智能体' },
];

const EXTENSION_MODE_LABEL: Record<string, string> = {
  'all-enabled': '全部已启用扩展',
  'safe-only': '仅安全扩展',
  none: '禁用扩展',
};

const MCP_MODE_LABEL: Record<string, string> = {
  'follow-server': '跟随全局 MCP',
  picked: '指定 MCP 服务器',
  none: '禁用 MCP',
};

const PRESET_LABEL: Record<string, string> = {
  ask: '严格确认',
  smart: '帮我批准',
  full: '完全权限',
};

function profileOptions(group: ProfileIconGroup, profiles: ReadonlyArray<{ id: string; name: string; icon?: ProfileIcon | null }> = []): SelectOption[] {
  return profiles.map(profile => ({
    value: profile.id,
    label: profile.name,
    icon: <SettingsProfileMark group={group} icon={profile.icon ?? automaticProfileIcon(group, profile.id)} />,
  }));
}

export function AgentsSettings({
  section,
  onSectionChange,
  cwd,
  workspaces,
  models,
  toolProfiles,
  permissionProfiles,
  harness,
  temporaryCapabilities: initialTemporaryCaps,
  onToolProfilesChange,
  onPermissionProfilesChange,
  onHarnessChange,
  onOpenTab,
  onWorktreesRevealed,
}: {
  section: AgentConfigSection;
  onSectionChange: (section: AgentConfigSection) => void;
  cwd: string;
  workspaces: PiWorkspace[];
  models?: Pick<ModelOption, 'id' | 'name'>[];
  toolProfiles?: ToolProfilesSnapshot;
  permissionProfiles?: PermissionProfilesSnapshot;
  harness?: HarnessSettingsSnapshot;
  temporaryCapabilities?: TemporaryCapabilitiesSnapshot;
  onToolProfilesChange: (toolProfiles: ToolProfilesSnapshot, tempCaps?: TemporaryCapabilitiesSnapshot) => void;
  onPermissionProfilesChange: (permissionProfiles: PermissionProfilesSnapshot) => void;
  onHarnessChange: (harness: HarnessSettingsSnapshot) => void;
  onOpenTab: (tab: SettingsTab) => void;
  onWorktreesRevealed?: () => void;
}) {
  const showToast = useSettingsToast();
  const tabsId = useId();
  const [mainScope, setMainScope] = useState<'workspace' | 'global'>(cwd ? 'workspace' : 'global');
  const [busyKey, setBusyKey] = useState('');
  const [tempCaps, setTempCaps] = useState<TemporaryCapabilitiesSnapshot | undefined>(initialTemporaryCaps);

  useEffect(() => {
    setTempCaps(initialTemporaryCaps);
  }, [initialTemporaryCaps]);

  useEffect(() => {
    if (!cwd && mainScope === 'workspace') setMainScope('global');
  }, [cwd, mainScope]);

  useEffect(() => {
    if (section !== 'temporary') return;
    let active = true;
    void window.piApi.temporaryCapabilities()
      .then(result => { if (active) setTempCaps(result); })
      .catch(() => {});
    return () => { active = false; };
  }, [section, toolProfiles?.temporaryProfileId]);

  const activeMainToolProfile = toolProfiles?.profiles.find(item => item.id === toolProfiles.activeMainProfileId);
  const workspaceName = workspaces.find(item => item.cwd === cwd)?.name || cwd;

  async function selectToolBinding(id: string, scope: 'global' | 'workspace' | 'inherit' | 'temporary') {
    setBusyKey(`tools:${scope}`);
    try {
      const result = await window.piApi.selectToolProfile({ cwd, id, scope });
      setTempCaps(result.temporaryCapabilities);
      onToolProfilesChange(result.toolProfiles, result.temporaryCapabilities);
      const warning = runtimeRefreshFailure(result.runtimeRefresh);
      showToast(
        (scope === 'temporary'
          ? '已更新临时对话工具方案。'
          : scope === 'inherit'
            ? '当前工作区已恢复继承主对话工具方案。'
            : '工具方案绑定已更新。') + (warning || ''),
        warning ? 'error' : 'success',
      );
    } catch (cause) {
      showToast(errorText(cause), 'error');
    } finally {
      setBusyKey('');
    }
  }

  async function selectPermissionBinding(id: string, scope: 'global' | 'workspace' | 'inherit' | 'temporary') {
    setBusyKey(`permissions:${scope}`);
    try {
      const next = await window.piApi.selectPermissionProfile({ cwd, id, scope });
      onPermissionProfilesChange(next);
      showToast(
        scope === 'temporary'
          ? '已更新临时对话权限方案。'
          : scope === 'inherit'
            ? '当前工作区已恢复继承主对话权限方案。'
            : '权限方案绑定已更新。',
      );
    } catch (cause) {
      showToast(errorText(cause), 'error');
    } finally {
      setBusyKey('');
    }
  }

  async function selectHarnessBinding(id: string, scope: 'global' | 'workspace' | 'inherit' | 'temporary') {
    setBusyKey(`harness:${scope}`);
    try {
      const next = await window.piApi.selectHarnessProfile({ cwd, id, scope });
      onHarnessChange(next);
      const warning = runtimeRefreshFailure(next.runtimeRefresh);
      showToast(
        (scope === 'temporary'
          ? '已更新临时对话 Harness 方案。'
          : scope === 'inherit'
            ? '当前工作区已恢复继承全局 Harness 方案。'
            : 'Harness 方案绑定已更新。') + (warning || ''),
        warning ? 'error' : 'success',
      );
    } catch (cause) {
      showToast(errorText(cause), 'error');
    } finally {
      setBusyKey('');
    }
  }

  const header = <SettingsPageHeader
    title="智能体配置"
    iconPosition="end"
    meta="为主对话、临时对话与子智能体统一装配工具、权限策略和 Harness 运行方案。"
    icon={<svg viewBox="0 0 32 32" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="6" y="8" width="20" height="17" rx="5" />
      <path d="M16 4v4M12 15.5h.01M20 15.5h.01" />
      <path d="M12.5 20h7" stroke="var(--accent)" />
    </svg>}
  />;

  const tabs = <div className="agents-subtabs">
    <SettingsTabs
      id={tabsId}
      label="智能体配置对象"
      tabs={AGENT_SECTIONS}
      value={section}
      onChange={onSectionChange}
    />
  </div>;

  if (section === 'subagents') {
    return <div className="settings-preference-page agents-settings agents-subagents-pane">
      {header}
      {tabs}
      <div id={`${tabsId}-panel`} role="tabpanel" aria-labelledby={`${tabsId}-${section}`}>
        <SubagentSettings
          cwd={cwd}
          workspaces={workspaces}
          models={models}
          embedded
          enabledAgentTools={activeMainToolProfile?.enabled}
          onOpenAgentTools={() => onOpenTab('tools')}
          onWorktreesRevealed={onWorktreesRevealed}
        />
      </div>
    </div>;
  }

  const ready = Boolean(toolProfiles && permissionProfiles && harness);
  const toolOptions = profileOptions('tools', toolProfiles?.profiles);
  const permissionOptions = profileOptions('permissions', permissionProfiles?.profiles);
  const harnessOptions = profileOptions('harness', harness?.profiles);
  const currentToolId = mainScope === 'workspace'
    ? (toolProfiles?.workspaceProfileId || toolProfiles?.mainProfileId || '')
    : (toolProfiles?.mainProfileId || '');
  const currentPermissionId = mainScope === 'workspace'
    ? (permissionProfiles?.workspaceProfileId || permissionProfiles?.mainProfileId || '')
    : (permissionProfiles?.mainProfileId || '');
  const currentHarnessId = mainScope === 'workspace'
    ? (harness?.workspaceProfileId || harness?.globalProfileId || '')
    : (harness?.globalProfileId || '');

  const currentToolProfile = toolProfiles?.profiles.find(item => item.id === currentToolId);
  const currentPermProfile = permissionProfiles?.profiles.find(item => item.id === currentPermissionId);
  const currentHarnessProfile = harness?.profiles.find(item => item.id === currentHarnessId);

  const tempToolId = toolProfiles?.temporaryProfileId || '';
  const tempPermId = permissionProfiles?.temporaryProfileId || '';
  const tempHarnessId = harness?.temporaryProfileId || 'studio-temporary';
  const tempToolProfile = toolProfiles?.profiles.find(item => item.id === tempToolId);
  const tempPermProfile = permissionProfiles?.profiles.find(item => item.id === tempPermId);
  const tempHarnessProfile = harness?.profiles.find(item => item.id === tempHarnessId);

  return <div className="settings-preference-page agents-settings">
    {header}
    {tabs}

    {!ready && <LoadingState variant="section">正在读取智能体装配方案…</LoadingState>}

    {ready && section === 'main' && toolProfiles && permissionProfiles && harness && <div className="settings-preference-groups">
      <section className="settings-preference-card agents-scope-banner">
        <div>
          <strong>配置范围</strong>
          <p>{mainScope === 'workspace'
            ? `正在设置工作区「${workspaceName}」的主对话方案，未单独覆盖项自动继承全局默认。`
            : '正在设置全局默认方案，所有未单独覆写的工作区都将继承这里的组合。'}</p>
        </div>
        <div className="settings-segments" role="group" aria-label="主对话配置范围">
          <button
            type="button"
            aria-pressed={mainScope === 'workspace'}
            disabled={!cwd}
            onClick={() => setMainScope('workspace')}
          >
            当前工作区
          </button>
          <button
            type="button"
            aria-pressed={mainScope === 'global'}
            onClick={() => setMainScope('global')}
          >
            全局默认
          </button>
        </div>
      </section>

      <section className="settings-preference-card agents-binding-list">
        <div className="agents-binding-row">
          <div className="agents-binding-info">
            <div className="agents-binding-title">
              <Wrench aria-hidden="true" />
              <h3>工具方案</h3>
              {mainScope === 'workspace' && (
                <span className={`agents-scope-pill${toolProfiles.workspaceProfileId ? ' is-override' : ''}`}>
                  {toolProfiles.workspaceProfileId ? '工作区覆盖' : '继承全局'}
                </span>
              )}
            </div>
            <p>{currentToolProfile
              ? `${currentToolProfile.enabled.length} 项工具 · ${EXTENSION_MODE_LABEL[currentToolProfile.extensionMode] || currentToolProfile.extensionMode} · ${MCP_MODE_LABEL[currentToolProfile.mcpMode] || currentToolProfile.mcpMode}`
              : '决定主对话可使用的内置工具、用户扩展与 MCP 服务。'}</p>
          </div>
          <div className="agents-binding-controls">
            <Select
              label="主对话工具方案"
              disabled={Boolean(busyKey)}
              value={currentToolId}
              options={toolOptions}
              onChange={value => void selectToolBinding(value, mainScope)}
            />
            {mainScope === 'workspace' && Boolean(toolProfiles.workspaceProfileId) && (
              <button
                type="button"
                className="settings-outline"
                disabled={Boolean(busyKey)}
                onClick={() => void selectToolBinding(toolProfiles.mainProfileId, 'inherit')}
              >
                <RotateCcw aria-hidden="true" />恢复继承
              </button>
            )}
            <button type="button" className="settings-text-button" onClick={() => onOpenTab('tools')}>
              管理方案<ChevronRight aria-hidden="true" />
            </button>
          </div>
        </div>

        <div className="agents-binding-row">
          <div className="agents-binding-info">
            <div className="agents-binding-title">
              <ShieldCheck aria-hidden="true" />
              <h3>权限策略方案</h3>
              {mainScope === 'workspace' && (
                <span className={`agents-scope-pill${permissionProfiles.workspaceProfileId ? ' is-override' : ''}`}>
                  {permissionProfiles.workspaceProfileId ? '工作区覆盖' : '继承全局'}
                </span>
              )}
            </div>
            <p>{currentPermProfile
              ? `${PRESET_LABEL[currentPermProfile.policy.preset] || currentPermProfile.policy.preset} · ${Object.keys(currentPermProfile.policy.tools || {}).length} 项覆盖 · ${currentPermProfile.policy.rules.length} 条规则`
              : '控制主对话执行工具时的自动放行与确认边界。'}</p>
          </div>
          <div className="agents-binding-controls">
            <Select
              label="主对话权限方案"
              disabled={Boolean(busyKey)}
              value={currentPermissionId}
              options={permissionOptions}
              onChange={value => void selectPermissionBinding(value, mainScope)}
            />
            {mainScope === 'workspace' && Boolean(permissionProfiles.workspaceProfileId) && (
              <button
                type="button"
                className="settings-outline"
                disabled={Boolean(busyKey)}
                onClick={() => void selectPermissionBinding(permissionProfiles.mainProfileId, 'inherit')}
              >
                <RotateCcw aria-hidden="true" />恢复继承
              </button>
            )}
            <button type="button" className="settings-text-button" onClick={() => onOpenTab('permissions')}>
              管理方案<ChevronRight aria-hidden="true" />
            </button>
          </div>
        </div>

        <div className="agents-binding-row">
          <div className="agents-binding-info">
            <div className="agents-binding-title">
              <Code2 aria-hidden="true" />
              <h3>Harness 方案</h3>
              {mainScope === 'workspace' && (
                <span className={`agents-scope-pill${harness.workspaceProfileId ? ' is-override' : ''}`}>
                  {harness.workspaceProfileId ? '工作区覆盖' : '继承全局'}
                </span>
              )}
            </div>
            <p>{currentHarnessProfile
              ? `${harness.sections.filter(s => currentHarnessProfile.sections[s.id] !== false).length}/${harness.sections.length} 段系统提示词 · ${Object.keys(currentHarnessProfile.toolGuidance).length} 条工具说明`
              : '编排系统提示词段落与工具使用引导。'}</p>
          </div>
          <div className="agents-binding-controls">
            <Select
              label="主对话 Harness 方案"
              disabled={Boolean(busyKey)}
              value={currentHarnessId}
              options={harnessOptions}
              onChange={value => void selectHarnessBinding(value, mainScope)}
            />
            {mainScope === 'workspace' && Boolean(harness.workspaceProfileId) && (
              <button
                type="button"
                className="settings-outline"
                disabled={Boolean(busyKey)}
                onClick={() => void selectHarnessBinding(harness.globalProfileId, 'inherit')}
              >
                <RotateCcw aria-hidden="true" />恢复继承
              </button>
            )}
            <button type="button" className="settings-text-button" onClick={() => onOpenTab('harness')}>
              管理方案<ChevronRight aria-hidden="true" />
            </button>
          </div>
        </div>
      </section>
    </div>}

    {ready && section === 'temporary' && toolProfiles && permissionProfiles && harness && <div className="settings-preference-groups">
      <section className="settings-preference-card agents-binding-list">
        <div className="agents-binding-row">
          <div className="agents-binding-info">
            <div className="agents-binding-title">
              <Wrench aria-hidden="true" />
              <h3>临时对话工具方案</h3>
            </div>
            <p>{tempToolProfile
              ? `${tempToolProfile.enabled.length} 项工具 · ${EXTENSION_MODE_LABEL[tempToolProfile.extensionMode] || tempToolProfile.extensionMode} · ${MCP_MODE_LABEL[tempToolProfile.mcpMode] || tempToolProfile.mcpMode}`
              : '配置临时对话能否调用内置工具、用户插件或指定 MCP 服务器。'}</p>
          </div>
          <div className="agents-binding-controls">
            <Select
              label="临时对话工具方案"
              disabled={Boolean(busyKey)}
              value={tempToolId}
              options={toolOptions}
              onChange={value => void selectToolBinding(value, 'temporary')}
            />
            <button type="button" className="settings-text-button" onClick={() => onOpenTab('tools')}>
              管理方案<ChevronRight aria-hidden="true" />
            </button>
          </div>
        </div>

        <div className="agents-binding-row">
          <div className="agents-binding-info">
            <div className="agents-binding-title">
              <ShieldCheck aria-hidden="true" />
              <h3>临时对话权限方案</h3>
            </div>
            <p>{tempPermProfile
              ? `${PRESET_LABEL[tempPermProfile.policy.preset] || tempPermProfile.policy.preset} · 默认${tempPermProfile.policy.default === 'allow' ? '允许' : tempPermProfile.policy.default === 'deny' ? '拒绝' : '询问'}`
              : '决定临时对话调用工具或 MCP 方法时是否请求人工确认。'}</p>
          </div>
          <div className="agents-binding-controls">
            <Select
              label="临时对话权限方案"
              disabled={Boolean(busyKey)}
              value={tempPermId}
              options={permissionOptions}
              onChange={value => void selectPermissionBinding(value, 'temporary')}
            />
            <button type="button" className="settings-text-button" onClick={() => onOpenTab('permissions')}>
              管理方案<ChevronRight aria-hidden="true" />
            </button>
          </div>
        </div>

        <div className="agents-binding-row">
          <div className="agents-binding-info">
            <div className="agents-binding-title">
              <Code2 aria-hidden="true" />
              <h3>临时对话 Harness 方案</h3>
            </div>
            <p>{tempHarnessProfile
              ? `${harness.sections.filter(s => tempHarnessProfile.sections[s.id] !== false).length}/${harness.sections.length} 段系统提示词`
              : '设置临时对话的系统提示词结构、编码原则与补充指令。'}</p>
          </div>
          <div className="agents-binding-controls">
            <Select
              label="临时对话 Harness 方案"
              disabled={Boolean(busyKey)}
              value={tempHarnessId}
              options={harnessOptions}
              onChange={value => void selectHarnessBinding(value, 'temporary')}
            />
            <button type="button" className="settings-text-button" onClick={() => onOpenTab('harness')}>
              管理方案<ChevronRight aria-hidden="true" />
            </button>
          </div>
        </div>
      </section>

      <section className="settings-preference-card agents-temp-preview" aria-label="当前临时对话实际可用能力">
        <header className="agents-temp-preview-head">
          <div>
            <h3>当前临时对话实际可用能力</h3>
            <p>{tempCaps
              ? `基于「${tempCaps.profileName}」，共 ${tempCaps.totalTools} 个工具将在新消息生效（临时对话历史仍仅存内存，不绑定项目目录）。`
              : '正在统计当前可用的工具、扩展与 MCP 服务…'}</p>
          </div>
          <div className="agents-temp-preview-links">
            <button type="button" className="settings-outline" onClick={() => onOpenTab('extensions')}>插件与扩展</button>
            <button type="button" className="settings-outline" onClick={() => onOpenTab('mcp')}>MCP 服务器</button>
          </div>
        </header>

        {tempCaps && <dl className="agents-temp-cap-grid">
          <div>
            <dt>内置工具 ({tempCaps.builtinTools.length})</dt>
            <dd>{tempCaps.builtinTools.length > 0
              ? tempCaps.builtinTools.map(name => <code key={name}>{name}</code>)
              : <span>未启用（纯对话模式）</span>}</dd>
          </div>
          <div>
            <dt>用户扩展工具 ({tempCaps.extensionTools.length})</dt>
            <dd>{tempCaps.extensionTools.length > 0
              ? tempCaps.extensionTools.map(name => <code key={name}>{name}</code>)
              : <span>未启用</span>}</dd>
          </div>
          <div>
            <dt>MCP 服务 ({tempCaps.mcpServers.length})</dt>
            <dd>{tempCaps.mcpServers.length > 0
              ? tempCaps.mcpServers.map(name => <code key={name}>{name}</code>)
              : <span>未使用</span>}</dd>
          </div>
        </dl>}
      </section>
    </div>}
  </div>;
}
