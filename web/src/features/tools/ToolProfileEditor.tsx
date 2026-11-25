import { useId, useMemo, useState } from 'react';
import {
  Check,
  ChevronRight,
  ChevronUp,
  CircleAlert,
  Copy,
  Package,
  RotateCcw,
  RotateCw,
  Search,
  Terminal,
  Wrench,
  X,
  Trash2,
} from 'lucide-react';
import { Accordion } from '../../shared/Accordion';
import { ActionMenu } from '../../shared/ActionMenu';
import { useActionConfirmation } from '../../shared/ConfirmDialog';
import { DetailDialog } from '../../shared/DetailDialog';
import { InfoHint } from '../../shared/InfoHint';
import { LoadingIndicator } from '../../shared/LoadingState';
import { SettingsDialog } from '../../shared/SettingsDialog';
import { useSettingsDraftGuard } from '../../shared/SettingsDraftGuard';
import { automaticProfileIcon, SettingsProfileIdentity } from '../../shared/SettingsProfileIcon';
import { useSettingsToast } from '../../shared/SettingsToast';
import type { ModalDismiss } from '../../shared/useModalDialog';
import { isComposingKey } from '../../shared/keyboard-navigation';
import type {
  AgentToolCatalog,
  AgentToolCommand,
  AgentToolExtensionMode,
  AgentToolInfo,
  AgentToolMcpMode,
  AgentToolProfile,
  AgentToolProfilePatch,
  AgentToolSelection,
  AgentToolSource,
  ToolProfilesSnapshot,
} from '../../types/agent-tool-types';
import { groupAgentTools, isMcpMethod, type CatalogDisplayEntry } from './agent-tool-groups';
import { patternMatches, sameToolNames, selectionFromSources, toggleToolSelection } from './agent-tool-selection';

export const RECOMMENDED_TOOL_NAMES = ['read', 'write', 'edit', 'bash', 'grep', 'find', 'ls', 'tool_search'];

export type ToolProfileBindingScope = 'workspace' | 'global' | 'inherit' | 'temporary';

const EXTENSION_MODE_OPTIONS: Array<{ id: AgentToolExtensionMode; shortLabel: string; label: string; hint: string }> = [
  { id: 'all-enabled', shortLabel: '全部已启用', label: '全部已启用扩展', hint: '放行已在下方勾选（或通配匹配）且受信任的用户扩展工具' },
  { id: 'safe-only', shortLabel: '仅安全扩展', label: '仅安全扩展', hint: '在下方勾选的工具中，仅放行只读安全扩展工具，拦截写入类扩展操作' },
  { id: 'none', shortLabel: '禁用扩展', label: '禁用用户扩展', hint: '完全屏蔽所有用户扩展与插件工具，即使下方存在匹配规则也不启用' },
];

const MCP_MODE_OPTIONS: Array<{ id: AgentToolMcpMode; shortLabel: string; label: string; hint: string }> = [
  { id: 'follow-server', shortLabel: '跟随全局 MCP', label: '跟随 MCP 全局', hint: '所有已启用的 MCP 服务器均可在此方案中调用' },
  { id: 'picked', shortLabel: '指定服务器', label: '指定服务器', hint: '仅放行下方勾选的 MCP 服务器（方法规则仍以 MCP 设置为准）' },
  { id: 'none', shortLabel: '禁用 MCP', label: '禁用 MCP', hint: '此方案下不挂载任何 MCP 服务器或工具搜索目录' },
];

const SOURCE_KIND_LABEL: Record<AgentToolSource['kind'], string> = {
  core: 'Pi 核心',
  mcp: 'MCP 服务器',
  package: '扩展包',
  git: 'Git 扩展',
  local: '本地扩展',
  inline: 'Studio 内置',
  extension: '扩展',
};

type AgentToolDetail = {
  kind: 'tool';
  item: CatalogDisplayEntry<AgentToolInfo>;
} | {
  kind: 'command';
  item: CatalogDisplayEntry<AgentToolCommand>;
};

function cloneToolProfile(profile: AgentToolProfile): AgentToolProfile {
  return {
    ...profile,
    enabled: [...profile.enabled],
    sources: { ...profile.sources },
    mcpServers: [...profile.mcpServers],
  };
}

function toolSource(selection: AgentToolSelection, name: string): AgentToolSource {
  const stored = selection.sources[name];
  return {
    key: stored?.source || 'unknown',
    source: stored?.source || 'unknown',
    label: stored?.label || '来源未知',
    kind: stored?.source?.startsWith('npm:')
      ? 'package'
      : stored?.source?.startsWith('git:')
        ? 'git'
        : stored?.source === 'manual'
          ? 'local'
          : 'extension',
    scope: stored?.scope || 'user',
    path: stored?.path || '',
    baseDir: stored?.baseDir || '',
  };
}

function scopeLabel(scope: string): string {
  if (scope === 'project' || scope === 'workspace') return '当前项目';
  if (scope === 'manual') return '手动添加';
  return '全局';
}

function exposureLabel(exposure: string): string {
  if (exposure === 'direct') return '直接提供';
  if (exposure === 'on-demand' || exposure === 'deferred') return '按需加载';
  if (exposure === 'hidden') return '隐藏';
  return exposure || '标准';
}

export function ToolProfileEditor({
  creating,
  source,
  snapshot,
  cwd,
  mcpServers,
  catalog,
  catalogLoading,
  catalogError,
  busy,
  onReloadCatalog,
  onOpenMcp,
  onSave,
  onApply,
  onReset,
  onDelete,
  onCopy,
  onClose,
}: {
  creating: boolean;
  source: AgentToolProfile;
  snapshot: ToolProfilesSnapshot;
  cwd: string;
  mcpServers: Array<{ name: string; enabled: boolean }>;
  catalog: AgentToolCatalog | null;
  catalogLoading: boolean;
  catalogError: string | null;
  busy: boolean;
  onReloadCatalog: () => void;
  onOpenMcp: () => void;
  onSave: (payload: { mode: 'create' | 'edit'; profile: AgentToolProfilePatch }, dismiss: ModalDismiss) => Promise<void>;
  onApply: (id: string, scope: ToolProfileBindingScope) => Promise<void>;
  onReset: (id: string, dismiss: ModalDismiss) => Promise<void>;
  onDelete: (id: string, dismiss: ModalDismiss) => Promise<void>;
  onCopy: (profile: AgentToolProfile) => void;
  onClose: () => void;
}) {
  const showToast = useSettingsToast();
  const confirmation = useActionConfirmation();
  const [initial] = useState<AgentToolProfile>(() =>
    creating
      ? { ...cloneToolProfile(source), id: '', name: '', builtin: false }
      : cloneToolProfile(source));
  const [draft, setDraft] = useState<AgentToolProfile>(() => cloneToolProfile(initial));
  const [manualId, setManualId] = useState<string | null>(null);
  const [fallbackId] = useState(() => creating ? 'tools-' + crypto.randomUUID().slice(0, 8) : '');
  const [scope, setScope] = useState<'workspace' | 'global' | 'temporary'>(cwd ? 'workspace' : 'global');
  const [menuAnchor, setMenuAnchor] = useState<HTMLButtonElement | null>(null);
  const [query, setQuery] = useState('');
  const [customName, setCustomName] = useState('');
  const [groupExpansion, setGroupExpansion] = useState<Record<string, boolean>>({});
  const [collapsedMatches, setCollapsedMatches] = useState<string[]>([]);
  const [detail, setDetail] = useState<AgentToolDetail | null>(null);
  const menuId = useId();
  const groupId = useId();

  const nameSlug = draft.name.trim().toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[^a-z0-9]+|[-]+$/g, '')
    .slice(0, 64);
  const suggestedId = nameSlug.length >= 2 ? nameSlug : draft.name.trim() ? fallbackId : '';
  const id = creating ? (manualId ?? suggestedId).trim() : initial.id;

  const identityChanged = draft.name !== initial.name || draft.description !== initial.description;
  const iconChanged = draft.icon?.shape !== initial.icon?.shape || draft.icon?.ink !== initial.icon?.ink;
  const settingsChanged = draft.extensionMode !== initial.extensionMode
    || draft.mcpMode !== initial.mcpMode
    || !sameToolNames(draft.mcpServers, initial.mcpServers)
    || !sameToolNames(draft.enabled, initial.enabled);
  const dirty = identityChanged || iconChanged || settingsChanged
    || (creating && manualId !== null && manualId !== suggestedId);
  useSettingsDraftGuard({ label: '工具方案', dirty, saving: busy });

  let idIssue: string | null = null;
  if (creating && (draft.name.trim() || manualId !== null)) {
    if (!/^[a-z0-9][a-z0-9._-]{1,63}$/.test(id) || ['__proto__', 'constructor', 'prototype'].includes(id)) {
      idIssue = '请输入有效的方案 ID（2-64 位小写字母、数字、点、横线或下划线）。';
    } else if (snapshot.profiles.some(item => item.id === id)) {
      idIssue = '这个方案 ID 已存在，请更换其他 ID。';
    }
  }
  const canSave = (creating || dirty) && Boolean(id && draft.name.trim()) && !idIssue;

  const localTools = useMemo(() => catalog?.tools.filter(tool => !isMcpMethod(tool)) ?? [], [catalog]);
  const catalogSources = useMemo(
    () => Object.fromEntries(localTools.map(tool => [tool.name, tool.source])),
    [localTools],
  );
  const availableNames = useMemo(() => new Set(localTools.map(tool => tool.name)), [localTools]);
  const wildcardRules = draft.enabled.filter(name => name.includes('*'));
  const unavailable = catalog ? draft.enabled.filter(name => !name.includes('*') && !availableNames.has(name)) : [];
  const groups = useMemo(() => catalog ? groupAgentTools(catalog, query) : [], [catalog, query]);
  const searching = Boolean(query.trim());

  const scopeId = scope === 'global'
    ? snapshot.mainProfileId
    : scope === 'temporary'
      ? snapshot.temporaryProfileId
      : snapshot.workspaceProfileId;
  const applied = scopeId === initial.id;
  const boundId = scopeId || snapshot.mainProfileId;
  const boundName = snapshot.profiles.find(item => item.id === boundId)?.name || boundId;
  const scopeHelp = scope === 'global'
    ? `未单独指定方案的工作区默认使用「${boundName}」。`
    : scope === 'temporary'
      ? `新发起的临时对话将使用「${boundName}」的工具和 MCP 范围。`
      : scopeId
        ? `当前工作区使用「${boundName}」。`
        : `当前工作区继承全局主对话方案「${boundName}」。`;

  const allServerNames = useMemo(() => {
    const names = new Set(mcpServers.map(item => item.name));
    for (const selected of draft.mcpServers) names.add(selected);
    return [...names].sort();
  }, [mcpServers, draft.mcpServers]);

  const selectionEnables = (name: string) => draft.enabled.some(pattern => patternMatches(pattern, name));
  const detailIsTool = detail?.kind === 'tool';
  const detailEnabled = detailIsTool && selectionEnables(detail.item.name);

  function updateEnabled(next: string[]) {
    const updated = selectionFromSources(next, catalogSources, { enabled: draft.enabled, sources: draft.sources });
    setDraft(current => ({ ...current, enabled: updated.enabled, sources: updated.sources }));
  }

  function toggleTool(name: string, checked: boolean) {
    const expandsWildcard = !checked && draft.enabled.some(rule => rule.includes('*') && patternMatches(rule, name));
    updateEnabled(toggleToolSelection(draft.enabled, [...availableNames], name, checked));
    if (expandsWildcard) showToast('已展开匹配的通配规则。保存后，新出现的匹配工具需单独允许。', 'info');
  }

  function addCustomTool() {
    const name = customName.trim();
    if (!/^[A-Za-z0-9_.:*\-]+$/.test(name) || ['__proto__', 'prototype', 'constructor'].includes(name)) {
      showToast('工具名或通配符只能包含字母、数字、点、横线、下划线、冒号或星号。', 'error');
      return;
    }
    if (name.startsWith('mcp__')) {
      showToast('MCP 方法请在 MCP 设置中启停，并在上方选择可用 MCP 服务器范围。', 'error');
      return;
    }
    if (!draft.enabled.includes(name)) updateEnabled([...draft.enabled, name]);
    setCustomName('');
  }

  function toggleMcpServer(name: string, checked: boolean) {
    setDraft(current => {
      const next = checked
        ? [...new Set([...current.mcpServers, name])]
        : current.mcpServers.filter(item => item !== name);
      return { ...current, mcpServers: next };
    });
  }

  function toggleGroup(key: string, defaultOpen: boolean) {
    if (searching) {
      setCollapsedMatches(keys => keys.includes(key) ? keys.filter(item => item !== key) : [...keys, key]);
    } else {
      setGroupExpansion(current => ({ ...current, [key]: !(current[key] ?? defaultOpen) }));
    }
  }

  function handleSave(dismiss: ModalDismiss) {
    if (!canSave) return;
    if ((creating || settingsChanged) && draft.mcpMode === 'picked' && draft.mcpServers.length === 0) {
      showToast('已选为“指定服务器”，请至少勾选一个 MCP 服务器或改为“禁用 MCP”。', 'error');
      return;
    }
    void onSave({
      mode: creating ? 'create' : 'edit',
      profile: {
        id,
        ...((creating || identityChanged) && { name: draft.name.trim(), description: draft.description.trim() }),
        ...((creating || iconChanged) && { icon: draft.icon ?? null }),
        ...((creating || settingsChanged) && {
          enabled: draft.enabled,
          sources: draft.sources,
          extensionMode: draft.extensionMode,
          mcpMode: draft.mcpMode,
          mcpServers: draft.mcpServers,
        }),
      },
    }, dismiss);
  }

  async function handleReset(dismiss: ModalDismiss) {
    if (await confirmation.confirm({
      title: '恢复内置工具方案默认值？',
      description: `「${initial.name}」的内置工具、扩展和 MCP 策略将恢复为系统默认设置。`,
      confirmLabel: '恢复默认',
    })) {
      await onReset(initial.id, dismiss);
    }
  }

  async function handleDelete(dismiss: ModalDismiss) {
    if (!initial.builtin && await confirmation.confirm({
      title: '删除工具方案？',
      description: `删除「${initial.name}」后，引用它的主对话工作区、临时对话或子智能体会自动回退到默认方案。`,
      confirmLabel: '删除方案',
      tone: 'danger',
    })) {
      await onDelete(initial.id, dismiss);
    }
  }

  return <>
    <SettingsDialog
      wide
      className="tool-profile-dialog"
      title={creating ? '新建工具方案' : `编辑工具方案 · ${initial.name}`}
      description={creating && source.name ? `以「${source.name}」为模板创建，可单独配置工具、用户扩展和 MCP 范围。` : undefined}
      action={creating ? '创建方案' : '保存方案'}
      busy={busy}
      loading={false}
      unavailable={!canSave}
      error={idIssue}
      onClose={onClose}
      onSubmit={handleSave}
      onRequestClose={async dismiss => {
        if (!dirty || await confirmation.confirm({
          title: '放弃未保存的工具方案更改？',
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
      <div className="settings-form-sections tool-profile-editor">
        <section className="settings-form-section">
          <h3>基本信息与绑定</h3>
          <SettingsProfileIdentity group="tools" value={draft.icon} automatic={automaticProfileIcon('tools', id || fallbackId)}
            onChange={icon => setDraft(current => ({ ...current, icon }))}>
            <label className="profile-identity-field">
              <span>方案名称</span>
              <input
                required
                maxLength={80}
                value={draft.name}
                placeholder="例如，只读检索 / 临时联网助手"
                onChange={event => setDraft(current => ({ ...current, name: event.target.value }))}
              />
            </label>
            <div className="profile-identity-field profile-identity-id">
              <span className="settings-field-heading">
                {creating ? <label htmlFor="tool-profile-id">方案 ID</label> : <span>方案 ID</span>}
                {creating && <InfoHint label="2 至 64 个小写字母、数字、点、横线或下划线，创建后不可更改。" />}
              </span>
              {creating ? <input
                id="tool-profile-id"
                maxLength={64}
                required
                value={manualId ?? suggestedId}
                aria-invalid={Boolean(idIssue)}
                placeholder="read-only-search"
                onChange={event => setManualId(event.target.value)}
              /> : <code className="harness-stored-id">{id}</code>}
            </div>
            <label className="profile-identity-field profile-identity-desc">
              <span>说明</span>
              <input
                maxLength={240}
                value={draft.description}
                placeholder="简要说明这个工具方案适用场景"
                onChange={event => setDraft(current => ({ ...current, description: event.target.value }))}
              />
            </label>
          </SettingsProfileIdentity>

          {!creating && <div className="harness-setting-row harness-editor-context">
            <div>
              <span>应用范围</span>
              <p>{scopeHelp}</p>
            </div>
            <div className="harness-binding-controls">
              <div className="settings-segments" role="group" aria-label="工具方案应用范围">
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

        <section className="settings-form-section">
          <h3>用户扩展与 MCP 服务范围</h3>
          <div className="tool-profile-scope-grid">
            <div className="tool-profile-scope-block">
              <div className="tool-profile-scope-head">
                <div>
                  <span className="tool-profile-block-title">用户扩展策略</span>
                  <p className="tool-profile-scope-hint">
                    {EXTENSION_MODE_OPTIONS.find(option => option.id === draft.extensionMode)?.hint}
                  </p>
                </div>
                <div className="settings-segments tool-profile-segments" role="radiogroup" aria-label="用户扩展策略">
                  {EXTENSION_MODE_OPTIONS.map(option => {
                    const selected = draft.extensionMode === option.id;
                    return <button
                      key={option.id}
                      type="button"
                      role="radio"
                      aria-checked={selected}
                      aria-pressed={selected}
                      onClick={() => setDraft(current => ({ ...current, extensionMode: option.id }))}
                    >
                      {option.shortLabel}
                    </button>;
                  })}
                </div>
              </div>
            </div>

            <div className="tool-profile-scope-block">
              <div className="tool-profile-scope-head">
                <div>
                  <div className="tool-profile-title-link">
                    <span className="tool-profile-block-title">MCP 服务策略</span>
                    <button type="button" className="settings-text-button" onClick={onOpenMcp}>
                      管理 MCP 服务器<ChevronRight aria-hidden="true" />
                    </button>
                  </div>
                  <p className="tool-profile-scope-hint">
                    {MCP_MODE_OPTIONS.find(option => option.id === draft.mcpMode)?.hint}
                  </p>
                </div>
                <div className="settings-segments tool-profile-segments" role="radiogroup" aria-label="MCP 服务策略">
                  {MCP_MODE_OPTIONS.map(option => {
                    const selected = draft.mcpMode === option.id;
                    return <button
                      key={option.id}
                      type="button"
                      role="radio"
                      aria-checked={selected}
                      aria-pressed={selected}
                      onClick={() => setDraft(current => ({ ...current, mcpMode: option.id }))}
                    >
                      {option.shortLabel}
                    </button>;
                  })}
                </div>
              </div>

              {draft.mcpMode === 'picked' && <div className="tool-profile-mcp-picker">
                {allServerNames.length === 0 ? (
                  <p className="tool-profile-mcp-empty">当前还没有配置 MCP 服务器，请先在「插件 → MCP」中添加。</p>
                ) : (
                  <div className="tool-profile-mcp-chips">
                    {allServerNames.map(serverName => {
                      const checked = draft.mcpServers.includes(serverName);
                      const serverRow = mcpServers.find(item => item.name === serverName);
                      const enabledGlobally = serverRow?.enabled ?? false;
                      return <label key={serverName} className={`tool-profile-mcp-chip${checked ? ' is-checked' : ''}`}>
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={event => toggleMcpServer(serverName, event.target.checked)}
                        />
                        <code>{serverName}</code>
                        {!enabledGlobally && <small>全局已停用</small>}
                      </label>;
                    })}
                  </div>
                )}
              </div>}
            </div>
          </div>
        </section>

        <section className="settings-form-section">
          <div className="tool-profile-catalog-head">
            <div>
              <h3>内置与扩展工具白名单</h3>
              <p>已启用 {draft.enabled.length} 条工具规则{catalog ? ` · 当前发现 ${localTools.length} 个本地工具` : ''}</p>
            </div>
            <div className="tool-profile-catalog-actions">
              <button
                type="button"
                className="settings-outline"
                disabled={sameToolNames(draft.enabled, RECOMMENDED_TOOL_NAMES)}
                onClick={() => updateEnabled(RECOMMENDED_TOOL_NAMES)}
              >
                <Wrench aria-hidden="true" />填入推荐核心工具
              </button>
              <button
                type="button"
                className="settings-outline"
                disabled={catalogLoading}
                onClick={onReloadCatalog}
              >
                {catalogLoading ? <LoadingIndicator /> : <RotateCw aria-hidden="true" />}刷新目录
              </button>
            </div>
          </div>

          <div className="agent-tool-search-wrap">
            <Search aria-hidden="true" />
            <input
              className="agent-tool-search"
              aria-label="搜索方案内工具"
              placeholder="搜索工具、命令或来源…"
              value={query}
              onChange={event => { setQuery(event.target.value); setCollapsedMatches([]); }}
            />
            {query && (
              <button type="button" aria-label="清除工具搜索" title="清除搜索" onClick={() => { setQuery(''); setCollapsedMatches([]); }}>
                <X />
              </button>
            )}
          </div>

          {catalogError && (
            <div className="agent-tool-catalog-error">
              <p role="alert">{catalogError}</p>
              <button type="button" className="settings-text-button" onClick={onReloadCatalog}>重新读取</button>
            </div>
          )}

          {catalog && <div className="agent-tool-groups">
            {groups.map((group, index) => {
              const expanded = searching ? !collapsedMatches.includes(group.key) : groupExpansion[group.key] ?? group.defaultOpen;
              const panel = `${groupId}-${index}`;
              const enabledCount = group.tools.filter(tool => selectionEnables(tool.name)).length;
              return <section className="agent-tool-group" key={group.key}>
                <h4>
                  <button
                    type="button"
                    className="agent-tool-group-trigger"
                    aria-expanded={expanded}
                    aria-controls={panel}
                    onClick={() => toggleGroup(group.key, group.defaultOpen)}
                  >
                    <span>{group.label}</span>
                    <small>{searching
                      ? `${group.tools.length + group.commands.length} 项匹配`
                      : [group.tools.length > 0 && `${enabledCount} / ${group.tools.length} 已启用`, group.commands.length > 0 && `${group.commands.length} 个命令`].filter(Boolean).join(' · ')}</small>
                    <ChevronRight aria-hidden="true" />
                  </button>
                </h4>
                <div id={panel} hidden={!expanded}>
                  {expanded && <ul className="agent-tool-list">
                    {group.tools.map(tool => {
                      const enabled = selectionEnables(tool.name);
                      return <li className="agent-tool-row" key={tool.name}>
                        <div>
                          <button
                            type="button"
                            className="agent-tool-open settings-row-link"
                            aria-label={`查看工具 ${tool.name} 详情`}
                            onClick={() => setDetail({ kind: 'tool', item: tool })}
                          >
                            <code>{tool.name}</code><ChevronRight className="settings-row-link-indicator" aria-hidden="true" />
                          </button>
                          <p>{tool.description}</p>
                        </div>
                        <button
                          type="button"
                          role="switch"
                          className={`switch ${enabled ? 'is-on' : ''}`}
                          aria-checked={enabled}
                          aria-label={`${enabled ? '禁用' : '允许'}工具 ${tool.name}`}
                          onClick={() => toggleTool(tool.name, !enabled)}
                        ><span /></button>
                      </li>;
                    })}
                    {group.commands.map(command => <li className="agent-tool-row" key={`command:${command.name}`}>
                      <div>
                        <button
                          type="button"
                          className="agent-tool-open settings-row-link"
                          aria-label={`查看扩展命令 ${command.name} 详情`}
                          onClick={() => setDetail({ kind: 'command', item: command })}
                        >
                          <code>/{command.name}</code><ChevronRight className="settings-row-link-indicator" aria-hidden="true" />
                        </button>
                        <p>{command.description}</p>
                      </div>
                      <small>随扩展策略启停</small>
                    </li>)}
                  </ul>}
                </div>
              </section>;
            })}
            {!groups.length && <p className="agent-tool-empty" role="status">{searching ? '没有匹配的工具或命令。' : '当前工作区没有检测到可配置工具。'}</p>}
          </div>}

          <Accordion
            className="tool-profile-rules-disclosure"
            summary="通配符与手动规则"
            badge={[wildcardRules.length > 0 && `${wildcardRules.length} 条通配`, unavailable.length > 0 && `${unavailable.length} 暂未发现`].filter(Boolean).join(' · ') || '可选'}
          >
            <div className="agent-tool-rules-body">
              {wildcardRules.length > 0 && <section aria-label="批量工具规则">
                <h4>通配规则</h4>
                <ul className="agent-tool-rule-list">
                  {wildcardRules.map(name => <li key={name}>
                    <div><code>{name}</code>{catalog && <p>匹配 {localTools.filter(tool => patternMatches(name, tool.name)).length} 个工具</p>}</div>
                    <button
                      type="button"
                      className="icon-button"
                      aria-label={`移除工具规则 ${name}`}
                      onClick={() => updateEnabled(draft.enabled.filter(item => item !== name))}
                    ><Trash2 /></button>
                  </li>)}
                </ul>
              </section>}
              {unavailable.length > 0 && <section aria-label="当前未检测到的工具">
                <h4>暂未发现</h4>
                <ul className="agent-tool-rule-list">
                  {unavailable.map(name => {
                    const src = toolSource({ enabled: draft.enabled, sources: draft.sources }, name);
                    return <li key={name}>
                      <div><code>{name}</code><p>{src.label} · {src.source}</p></div>
                      <button type="button" className="icon-button" aria-label={`移除不可用工具 ${name}`} onClick={() => toggleTool(name, false)}><Trash2 /></button>
                    </li>;
                  })}
                </ul>
              </section>}
              <div className="agent-tool-custom">
                <label htmlFor="tool-profile-custom-name">手动添加</label>
                <div className="agent-tool-custom-control">
                  <input
                    id="tool-profile-custom-name"
                    value={customName}
                    placeholder="工具名或通配符，例如 browser_*"
                    onChange={event => setCustomName(event.target.value)}
                    onKeyDown={event => {
                      if (event.key === 'Enter' && !isComposingKey(event.nativeEvent)) {
                        event.preventDefault();
                        addCustomTool();
                      }
                    }}
                  />
                  <button type="button" className="settings-outline" disabled={!customName.trim()} onClick={addCustomTool}>添加</button>
                </div>
              </div>
            </div>
          </Accordion>
        </section>
      </div>
    </SettingsDialog>

    {detail && <DetailDialog className="agent-tool-detail-dialog" onClose={() => setDetail(null)}>
      <header className="detail-header">
        <div className="detail-heading">
          <span className="detail-icon" aria-hidden="true">{detail.kind === 'tool' ? <Terminal /> : <Package />}</span>
          <h2><code>{detail.kind === 'command' ? `/${detail.item.name}` : detail.item.name}</code></h2>
          <p>{detail.item.description}</p>
        </div>
        <button className="icon-button" aria-label="关闭详情" title="关闭" onClick={() => setDetail(null)}><X /></button>
      </header>
      <div className="detail-body agent-tool-detail-body">
        <div className={`agent-tool-detail-state ${detailEnabled ? 'is-enabled' : ''}`}>
          {detail.kind === 'command' ? <Package aria-hidden="true" /> : detailEnabled ? <Check aria-hidden="true" /> : <CircleAlert aria-hidden="true" />}
          <strong>{detail.kind === 'command' ? '随扩展启停' : detailEnabled ? '已启用' : '已停用'}</strong>
        </div>
        {detail.item.originalDescription && <Accordion className="agent-tool-original" compact summary="查看作者原文">
          <p dir="auto">{detail.item.originalDescription}</p>
        </Accordion>}
        <dl className="detail-list">
          <div><dt>类型</dt><dd>{detail.kind === 'tool' ? '智能体工具' : '扩展命令'}</dd></div>
          {detail.item.source.baseDir && detail.item.source.baseDir !== detail.item.source.path && <div><dt>来源目录</dt><dd><code>{detail.item.source.baseDir}</code></dd></div>}
          {detail.kind === 'tool' && <div><dt>提供方式</dt><dd>{exposureLabel(detail.item.exposure)}</dd></div>}
          <div><dt>来源</dt><dd>{detail.item.source.label}</dd></div>
          <div><dt>来源类型</dt><dd>{SOURCE_KIND_LABEL[detail.item.source.kind]}</dd></div>
          <div><dt>范围</dt><dd>{scopeLabel(detail.item.source.scope)}</dd></div>
          <div><dt>标识</dt><dd><code>{detail.item.source.source || '未知'}</code></dd></div>
          <div><dt>路径</dt><dd>{detail.item.source.path ? <code>{detail.item.source.path}</code> : '—'}</dd></div>
        </dl>
      </div>
      <footer className="detail-footer">
        <span />
        <button className="settings-outline" onClick={() => setDetail(null)}>关闭</button>
        {detail.kind === 'tool' && <button className="settings-save" onClick={() => toggleTool(detail.item.name, !detailEnabled)}>
          {detailEnabled ? <X /> : <Check />}{detailEnabled ? '从草稿移除' : '加入草稿'}
        </button>}
      </footer>
    </DetailDialog>}
    {confirmation.dialog}
  </>;
}
