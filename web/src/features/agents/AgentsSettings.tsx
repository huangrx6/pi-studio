import { useEffect, useId, useState } from 'react';
import { ChevronRight, RotateCcw } from 'lucide-react';
import { Accordion } from '../../shared/Accordion';
import { errorText } from '../../shared/error-text';
import { LoadingState } from '../../shared/LoadingState';
import { runtimeRefreshFailure } from '../../shared/runtime-refresh';
import { Select, type SelectOption } from '../../shared/Select';
import { SettingsPageHeader } from '../../shared/SettingsPageHeader';
import { SettingsTabs } from '../../shared/SettingsTabs';
import { useSettingsToast } from '../../shared/SettingsToast';
import type { AgentConfigSection, SettingsTab } from '../../shell/app-shell-config';
import type { PiWorkspace } from '../../shell/app-types';
import type { TemporaryCapabilitiesSnapshot, ToolProfilesSnapshot } from '../../types/agent-tool-types';
import type { HarnessSettingsSnapshot } from '../../types/harness-types';
import type { ModelOption } from '../../types/model-types';
import type { PermissionProfilesSnapshot } from '../../types/permission-types';
import { PermissionPresetGlyph } from '../permissions/PermissionPresetGlyph';
import { SubagentSettings } from '../subagents/SubagentSettings';
import './styles/agents-settings.css';

const AGENT_SECTIONS: ReadonlyArray<{ value: AgentConfigSection; label: string }> = [
  { value: 'main', label: '主对话' },
  { value: 'temporary', label: '临时对话' },
  { value: 'subagents', label: '子智能体' },
];

const EXTENSION_MODE_LABEL: Record<string, string> = {
  'all-enabled': '全部已启用',
  'safe-only': '仅安全扩展',
  none: '已禁用',
};

const MCP_MODE_LABEL: Record<string, string> = {
  'follow-server': '跟随全局',
  picked: '指定服务',
  none: '已禁用',
};

const PRESET_LABEL: Record<string, string> = {
  ask: '严格确认',
  smart: '帮我批准',
  full: '完全权限',
};

const CORE_CODE_TOOLS = new Set(['read', 'write', 'edit', 'bash', 'grep', 'find', 'ls']);

function groupEffectiveTools(enabled: ReadonlyArray<string> = []) {
  const code: string[] = [];
  const browser: string[] = [];
  const desktop: string[] = [];
  const other: string[] = [];
  for (const name of enabled) {
    if (CORE_CODE_TOOLS.has(name)) code.push(name);
    else if (name.startsWith('browser_')) browser.push(name);
    else if (name.startsWith('desktop_')) desktop.push(name);
    else other.push(name);
  }
  return [
    { key: 'code', label: '编码与文件', tools: code },
    { key: 'browser', label: '浏览器', tools: browser },
    { key: 'desktop', label: '电脑操控', tools: desktop },
    { key: 'other', label: '扩展与其他', tools: other },
  ];
}

function EffectiveCapabilitySummary({
  profileName,
  enabledTools,
  mcpServers,
  ephemeral = false,
  onOpenTab,
}: {
  profileName?: string;
  enabledTools: ReadonlyArray<string>;
  mcpServers?: ReadonlyArray<string>;
  ephemeral?: boolean;
  onOpenTab: (tab: SettingsTab) => void;
}) {
  const groups = groupEffectiveTools(enabledTools);
  const nonEmptyGroups = groups.filter(group => group.tools.length > 0);
  const totalTools = enabledTools.length;
  const hasDetails = nonEmptyGroups.length > 0 || Boolean(mcpServers && mcpServers.length > 0);

  return <section
    className={`settings-preference-card agents-summary-card${ephemeral ? ' is-ephemeral' : ''}`}
    aria-label="当前生效能力概览"
  >
    <header className="agents-summary-head">
      <div className="agents-summary-title">
        <h3>当前生效能力概览</h3>
        <span>{profileName ? `基于「${profileName}」 · ${totalTools} 项工具` : `共 ${totalTools} 项工具`}</span>
      </div>
      <div className="agents-summary-links">
        <button type="button" className="agents-slot-link" onClick={() => onOpenTab('extensions')}>
          插件与扩展<ChevronRight aria-hidden="true" />
        </button>
        <button type="button" className="agents-slot-link" onClick={() => onOpenTab('mcp')}>
          MCP 服务器<ChevronRight aria-hidden="true" />
        </button>
      </div>
    </header>

    <div className="agents-summary-strip">
      {groups.map(group => {
        const on = group.tools.length > 0;
        return <div key={group.key} className={`agents-summary-cell${on ? ' is-on' : ''}`}>
          <span className="agents-summary-label"><i aria-hidden="true" />{group.label}</span>
          <strong>{on ? `${group.tools.length} 项` : '关闭'}</strong>
        </div>;
      })}
    </div>

    {hasDetails && <Accordion
      className="agents-temp-detail-disclosure"
      summary="查看生效工具明细"
      badge={`${totalTools} 项`}
      compact
    >
      <div className="agents-temp-detail-body">
        {nonEmptyGroups.map(group => (
          <div key={group.key} className="agents-temp-detail-group">
            <span>{group.label} ({group.tools.length})</span>
            <div className="agents-manifest-chips">
              {group.tools.map(name => <code key={name}>{name}</code>)}
            </div>
          </div>
        ))}
        {mcpServers && mcpServers.length > 0 && <div className="agents-temp-detail-group">
          <span>MCP 服务 ({mcpServers.length})</span>
          <div className="agents-manifest-chips">
            {mcpServers.map(name => <code key={name}>{name}</code>)}
          </div>
        </div>}
      </div>
    </Accordion>}
  </section>;
}

function ShieldDial({ preset }: { preset?: string }) {
  return <PermissionPresetGlyph preset={preset} className="agents-shield-glyph" />;
}

function PromptMatrix({ sections, enabledMap }: {
  sections: ReadonlyArray<{ id: string }>;
  enabledMap?: Record<string, boolean>;
}) {
  return <span className="agents-prompt-matrix" aria-hidden="true">
    {sections.map(section => (
      <i key={section.id} className={enabledMap && enabledMap[section.id] !== false ? 'is-on' : ''} />
    ))}
  </span>;
}

function profileOptions(profiles: ReadonlyArray<{ id: string; name: string }> = []): SelectOption[] {
  return profiles.map(profile => ({
    value: profile.id,
    label: profile.name,
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
    meta="为主对话、临时对话与子智能体装配工具、权限与 Harness 方案。"
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
      <div key={section} id={`${tabsId}-panel`} className="agents-workspace-panel" role="tabpanel" aria-labelledby={`${tabsId}-${section}`}>
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
  const toolOptions = profileOptions(toolProfiles?.profiles);
  const permissionOptions = profileOptions(permissionProfiles?.profiles);
  const harnessOptions = profileOptions(harness?.profiles);
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

    {!ready && <div className="settings-loading-card"><LoadingState variant="section">正在读取智能体装配方案…</LoadingState></div>}

    {ready && section === 'main' && toolProfiles && permissionProfiles && harness && (() => {
      const overrideCount = [
        toolProfiles.workspaceProfileId,
        permissionProfiles.workspaceProfileId,
        harness.workspaceProfileId,
      ].filter(Boolean).length;
      const harnessEnabledCount = currentHarnessProfile
        ? harness.sections.filter(s => currentHarnessProfile.sections[s.id] !== false).length
        : 0;
      const permDecision = currentPermProfile
        ? (currentPermProfile.policy.default === 'allow' ? '默认允许' : currentPermProfile.policy.default === 'deny' ? '默认拒绝' : '默认询问')
        : '';

      return <div key={section} id={`${tabsId}-panel`} role="tabpanel" aria-labelledby={`${tabsId}-${section}`} className="agents-workspace-panel agents-rig-stack">
        <section className="settings-preference-card agents-rig-bar">
          <div className="agents-rig-context">
            <span className="agents-rig-kicker">
              <i aria-hidden="true" />
              {mainScope === 'workspace' ? `工作区 · ${workspaceName}` : '全局默认'}
            </span>
            {mainScope === 'workspace' && <span className="agents-rig-note">
              {overrideCount > 0 ? `已覆写 ${overrideCount} 项` : '继承全局默认'}
            </span>}
          </div>
          <div className="agents-scope-switch" role="group" aria-label="主对话配置范围">
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

        <section className="settings-preference-card agents-deck" aria-label="主对话装配方案">
          {/* Row 1 · 工具方案 */}
          <div className="agents-deck-row">
            <span className="agents-row-badge agents-row-count" aria-hidden="true">
              {currentToolProfile ? currentToolProfile.enabled.length : 0}
            </span>
            <div className="agents-row-copy">
              <div className="agents-row-head">
                <h3>
                  <button type="button" className="agents-row-open" onClick={() => onOpenTab('tools')}>
                    工具方案
                  </button>
                </h3>
                {mainScope === 'workspace' && (
                  <span className={`agents-slot-state${toolProfiles.workspaceProfileId ? ' is-override' : ''}`}>
                    {toolProfiles.workspaceProfileId ? <><i aria-hidden="true" />工作区覆盖</> : '继承全局'}
                  </span>
                )}
              </div>
              <p>{currentToolProfile
                ? `${currentToolProfile.enabled.length} 项工具 · 扩展${EXTENSION_MODE_LABEL[currentToolProfile.extensionMode] || currentToolProfile.extensionMode} · MCP ${MCP_MODE_LABEL[currentToolProfile.mcpMode] || currentToolProfile.mcpMode}`
                : '控制主对话可调用的内置工具、扩展与 MCP 服务。'}</p>
            </div>
            <div className="agents-row-controls">
              {mainScope === 'workspace' && Boolean(toolProfiles.workspaceProfileId) && (
                <button
                  type="button"
                  className="agents-row-reset"
                  title="恢复继承全局方案"
                  aria-label="恢复继承工具方案"
                  disabled={Boolean(busyKey)}
                  onClick={() => void selectToolBinding(toolProfiles.mainProfileId, 'inherit')}
                >
                  <RotateCcw aria-hidden="true" />
                </button>
              )}
              <Select
                label="主对话工具方案"
                disabled={Boolean(busyKey)}
                value={currentToolId}
                options={toolOptions}
                onChange={value => void selectToolBinding(value, mainScope)}
              />
            </div>
          </div>

          {/* Row 2 · 权限策略 */}
          <div className="agents-deck-row">
            <span className="agents-row-badge" aria-hidden="true">
              <ShieldDial preset={currentPermProfile?.policy.preset} />
            </span>
            <div className="agents-row-copy">
              <div className="agents-row-head">
                <h3>
                  <button type="button" className="agents-row-open" onClick={() => onOpenTab('permissions')}>
                    权限策略
                  </button>
                </h3>
                {mainScope === 'workspace' && (
                  <span className={`agents-slot-state${permissionProfiles.workspaceProfileId ? ' is-override' : ''}`}>
                    {permissionProfiles.workspaceProfileId ? <><i aria-hidden="true" />工作区覆盖</> : '继承全局'}
                  </span>
                )}
              </div>
              <p>{currentPermProfile
                ? `${PRESET_LABEL[currentPermProfile.policy.preset] || currentPermProfile.policy.preset} · ${permDecision} · ${Object.keys(currentPermProfile.policy.tools || {}).length} 项例外 · ${currentPermProfile.policy.rules.length} 条规则`
                : '控制执行工具时的自动放行与人工确认边界。'}</p>
            </div>
            <div className="agents-row-controls">
              {mainScope === 'workspace' && Boolean(permissionProfiles.workspaceProfileId) && (
                <button
                  type="button"
                  className="agents-row-reset"
                  title="恢复继承全局方案"
                  aria-label="恢复继承权限方案"
                  disabled={Boolean(busyKey)}
                  onClick={() => void selectPermissionBinding(permissionProfiles.mainProfileId, 'inherit')}
                >
                  <RotateCcw aria-hidden="true" />
                </button>
              )}
              <Select
                label="主对话权限方案"
                disabled={Boolean(busyKey)}
                value={currentPermissionId}
                options={permissionOptions}
                onChange={value => void selectPermissionBinding(value, mainScope)}
              />
            </div>
          </div>

          {/* Row 3 · Harness 基线 */}
          <div className="agents-deck-row">
            <span className="agents-row-badge" aria-hidden="true">
              <PromptMatrix sections={harness.sections} enabledMap={currentHarnessProfile?.sections} />
            </span>
            <div className="agents-row-copy">
              <div className="agents-row-head">
                <h3>
                  <button type="button" className="agents-row-open" onClick={() => onOpenTab('harness')}>
                    Harness 基线
                  </button>
                </h3>
                {mainScope === 'workspace' && (
                  <span className={`agents-slot-state${harness.workspaceProfileId ? ' is-override' : ''}`}>
                    {harness.workspaceProfileId ? <><i aria-hidden="true" />工作区覆盖</> : '继承全局'}
                  </span>
                )}
              </div>
              <p>{currentHarnessProfile
                ? `${harnessEnabledCount}/${harness.sections.length} 段系统提示词 · ${Object.keys(currentHarnessProfile.toolGuidance).length} 条工具说明${currentHarnessProfile.customInstructions?.trim() ? ' · 含附加指令' : ''}`
                : '编排系统提示词段落与工具使用说明。'}</p>
            </div>
            <div className="agents-row-controls">
              {mainScope === 'workspace' && Boolean(harness.workspaceProfileId) && (
                <button
                  type="button"
                  className="agents-row-reset"
                  title="恢复继承全局方案"
                  aria-label="恢复继承 Harness 方案"
                  disabled={Boolean(busyKey)}
                  onClick={() => void selectHarnessBinding(harness.globalProfileId, 'inherit')}
                >
                  <RotateCcw aria-hidden="true" />
                </button>
              )}
              <Select
                label="主对话 Harness 方案"
                disabled={Boolean(busyKey)}
                value={currentHarnessId}
                options={harnessOptions}
                onChange={value => void selectHarnessBinding(value, mainScope)}
              />
            </div>
          </div>
        </section>

        <EffectiveCapabilitySummary
          profileName={currentToolProfile?.name}
          enabledTools={currentToolProfile?.enabled ?? []}
          mcpServers={currentToolProfile?.mcpMode === 'picked' ? currentToolProfile.mcpServers : undefined}
          onOpenTab={onOpenTab}
        />
      </div>;
    })()}

    {ready && section === 'temporary' && toolProfiles && permissionProfiles && harness && (() => {
      const tempHarnessEnabledCount = tempHarnessProfile
        ? harness.sections.filter(s => tempHarnessProfile.sections[s.id] !== false).length
        : 0;
      const tempPermDecision = tempPermProfile
        ? (tempPermProfile.policy.default === 'allow' ? '默认允许' : tempPermProfile.policy.default === 'deny' ? '默认拒绝' : '默认询问')
        : '';
      const effectiveTempTools = tempCaps
        ? [...tempCaps.builtinTools, ...tempCaps.extensionTools]
        : (tempToolProfile?.enabled ?? []);
      const totalTempTools = effectiveTempTools.length;

      return <div key={section} id={`${tabsId}-panel`} role="tabpanel" aria-labelledby={`${tabsId}-${section}`} className="agents-workspace-panel agents-rig-stack">
        <section className="agents-sandbox-banner">
          <div className="agents-rig-context">
            <span className="agents-sandbox-kicker">
              <i aria-hidden="true" />临时对话
            </span>
            <span className="agents-rig-note">独立于项目 · 历史保存在本机</span>
          </div>
          <span className="agents-sandbox-posture">
            {totalTempTools === 0 ? '纯对话 · 0 工具' : `已启用 ${totalTempTools} 项工具`}
          </span>
        </section>

        <section className="settings-preference-card agents-deck is-ephemeral" aria-label="临时对话装配方案">
          <div className="agents-deck-row">
            <span className="agents-row-badge agents-row-count" aria-hidden="true">
              {tempToolProfile ? tempToolProfile.enabled.length : 0}
            </span>
            <div className="agents-row-copy">
              <div className="agents-row-head">
                <h3>
                  <button type="button" className="agents-row-open" onClick={() => onOpenTab('tools')}>
                    工具方案
                  </button>
                </h3>
              </div>
              <p>{tempToolProfile
                ? `${tempToolProfile.enabled.length} 项工具 · 扩展${EXTENSION_MODE_LABEL[tempToolProfile.extensionMode] || tempToolProfile.extensionMode} · MCP ${MCP_MODE_LABEL[tempToolProfile.mcpMode] || tempToolProfile.mcpMode}`
                : '配置临时对话能否调用内置工具、扩展或 MCP 服务。'}</p>
            </div>
            <div className="agents-row-controls">
              <Select
                label="临时对话工具方案"
                disabled={Boolean(busyKey)}
                value={tempToolId}
                options={toolOptions}
                onChange={value => void selectToolBinding(value, 'temporary')}
              />
            </div>
          </div>

          <div className="agents-deck-row">
            <span className="agents-row-badge" aria-hidden="true">
              <ShieldDial preset={tempPermProfile?.policy.preset} />
            </span>
            <div className="agents-row-copy">
              <div className="agents-row-head">
                <h3>
                  <button type="button" className="agents-row-open" onClick={() => onOpenTab('permissions')}>
                    权限策略
                  </button>
                </h3>
              </div>
              <p>{tempPermProfile
                ? `${PRESET_LABEL[tempPermProfile.policy.preset] || tempPermProfile.policy.preset} · ${tempPermDecision}`
                : '决定临时对话调用工具时是否请求人工确认。'}</p>
            </div>
            <div className="agents-row-controls">
              <Select
                label="临时对话权限方案"
                disabled={Boolean(busyKey)}
                value={tempPermId}
                options={permissionOptions}
                onChange={value => void selectPermissionBinding(value, 'temporary')}
              />
            </div>
          </div>

          <div className="agents-deck-row">
            <span className="agents-row-badge" aria-hidden="true">
              <PromptMatrix sections={harness.sections} enabledMap={tempHarnessProfile?.sections} />
            </span>
            <div className="agents-row-copy">
              <div className="agents-row-head">
                <h3>
                  <button type="button" className="agents-row-open" onClick={() => onOpenTab('harness')}>
                    Harness 基线
                  </button>
                </h3>
              </div>
              <p>{tempHarnessProfile
                ? `${tempHarnessEnabledCount}/${harness.sections.length} 段系统提示词 · 轻量无盘上下文`
                : '设置临时对话的系统提示词结构与补充指令。'}</p>
            </div>
            <div className="agents-row-controls">
              <Select
                label="临时对话 Harness 方案"
                disabled={Boolean(busyKey)}
                value={tempHarnessId}
                options={harnessOptions}
                onChange={value => void selectHarnessBinding(value, 'temporary')}
              />
            </div>
          </div>
        </section>

        <EffectiveCapabilitySummary
          profileName={tempCaps?.profileName || tempToolProfile?.name}
          enabledTools={effectiveTempTools}
          mcpServers={tempCaps?.mcpServers}
          ephemeral
          onOpenTab={onOpenTab}
        />
      </div>;
    })()}
  </div>;
}
