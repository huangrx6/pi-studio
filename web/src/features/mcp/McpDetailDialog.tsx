import { Accordion } from '../../shared/Accordion';
import { useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import type { SettingsSnapshot } from '../../types/global.d';
import type { CommittedProjection } from '../../types/mutation-types';
import { errorText } from '../../shared/error-text';
import { DetailDialog } from '../../shared/DetailDialog';
import { SettingsToast, useSettingsToast } from '../../shared/SettingsToast';
import { mcpConnectionStatus } from './mcp-status';
import './styles/mcp-detail.css';

type McpServer = {
  name: string; transport: string; enabled: boolean; target: string; cwd: string;
  description: string; exposure: 'direct' | 'deferred' | 'hidden'; timeoutSeconds: number;
  envKeys: string[]; headerKeys: string[]; oauthConnected: boolean; connected: boolean;
  toolCount: number; error: string; stderr: string;
  tools: SettingsSnapshot['mcp'][number]['tools'];
};
type Props = {
  server: McpServer;
  workspace: string;
  onClose: () => void;
  /** Read only. Reject on failure; parent must not reopen a closed/replaced detail. */
  onRefresh: () => Promise<void>;
  /** Commit notice only: may arrive after this detail has closed. */
  onCommitted?: (result: CommittedProjection<SettingsSnapshot>, cwd: string, summary: string) => void;
  onRecovered?: (snapshot: SettingsSnapshot, cwd: string) => void;
};
type Operation = 'refresh' | 'method';
function exposureLabel(exposure: string) {
  return exposure === 'deferred' ? '按需加载' : exposure === 'direct' ? '直接加载' : '仅内部调用';
}

export function McpDetailDialog(props: Props) {
  const { server, workspace } = props;
  return <McpDetailScope key={JSON.stringify([server.name, server.transport, server.target, server.cwd, workspace])} {...props} />;
}

function McpDetailScope({ server, workspace, onClose, onRefresh, onCommitted, onRecovered }: Props) {
  const showToast = useSettingsToast();
  const status = mcpConnectionStatus(server);
  const registeredTools = Array.isArray(server.tools) ? server.tools : [];
  const live = useRef(true);
  const locked = useRef(false);
  const recoveryPending = useRef(false);
  const recoverySummary = useRef('');
  const runtimeRefreshNeeded = useRef(false);
  const recoveredSnapshot = useRef<SettingsSnapshot | null>(null);
  const [operation, setOperation] = useState<Operation | null>(null);
  const [refreshError, setRefreshError] = useState('');
  const [toolsOpen, setToolsOpen] = useState(status.state === 'connected' && registeredTools.length > 0 && registeredTools.length <= 5);
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false);
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);

  const begin = (kind: Operation) => {
    if (!live.current || locked.current || (recoveryPending.current && kind !== 'refresh')) return false;
    locked.current = true;
    setOperation(kind);
    return true;
  };
  const finish = () => {
    locked.current = false;
    if (live.current) setOperation(null);
  };
  const close = () => { live.current = false; onClose(); };

  async function refreshDetails(message = 'MCP 详情已刷新') {
    try {
      if (runtimeRefreshNeeded.current) {
        recoveredSnapshot.current = await window.piApi.refreshMcp(workspace);
        runtimeRefreshNeeded.current = false;
        if (!live.current) return;
      }
      await onRefresh();
      if (!live.current) return;
      if (recoveredSnapshot.current) onRecovered?.(recoveredSnapshot.current, workspace);
      recoveryPending.current = false;
      setRefreshError('');
      showToast(message);
    } catch (cause) {
      if (live.current) setRefreshError(errorText(cause));
    }
  }
  async function retryRefresh() {
    if (!begin('refresh')) return;
    try { await refreshDetails(); } finally { finish(); }
  }
  async function projectChange(result: CommittedProjection<SettingsSnapshot>, summary: string) {
    recoveryPending.current = true;
    recoverySummary.current = summary;
    runtimeRefreshNeeded.current = result.projection.status === 'error';
    recoveredSnapshot.current = result.projection.status === 'ready' ? result.projection.value : null;
    // Report a committed write even if the dialog has closed during the request.
    try { onCommitted?.(result, workspace, summary); } catch {
      if (live.current) setRefreshError('页面状态更新未完成，请重试刷新。');
      return;
    }
    if (!live.current) return;
    if (result.projection.status === 'error') {
      setRefreshError(result.projection.message);
      return;
    }
    await refreshDetails(summary);
  }
  async function changeMethod(method: string, enabled: boolean) {
    if (!begin('method')) return;
    try {
      const result = await window.piApi.setMcpMethodEnabled({ server: server.name, method, enabled, cwd: workspace });
      await projectChange(result, `已${enabled ? '启用' : '停用'} ${method}`);
    } catch (cause) {
      if (live.current) showToast(errorText(cause), 'error');
    } finally { finish(); }
  }

  const busy = operation !== null;
  const writeDisabled = busy || Boolean(refreshError);
  const envKeys = Array.isArray(server.envKeys) ? server.envKeys : [];
  const headerKeys = Array.isArray(server.headerKeys) ? server.headerKeys : [];
  const stderr = server.stderr;

  return <DetailDialog className="mcp-detail-dialog" onClose={close}>
    <header className="detail-header">
      <div className="detail-heading">
        <div>
          <div className="mcp-detail-title-line">
            <h2>{server.name}</h2>
            <span className="mcp-detail-status" data-state={status.state}>{status.label}</span>
          </div>
          <p>{server.transport === 'stdio' ? '本地进程 · stdio' : 'HTTP 服务 · Streamable HTTP'} · 全局共享</p>
        </div>
      </div>
      <button type="button" className="icon-button" aria-label="关闭 MCP 详情" onClick={close}><X /></button>
    </header>
    <div className="mcp-detail-body">
      <div className="mcp-detail-target"><span>目标</span><code>{server.target}</code></div>
      {server.description && <p className="mcp-detail-description">{server.description}</p>}
      {refreshError && <SettingsToast tone="error" message={`${recoverySummary.current} 详情刷新失败。${refreshError}`}>
        <button type="button" className="text-button" disabled={busy} onClick={() => void retryRefresh()}>{operation === 'refresh' ? '正在刷新…' : '重试刷新'}</button>
      </SettingsToast>}
      {server.error && <p className="mcp-detail-feedback is-error">{server.error}</p>}
      <Accordion className="mcp-detail-section" summary="连接参数">
        <dl className="mcp-detail-facts">
          <div><dt>作用域</dt><dd>全局 · 所有工作区使用同一份连接配置</dd></div>
          {server.transport === 'stdio' && <div><dt>工作目录</dt><dd><code>{server.cwd || 'Studio 应用数据目录'}</code></dd></div>}
          <div><dt>工具暴露</dt><dd>{server.exposure === 'deferred' ? '按需搜索 · tool_search' : server.exposure === 'direct' ? '直接提供' : '不提供给模型'}</dd></div>
          <div><dt>请求超时</dt><dd>{server.timeoutSeconds || 60} 秒</dd></div>
          <div><dt>凭据名称</dt><dd>{(server.transport === 'stdio' ? envKeys : headerKeys).join('、') || '无'} <span>值始终隐藏</span></dd></div>
          {server.transport === 'http' && <div><dt>OAuth</dt><dd>{server.oauthConnected ? '已授权' : '未授权'}</dd></div>}
        </dl>
      </Accordion>
      <Accordion className="mcp-detail-section" open={toolsOpen} onToggle={event => setToolsOpen(event.currentTarget.open)} summary="工具" badge={registeredTools.length}>
        {toolsOpen && <>
          <p>{registeredTools.length ? '方法开关自动保存，从下一次请求起生效。' : '启用服务器并连接后，可在此查看并切换各方法开关。'}</p>
          {registeredTools.length ? <div className="mcp-detail-tools">
            {registeredTools.map(tool => <div key={tool.name}>
              <div className="mcp-method-copy"><code>{tool.originalName}</code>
                {tool.description && <p>{tool.description}</p>}
                <small>{exposureLabel(tool.exposure)}</small></div>
              {'enabled' in tool && <button type="button" role="switch" aria-label={`启用 MCP 方法 ${tool.originalName}`}
                aria-checked={tool.enabled} className={`switch ${tool.enabled ? 'is-on' : ''}`} disabled={writeDisabled}
                onClick={() => void changeMethod(tool.originalName, !tool.enabled)}><span /></button>}
            </div>)}
          </div> : <p>当前没有可列出的工具。</p>}
        </>}
      </Accordion>
      {stderr && <Accordion className="mcp-detail-section" open={diagnosticsOpen} onToggle={event => setDiagnosticsOpen(event.currentTarget.open)} summary="诊断信息">
        {diagnosticsOpen && <><p>凭据和已保存的 Header 值已脱敏。</p><pre className="mcp-stderr">{stderr}</pre></>}
      </Accordion>}
    </div>
    <footer className="detail-footer"><span /><button type="button" className="settings-outline" onClick={close}>关闭</button></footer>
  </DetailDialog>;
}
