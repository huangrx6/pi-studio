import { useCallback, useEffect, useRef, useState } from 'react';
import { Plus, RotateCw } from 'lucide-react';
import { Accordion } from '../../shared/Accordion';
import { errorText } from '../../shared/error-text';
import { LoadingIndicator, LoadingState } from '../../shared/LoadingState';
import { useDeferredEnter } from '../../shared/useDeferredEnter';
import { runtimeRefreshFailure } from '../../shared/runtime-refresh';
import { SettingsPageHeader } from '../../shared/SettingsPageHeader';
import { automaticProfileIcon } from '../../shared/profile-icon';
import { SettingsProfileLibrary } from '../../shared/SettingsProfileLibrary';
import { useSettingsToast } from '../../shared/SettingsToast';
import type { ModalDismiss } from '../../shared/useModalDialog';
import type {
  AgentToolCatalog,
  AgentToolExtensionMode,
  AgentToolMcpMode,
  AgentToolProfile,
  AgentToolProfilePatch,
  AgentToolSelection,
  TemporaryCapabilitiesSnapshot,
  ToolProfilesSnapshot,
} from '../../types/agent-tool-types';
import { ToolProfileEditor, type ToolProfileBindingScope } from './ToolProfileEditor';
import './styles/agent-tools-settings.css';

const EXTENSION_MODE_LABEL: Record<AgentToolExtensionMode, string> = {
  'all-enabled': '全部已启用',
  'safe-only': '仅安全扩展',
  none: '已禁用',
};

const CORE_CODE_TOOLS = new Set(['read', 'write', 'edit', 'bash', 'grep', 'find', 'ls']);

function profileChannels(profile: AgentToolProfile) {
  const codeCount = profile.enabled.filter(name => CORE_CODE_TOOLS.has(name)).length;
  const browserCount = profile.enabled.filter(name => name.startsWith('browser_')).length;
  const desktopCount = profile.enabled.filter(name => name.startsWith('desktop_')).length;
  const hasSubagent = profile.enabled.includes('subagent');
  const mcpLabel = profile.mcpMode === 'none'
    ? '已禁用'
    : profile.mcpMode === 'picked'
      ? `指定 ${profile.mcpServers.length} 个`
      : '跟随全局';
  return {
    channels: [
      { key: 'code', label: '编码与文件', active: codeCount > 0, value: codeCount > 0 ? `${codeCount} 项` : '关闭' },
      { key: 'browser', label: '浏览器', active: browserCount > 0, value: browserCount > 0 ? `${browserCount} 项` : '关闭' },
      { key: 'desktop', label: '电脑操控', active: desktopCount > 0, value: desktopCount > 0 ? `${desktopCount} 项` : '关闭' },
      { key: 'subagent', label: '子智能体', active: hasSubagent, value: hasSubagent ? '已开启' : '关闭' },
    ],
    extLabel: EXTENSION_MODE_LABEL[profile.extensionMode],
    mcpLabel,
  };
}

type EditorState = {
  kind: 'create' | 'edit';
  source: AgentToolProfile;
};

export function AgentToolsSettings({
  cwd,
  initialProfiles,
  mcpServers = [],
  onSaved,
  onOpenMcp,
  onOpenExtensions,
}: {
  cwd: string;
  initialProfiles?: ToolProfilesSnapshot;
  mcpServers?: Array<{ name: string; enabled: boolean }>;
  onOpenMcp: () => void;
  onOpenExtensions?: () => void;
  onSaved?: (snapshot: {
    agentTools?: AgentToolSelection;
    toolProfiles: ToolProfilesSnapshot;
    temporaryCapabilities?: TemporaryCapabilitiesSnapshot;
  }) => void;
}) {
  const showToast = useSettingsToast();
  const [snapshot, setSnapshot] = useState<ToolProfilesSnapshot | undefined>(initialProfiles);
  const [loadingProfiles, setLoadingProfiles] = useState(!initialProfiles);
  const [loadError, setLoadError] = useState('');
  const [catalog, setCatalog] = useState<AgentToolCatalog | null>(null);
  const [catalogLoading, setCatalogLoading] = useState(true);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [editor, setEditor] = useState<EditorState | null>(null);
  const requestRef = useRef(0);
  const catalogReqRef = useRef(0);
  const cwdRef = useRef(cwd);
  cwdRef.current = cwd;
  const savedRef = useRef(onSaved);
  savedRef.current = onSaved;

  useEffect(() => {
    if (initialProfiles) setSnapshot(initialProfiles);
  }, [initialProfiles]);

  const loadProfiles = useCallback(async () => {
    const ticket = ++requestRef.current;
    setLoadingProfiles(true);
    setLoadError('');
    try {
      const next = await window.piApi.toolProfiles(cwd);
      if (ticket === requestRef.current && cwd === cwdRef.current) setSnapshot(next);
    } catch (cause) {
      if (ticket === requestRef.current && cwd === cwdRef.current) setLoadError(errorText(cause));
    } finally {
      if (ticket === requestRef.current && cwd === cwdRef.current) setLoadingProfiles(false);
    }
  }, [cwd]);

  const loadCatalog = useCallback(async (refresh = false) => {
    const ticket = ++catalogReqRef.current;
    setCatalogLoading(true);
    setCatalogError(null);
    try {
      const next = await window.piApi.agentToolCatalog({ cwd, refresh });
      if (ticket === catalogReqRef.current && cwd === cwdRef.current) setCatalog(next);
    } catch (cause) {
      if (ticket === catalogReqRef.current && cwd === cwdRef.current) setCatalogError(errorText(cause));
    } finally {
      if (ticket === catalogReqRef.current && cwd === cwdRef.current) setCatalogLoading(false);
    }
  }, [cwd]);

  useEffect(() => {
    void loadProfiles();
    void loadCatalog(true);
    return () => {
      requestRef.current += 1;
      catalogReqRef.current += 1;
    };
  }, [loadProfiles, loadCatalog]);

  function acceptResult(result: {
    toolProfiles: ToolProfilesSnapshot;
    temporaryCapabilities?: TemporaryCapabilitiesSnapshot;
    runtimeRefresh?: import('../../types/runtime-types').RuntimeRefreshSnapshot;
  }) {
    setSnapshot(result.toolProfiles);
    const activeMain = result.toolProfiles.profiles.find(
      item => item.id === result.toolProfiles.activeMainProfileId,
    );
    savedRef.current?.({
      agentTools: activeMain ? { enabled: activeMain.enabled, sources: activeMain.sources } : undefined,
      toolProfiles: result.toolProfiles,
      temporaryCapabilities: result.temporaryCapabilities,
    });
    return runtimeRefreshFailure(result.runtimeRefresh);
  }

  async function handleSave(
    payload: { mode: 'create' | 'edit'; profile: AgentToolProfilePatch },
    dismiss: ModalDismiss,
  ) {
    setBusy(true);
    try {
      const result = await window.piApi.saveToolProfile({ cwd, ...payload });
      const warning = acceptResult(result);
      await dismiss(() => setEditor(null));
      showToast(
        (payload.mode === 'create' ? '工具方案已创建。' : '工具方案已保存。') + (warning || ''),
        warning ? 'error' : 'success',
      );
      if (payload.profile.enabled !== undefined) void loadCatalog(true);
    } catch (cause) {
      showToast(errorText(cause), 'error');
    } finally {
      setBusy(false);
    }
  }

  async function handleApply(id: string, scope: ToolProfileBindingScope) {
    setBusy(true);
    try {
      const result = await window.piApi.selectToolProfile({ cwd, id, scope });
      const warning = acceptResult(result);
      const label = scope === 'global'
        ? '已设为主对话全局默认方案。'
        : scope === 'inherit'
          ? '当前工作区已恢复继承全局主对话方案。'
          : scope === 'temporary'
            ? '已设为临时对话默认工具方案。'
            : '已应用到当前工作区。';
      showToast(label + (warning || ''), warning ? 'error' : 'success');
    } catch (cause) {
      showToast(errorText(cause), 'error');
    } finally {
      setBusy(false);
    }
  }

  async function handleReset(id: string, dismiss: ModalDismiss) {
    setBusy(true);
    try {
      const result = await window.piApi.resetToolProfile({ cwd, id });
      const warning = acceptResult(result);
      await dismiss(() => setEditor(null));
      showToast('已恢复工具方案默认值。' + (warning || ''), warning ? 'error' : 'success');
    } catch (cause) {
      showToast(errorText(cause), 'error');
    } finally {
      setBusy(false);
    }
  }

  async function handleDelete(id: string, dismiss: ModalDismiss) {
    setBusy(true);
    try {
      const result = await window.piApi.deleteToolProfile({ cwd, id });
      const warning = acceptResult(result);
      await dismiss(() => setEditor(null));
      showToast('工具方案已删除。' + (warning || ''), warning ? 'error' : 'success');
    } catch (cause) {
      showToast(errorText(cause), 'error');
    } finally {
      setBusy(false);
    }
  }

  function createProfile() {
    if (!snapshot) return;
    const base = snapshot.profiles.find(item => item.id === snapshot.activeMainProfileId)
      ?? snapshot.profiles[0]
      ?? {
        id: 'tools-custom',
        name: '自定义工具方案',
        description: '',
        enabled: [],
        sources: {},
        extensionMode: 'all-enabled' as AgentToolExtensionMode,
        mcpMode: 'follow-server' as AgentToolMcpMode,
        mcpServers: [],
      };
    setEditor({ kind: 'create', source: { ...base, icon: null } });
  }

  const diagnostics = catalog
    ? [...catalog.errors.filter(item => !item.path?.startsWith('mcp:')), ...catalog.warnings]
    : [];
  const ready = Boolean(snapshot) && !loadError;
  const gridReveal = useDeferredEnter(ready);

  return <div className="settings-preference-page agent-tools-settings">
    <SettingsPageHeader
      title="智能体工具"
      iconPosition="end"
      meta="管理可复用的扩展工具与 MCP 能力方案。"
      icon={<svg viewBox="0 0 32 32" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M2 11h28v16H2zM11 11V7.5A2.5 2.5 0 0 1 13.5 5h5A2.5 2.5 0 0 1 21 7.5V11M2 17h11m6 0h11" />
        <rect x="13" y="15" width="6" height="5" rx="1" />
      </svg>}
    />

    <SettingsProfileLibrary
      title="工具方案"
      count={ready && snapshot ? snapshot.profiles.length : 0}
      actions={<>
        <button
          type="button"
          className="settings-outline"
          disabled={catalogLoading || busy}
          onClick={() => void loadCatalog(true)}
        >
          {catalogLoading ? <LoadingIndicator /> : <RotateCw aria-hidden="true" />}刷新目录
        </button>
        <button
          type="button"
          className="settings-save"
          aria-haspopup="dialog"
          disabled={!ready || busy}
          onClick={createProfile}
        >
          <Plus aria-hidden="true" />新建方案
        </button>
      </>}
    >
      {loadingProfiles && !snapshot && <div className="settings-loading-card"><LoadingState variant="section">正在读取工具方案…</LoadingState></div>}
      {loadError && <div className="settings-load-error">
        <p role="alert">{loadError}</p>
        <button type="button" className="settings-outline" onClick={() => void loadProfiles()}>重新加载工具方案</button>
      </div>}
      {ready && snapshot && (() => {
        const ordered = [...snapshot.profiles].sort((a, b) => {
          const rank = (p: AgentToolProfile) => (
            p.id === snapshot.activeMainProfileId ? 0
              : p.id === snapshot.mainProfileId ? 1
                : p.id === snapshot.temporaryProfileId ? 2
                  : 3
          );
          return rank(a) - rank(b);
        });

        return <div className={`tools-spec-grid${gridReveal ? ' settings-async-ready' : ''}`}>
          {ordered.map(profile => {
            const isMain = profile.id === snapshot.mainProfileId;
            const isWorkspace = Boolean(cwd) && profile.id === snapshot.workspaceProfileId;
            const isWorkspaceInherited = Boolean(cwd) && isMain && !snapshot.workspaceProfileId;
            const isTemporary = profile.id === snapshot.temporaryProfileId;
            const binding = [
              isMain && '主对话默认',
              isWorkspace && '当前工作区',
              isWorkspaceInherited && '工作区继承',
              isTemporary && '临时对话',
            ].filter(Boolean).join(' · ');
            const { channels, extLabel, mcpLabel } = profileChannels(profile);

            return <button
              key={profile.id}
              type="button"
              className={`settings-preference-card tools-spec-card${binding ? ' is-active' : ''}`}
              aria-label={'编辑' + profile.name}
              aria-haspopup="dialog"
              onClick={() => setEditor({ kind: 'edit', source: profile })}
            >
              <div className="tools-spec-top">
                {binding
                  ? <span className="tools-live-kicker"><i aria-hidden="true" />{binding}</span>
                  : <span className="tools-idle-kicker">备用方案</span>}
                <div className="tools-hero-metric" aria-label={`已启用 ${profile.enabled.length} 项工具`}>
                  <em>{profile.enabled.length}</em>
                  <span>项工具</span>
                </div>
              </div>

              <div className="tools-spec-identity">
                <strong>{profile.name}</strong>
                {profile.description && <p className="tools-spec-desc">{profile.description}</p>}
              </div>

              <div className="tools-channel-grid" aria-label="核心能力通道">
                {channels.map(ch => (
                  <div key={ch.key} className={`tools-channel-cell${ch.active ? ' is-on' : ''}`}>
                    <span className="tools-channel-name">
                      <i aria-hidden="true" />{ch.label}
                    </span>
                    <span className="tools-channel-val">{ch.value}</span>
                  </div>
                ))}
              </div>

              <div className="tools-spec-foot">
                <div className="tools-policy-pairs">
                  <span><em>扩展</em> {extLabel}</span>
                  <span><em>MCP</em> {mcpLabel}</span>
                </div>
              </div>
            </button>;
          })}
        </div>;
      })()}
    </SettingsProfileLibrary>

    {diagnostics.length > 0 && <div className="settings-preference-groups agent-tools-extras">
      <Accordion className="settings-preference-card agent-tool-diagnostics" summary="扩展诊断" badge={diagnostics.length}>
        {diagnostics.map((item, index) => (
          <div className="agent-tool-diagnostic" key={index}>
            <code>{item.path || '扩展加载'}</code>
            <p>{item.message}</p>
          </div>
        ))}
      </Accordion>
    </div>}

    {editor && snapshot && <ToolProfileEditor
      key={`${editor.kind}:${editor.source.id}`}
      creating={editor.kind === 'create'}
      source={editor.source}
      snapshot={snapshot}
      cwd={cwd}
      mcpServers={mcpServers}
      catalog={catalog}
      catalogLoading={catalogLoading}
      catalogError={catalogError}
      busy={busy}
      onReloadCatalog={() => void loadCatalog(true)}
      onOpenMcp={onOpenMcp}
      onOpenExtensions={onOpenExtensions}
      onSave={handleSave}
      onApply={handleApply}
      onReset={handleReset}
      onDelete={handleDelete}
      onCopy={source => setEditor({ kind: 'create',
        source: { ...source, icon: source.icon ?? automaticProfileIcon('tools', source.id) } })}
      onClose={() => setEditor(null)}
    />}
  </div>;
}
