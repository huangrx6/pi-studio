import { useCallback, useEffect, useRef, useState } from 'react';
import { Check, Plus, RotateCw } from 'lucide-react';
import { Accordion } from '../../shared/Accordion';
import { errorText } from '../../shared/error-text';
import { LoadingIndicator, LoadingState } from '../../shared/LoadingState';
import { runtimeRefreshFailure } from '../../shared/runtime-refresh';
import { SettingsPageHeader } from '../../shared/SettingsPageHeader';
import { automaticProfileIcon, SettingsProfileMark } from '../../shared/SettingsProfileIcon';
import { SettingsProfileCard, SettingsProfileLibrary } from '../../shared/SettingsProfileLibrary';
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

const EXTENSION_MODE_SUMMARY: Record<AgentToolExtensionMode, string> = {
  'all-enabled': '全部已启用扩展',
  'safe-only': '仅安全扩展',
  none: '禁用扩展',
};

const MCP_MODE_SUMMARY: Record<AgentToolMcpMode, string> = {
  'follow-server': '跟随全局 MCP',
  picked: '指定 MCP',
  none: '禁用 MCP',
};

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
}: {
  cwd: string;
  initialProfiles?: ToolProfilesSnapshot;
  mcpServers?: Array<{ name: string; enabled: boolean }>;
  onOpenMcp: () => void;
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

  return <div className="settings-preference-page agent-tools-settings">
    <SettingsPageHeader
      title="智能体工具"
      iconPosition="end"
      meta="管理可复用的工具方案，控制主对话、临时对话与子智能体可调用的工具、用户扩展和 MCP 服务。"
      icon={<svg viewBox="0 0 32 32" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M2 11h28v16H2zM11 11V7.5A2.5 2.5 0 0 1 13.5 5h5A2.5 2.5 0 0 1 21 7.5V11M2 17h11m6 0h11" />
        <rect x="13" y="15" width="6" height="5" rx="1" stroke="var(--accent)" />
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
      {loadingProfiles && !snapshot && <LoadingState variant="section">正在读取工具方案…</LoadingState>}
      {loadError && <div className="settings-preference-card harness-load-error">
        <p role="alert">{loadError}</p>
        <button type="button" className="settings-outline" onClick={() => void loadProfiles()}>重新加载工具方案</button>
      </div>}
      {ready && snapshot && <div className="settings-profile-grid">
        {snapshot.profiles.map(profile => {
          const isMain = profile.id === snapshot.mainProfileId;
          const isWorkspace = Boolean(cwd) && profile.id === snapshot.workspaceProfileId;
          const isWorkspaceInherited = Boolean(cwd) && isMain && !snapshot.workspaceProfileId;
          const isTemporary = profile.id === snapshot.temporaryProfileId;
          const binding = [
            isMain && '主对话默认',
            isWorkspace && '当前工作区使用',
            isWorkspaceInherited && '当前工作区继承',
            isTemporary && '临时对话使用',
          ].filter(Boolean).join(' · ');

          const mcpSummary = profile.mcpMode === 'picked'
            ? `指定 ${profile.mcpServers.length} 个 MCP`
            : MCP_MODE_SUMMARY[profile.mcpMode];

          return <SettingsProfileCard
            key={profile.id}
            name={profile.name}
            icon={<SettingsProfileMark group="tools" icon={profile.icon ?? automaticProfileIcon('tools', profile.id)} />}
            subtitle={(profile.builtin ? '内置 · ' : '') + profile.id}
            description={(binding || profile.description) && <span className="tool-card-meta">
              {binding && <span className="harness-binding"><Check aria-hidden="true" />{binding}</span>}
              {profile.description && <span className="tool-card-desc">{profile.description}</span>}
            </span>}
            summary={[
              `${profile.enabled.length} 项工具`,
              EXTENSION_MODE_SUMMARY[profile.extensionMode],
              mcpSummary,
            ].join(' · ')}
            onEdit={() => setEditor({ kind: 'edit', source: profile })}
          />;
        })}
      </div>}
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
