import type { ComponentProps, Dispatch, MutableRefObject, ReactNode, RefObject, SetStateAction } from 'react';
import { Keyboard, X } from 'lucide-react';
import { ExtensionDetailDialog } from '../features/extensions/ExtensionDetailDialog';
import { ExtensionInstallDialog } from '../features/extensions/ExtensionInstallDialog';
import { McpDetailDialog } from '../features/mcp/McpDetailDialog';
import { SkillDetailDialog } from '../features/skills/SkillDetailDialog';
import { UpdateDialog } from '../features/update/UpdateDialog';
import type { ExtensionHostItem, ExtensionInstallPreview } from '../types/extension-types';
import type { ConfirmRequest } from '../shared/ConfirmDialog';
import { FullPermissionDialog, ToolConfirmDialog } from '../shared/ConfirmDialog';
import { DetailDialog } from '../shared/DetailDialog';
import type { McpInfo, SkillInfo } from './app-types';
import type { useAppSettingsController } from './useAppSettings';

type SettingsController = ReturnType<typeof useAppSettingsController>;

export type AppDialogsProps = {
  confirmation: {
    actionDialog: ReactNode;
    settingsLeaveDialog: ReactNode;
    request: ConfirmRequest | null;
    setRequest: Dispatch<SetStateAction<ConfirmRequest | null>>;
    fullPermissionOpen: boolean;
    fullPermissionAck: boolean;
    setFullPermissionAck: (acknowledged: boolean) => void;
    setFullPermissionOpen: (open: boolean) => void;
    applyPermission: (mode: 'full') => Promise<void>;
  };
  extensions: {
    detail: ExtensionHostItem | null;
    setDetail: (item: ExtensionHostItem | null) => void;
    busy: boolean;
    installerOpen: boolean;
    installPreview: ExtensionInstallPreview | null;
    setInstallerOpen: (open: boolean) => void;
    setInstallPreview: (preview: ExtensionInstallPreview | null) => void;
    workspace: string;
    workspaceName?: string;
    registryUrl: string;
  };
  updates: {
    open: boolean;
    snapshot: ComponentProps<typeof UpdateDialog>['snapshot'];
    close: () => void;
    check: () => Promise<void>;
    download: () => Promise<void>;
    install: () => Promise<void>;
  };
  mcp: {
    server: McpInfo | null;
    close: () => void;
    workspace: string;
    ownerGeneration: number;
    ownerGenerationRef: MutableRefObject<number>;
    workspaceRef: RefObject<string>;
    recoveryRef: MutableRefObject<{ cwd: string; request: number; generation: number } | null>;
    requestRef: MutableRefObject<number>;
    pendingRef: MutableRefObject<{ mcp: boolean }>;
    setSummary: (summary: string) => void;
    setError: (error: string | null) => void;
  };
  skills: {
    detail: SkillInfo | null;
    busy: boolean;
    error: string | null;
    refreshing: boolean;
    onRefresh: (() => void) | undefined;
    onClose: () => void;
    onTrust: (skill: SkillInfo, trusted: boolean) => void;
  };
  shortcuts: {
    open: boolean;
    close: () => void;
  };
  controller: SettingsController;
};

/**
 * Global dialogs sit above every workspace view. Keeping them together makes
 * ownership of confirmations, transient detail views and update progress clear.
 */
export function AppDialogs({
  confirmation,
  extensions,
  updates,
  mcp,
  skills,
  shortcuts,
  controller,
}: AppDialogsProps) {
  return (
    <>
      {confirmation.actionDialog}
      {confirmation.settingsLeaveDialog}
      {confirmation.request && <ToolConfirmDialog
        request={confirmation.request}
        onRespond={(response) => {
          const id = confirmation.request!.id;
          confirmation.setRequest(null);
          window.piApi.confirmResponse({ id, ...response });
        }}
      />}
      {confirmation.fullPermissionOpen && <FullPermissionDialog
        acknowledged={confirmation.fullPermissionAck}
        onAcknowledgedChange={confirmation.setFullPermissionAck}
        onCancel={() => confirmation.setFullPermissionOpen(false)}
        onConfirm={() => {
          confirmation.setFullPermissionOpen(false);
          void confirmation.applyPermission('full');
        }}
      />}
      {extensions.detail && <ExtensionDetailDialog
        item={extensions.detail}
        busy={extensions.busy}
        onClose={() => extensions.setDetail(null)}
        onRollback={(item) => {
          extensions.setDetail(null);
          void controller.rollbackExtension(item);
        }}
        onTrust={(item, trusted) => {
          extensions.setDetail(null);
          void controller.trustExtension(item, trusted);
        }}
      />}
      {extensions.installerOpen && <ExtensionInstallDialog
        cwd={extensions.workspace}
        workspaceName={extensions.workspaceName}
        registryUrl={extensions.registryUrl}
        initialPreview={extensions.installPreview}
        onClose={() => {
          extensions.setInstallerOpen(false);
          extensions.setInstallPreview(null);
        }}
        onInstalled={(result) => {
          if (result.projection.status !== 'ready') throw new Error(result.projection.message);
          controller.acceptRuntimeSnapshot(
            result.projection.value,
            `扩展 v${result.installed.version} 已安装，并从下一轮请求开始生效。`,
          );
          void controller.loadOfficialExtensions();
        }}
      />}
      {updates.open && <UpdateDialog
        snapshot={updates.snapshot}
        onClose={updates.close}
        onCheck={updates.check}
        onDownload={updates.download}
        onInstall={updates.install}
      />}
      {mcp.server && <McpDetailDialog
        server={mcp.server}
        workspace={mcp.workspace}
        onClose={mcp.close}
        onCommitted={(_result, cwd) => {
          controller.invalidateResourceReads();
          mcp.recoveryRef.current = {
            cwd,
            request: mcp.requestRef.current,
            generation: mcp.ownerGeneration,
          };
          mcp.pendingRef.current.mcp = true;
          mcp.setSummary('MCP 授权状态已更新');
          mcp.setError('请刷新当前 MCP 状态。');
        }}
        onRecovered={(_snapshot, cwd) => {
          const owner = mcp.recoveryRef.current;
          if (!owner || owner.cwd !== cwd || cwd !== mcp.workspaceRef.current
            || owner.request !== mcp.requestRef.current
            || owner.generation !== mcp.ownerGenerationRef.current) return;
          mcp.recoveryRef.current = null;
          mcp.pendingRef.current.mcp = false;
          mcp.setError(null);
        }}
        onRefresh={async () => {
          const applied = await controller.refreshMcpDetail(
            mcp.server!.name,
            mcp.ownerGeneration,
            mcp.workspace,
          );
          if (!applied) throw new Error('页面状态已变化，请重试刷新。');
        }}
      />}
      {skills.detail && <SkillDetailDialog
        key={`${skills.detail.path}:${skills.detail.baseDir}`}
        skill={skills.detail}
        busy={skills.busy}
        error={skills.error}
        refreshing={skills.refreshing}
        onRefresh={skills.onRefresh}
        onClose={skills.onClose}
        onTrust={skills.onTrust}
      />}
      {shortcuts.open && <DetailDialog className="shortcuts-dialog" onClose={shortcuts.close}>
        <header className="detail-header"><div className="detail-heading"><span className="detail-icon"><Keyboard /></span><div><h2>快捷键</h2></div></div><button className="icon-button" aria-label="关闭快捷键" onClick={shortcuts.close}><X /></button></header>
        <div className="shortcut-list">
          {[['发送消息 / 补充当前任务', 'Enter'], ['排队下一条消息', 'Cmd/Ctrl + Enter'], ['换行', 'Shift + Enter'], ['打开命令与技能', '/'], ['引用工作区文件', '@'], ['关闭浮层', 'Esc'], ['打开设置', 'Cmd + ,']].map(([label, key]) => <div className="shortcut-row" key={label}><span>{label}</span><kbd>{key}</kbd></div>)}
        </div>
        <footer className="detail-footer"><span /><button className="settings-outline" onClick={shortcuts.close}>关闭</button></footer>
      </DetailDialog>}
    </>
  );
}
