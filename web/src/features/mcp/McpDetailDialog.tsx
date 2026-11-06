import { useEffect, useRef, useState } from 'react';
import { LoaderCircle, X } from 'lucide-react';
import type { McpConnectionTestResult, SettingsSnapshot } from '../../global.d';
import type { CommittedProjection } from '../../types/mutation-types';
import { errorText } from '../../shared/error-text';
import { DetailDialog } from '../../shared/DetailDialog';
import { mcpConnectionStatus } from './mcp-status';
import './mcp-detail.css';

type McpServer = {
  name: string; transport: string; enabled: boolean; target: string; cwd: string;
  description: string; exposure: 'direct' | 'deferred' | 'hidden'; timeoutSeconds: number;
  envKeys: string[]; headerKeys: string[]; oauthConnected: boolean; connected: boolean;
  toolCount: number; error: string; stderr: string;
  tools: Array<{ name: string; originalName: string; description: string; exposure: 'direct' | 'deferred' | 'hidden' }>;
};
type Props = {
  server: McpServer;
  workspace: string;
  onClose: () => void;
  /** Read only. Reject on failure; parent must not reopen a closed/replaced detail. */
  onRefresh: () => Promise<void>;
  /** Commit notice only: may arrive after this detail has closed. */
  onCommitted?: (result: CommittedProjection<SettingsSnapshot>, cwd: string) => void;
  onRecovered?: (snapshot: SettingsSnapshot, cwd: string) => void;
};
type Operation = 'test' | 'authorize' | 'logout' | 'refresh';
function exposureLabel(exposure: string) {
  return exposure === 'deferred' ? '按需加载' : exposure === 'direct' ? '直接加载' : '仅内部调用';
}

export function McpDetailDialog(props: Props) {
  const { server, workspace } = props;
  return <McpDetailScope key={JSON.stringify([server.name, server.transport, server.target, server.cwd, workspace])} {...props} />;
}

function McpDetailScope({ server, workspace, onClose, onRefresh, onCommitted, onRecovered }: Props) {
  const live = useRef(true);
  const locked = useRef(false);
  const recoveryPending = useRef(false);
  const runtimeRefreshNeeded = useRef(false);
  const recoveredSnapshot = useRef<SettingsSnapshot | null>(null);
  const [operation, setOperation] = useState<Operation | null>(null);
  const [testResult, setTestResult] = useState<McpConnectionTestResult | null>(null);
  const [actionError, setActionError] = useState('');
  const [actionMessage, setActionMessage] = useState('');
  const [refreshError, setRefreshError] = useState('');
  const [authorized, setAuthorized] = useState<boolean | null>(null);
  const [toolsOpen, setToolsOpen] = useState(false);
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false);
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);

  const begin = (kind: Operation) => {
    if (!live.current || locked.current || (recoveryPending.current && kind !== 'refresh')) return false;
    locked.current = true;
    setOperation(kind);
    setActionError('');
    return true;
  };
  const finish = () => {
    locked.current = false;
    if (live.current) setOperation(null);
  };
  const close = () => { live.current = false; onClose(); };

  async function refreshDetails() {
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
      setAuthorized(null);
    } catch (cause) {
      if (live.current) setRefreshError(errorText(cause));
    }
  }
  async function retryRefresh() {
    if (!begin('refresh')) return;
    try { await refreshDetails(); } finally { finish(); }
  }
  async function testConnection() {
    if (!begin('test')) return;
    setTestResult(null);
    setActionMessage('');
    try {
      const result = await window.piApi.testSavedMcp(server.name);
      if (live.current) setTestResult(result);
    } catch (cause) {
      if (live.current) setActionError(errorText(cause));
    } finally { finish(); }
  }
  async function changeOAuth(kind: 'authorize' | 'logout') {
    if (!begin(kind)) return;
    setActionMessage('');
    setTestResult(null);
    try {
      const result = kind === 'authorize'
        ? await window.piApi.startMcpOAuth(server.name, workspace)
        : await window.piApi.logoutMcpOAuth(server.name, workspace);
      recoveryPending.current = true;
      runtimeRefreshNeeded.current = result.projection.status === 'error';
      recoveredSnapshot.current = result.projection.status === 'ready' ? result.projection.value : null;
      // Reporting a committed credential change must survive closing this dialog.
      // This write has completed even if the following projection read fails.
      if (live.current) {
        setAuthorized(kind === 'authorize');
        setActionMessage(kind === 'authorize' ? 'OAuth 授权已完成。' : 'OAuth 凭据已清除。');
      }
      try { onCommitted?.(result, workspace); } catch {
        if (live.current) setRefreshError('页面状态更新未完成，请重试刷新。');
        return;
      }
      if (!live.current) return;
      if (result.projection.status === 'error') {
        setRefreshError(result.projection.message);
        return;
      }
      await refreshDetails();
    } catch (cause) {
      if (live.current) setActionError(errorText(cause));
    } finally { finish(); }
  }

  const status = mcpConnectionStatus(server);
  const busy = operation !== null;
  const writeDisabled = busy || Boolean(refreshError);
  const oauthConnected = authorized ?? server.oauthConnected;
  const testTools = Array.isArray(testResult?.tools) ? testResult.tools : [];
  const testResources = Array.isArray(testResult?.resources) ? testResult.resources : [];
  const tools = testResult?.ok ? testTools : Array.isArray(server.tools) ? server.tools : [];
  const envKeys = Array.isArray(server.envKeys) ? server.envKeys : [];
  const headerKeys = Array.isArray(server.headerKeys) ? server.headerKeys : [];
  const stderr = testResult?.stderr || server.stderr;

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
      <section className="mcp-detail-actions" aria-label="MCP 连接操作">
        <button type="button" className="settings-outline" disabled={writeDisabled} onClick={() => void testConnection()}>
          {operation === 'test' && <LoaderCircle className="spin" />}{operation === 'test' ? '正在测试…' : '测试连接'}
        </button>
        {server.transport === 'http' && (oauthConnected
          ? <button type="button" className="settings-outline" disabled={writeDisabled} onClick={() => void changeOAuth('logout')}>
              {operation === 'logout' && <LoaderCircle className="spin" />}{operation === 'logout' ? '正在退出…' : '退出 OAuth'}
            </button>
          : <button type="button" className="settings-outline" disabled={writeDisabled} onClick={() => void changeOAuth('authorize')}>
              {operation === 'authorize' && <LoaderCircle className="spin" />}{operation === 'authorize' ? '等待浏览器授权…' : 'OAuth 登录'}
            </button>)}
      </section>
      {actionError && <div className="mcp-detail-feedback is-error" role="alert">{actionError}</div>}
      {actionMessage && <div className="mcp-detail-feedback" role="status">{actionMessage}</div>}
      {refreshError && <div className="mcp-detail-feedback is-error" role="alert">
        <span>操作已完成，但详情刷新失败。{refreshError}</span>
        <button type="button" className="text-button" disabled={busy} onClick={() => void retryRefresh()}>{operation === 'refresh' ? '正在刷新…' : '重试刷新'}</button>
      </div>}
      {server.error && <p className="mcp-detail-feedback is-error">{server.error}</p>}
      {testResult && <section className="mcp-detail-test" aria-label="连接测试结果" role={testResult.ok ? 'status' : 'alert'}>
        <header><strong>{testResult.ok ? '连接成功' : '连接测试未成功'}</strong><small>{testResult.durationMs}ms · {testTools.length} 个工具 · {testResources.length} 个资源</small></header>
        {testResult.instructions && <p>{testResult.instructions}</p>}
        <p>Tools {testResult.capabilities?.tools ? '已声明' : '未声明'} · Resources {testResult.capabilities?.resources ? '已声明' : '未声明'}</p>
      </section>}

      <details className="mcp-detail-section">
        <summary>连接参数</summary>
        <dl className="mcp-detail-facts">
          <div><dt>作用域</dt><dd>全局 · 所有工作区使用同一份连接配置</dd></div>
          {server.transport === 'stdio' && <div><dt>工作目录</dt><dd><code>{server.cwd || 'Studio 应用数据目录'}</code></dd></div>}
          <div><dt>工具暴露</dt><dd>{server.exposure === 'deferred' ? '按需搜索 · tool_search' : server.exposure === 'direct' ? '直接提供' : '不提供给模型'}</dd></div>
          <div><dt>请求超时</dt><dd>{server.timeoutSeconds || 60} 秒</dd></div>
          <div><dt>凭据名称</dt><dd>{(server.transport === 'stdio' ? envKeys : headerKeys).join('、') || '无'} <span>值始终隐藏</span></dd></div>
          {server.transport === 'http' && <div><dt>OAuth</dt><dd>{oauthConnected ? '已授权' : '未授权'}</dd></div>}
        </dl>
      </details>
      <details className="mcp-detail-section" open={toolsOpen} onToggle={event => setToolsOpen(event.currentTarget.open)}>
        <summary>工具 · {tools.length}</summary>
        {toolsOpen && <>
          <p>按需工具通过 tool_search 在下一轮请求中加载。</p>
          {tools.length ? <div className="mcp-detail-tools">
            {tools.map(tool => <div key={tool.name}>
              <code>{'originalName' in tool ? tool.originalName : tool.name}</code>
              <small>{exposureLabel(tool.exposure)}</small>
              {tool.description && <p>{tool.description}</p>}
            </div>)}
          </div> : <p>当前没有可列出的工具。</p>}
        </>}
      </details>
      {stderr && <details className="mcp-detail-section" open={diagnosticsOpen} onToggle={event => setDiagnosticsOpen(event.currentTarget.open)}>
        <summary>诊断信息</summary>
        {diagnosticsOpen && <><p>凭据和已保存的 Header 值已脱敏。</p><pre className="mcp-stderr">{stderr}</pre></>}
      </details>}
    </div>
    <footer className="detail-footer"><span /><button type="button" className="settings-outline" onClick={close}>关闭</button></footer>
  </DetailDialog>;
}
