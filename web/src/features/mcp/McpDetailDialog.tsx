import { useState } from 'react';
import {
  CheckCircle2,
  LoaderCircle,
  LogIn,
  LogOut,
  Plug,
  ShieldCheck,
  X,
} from 'lucide-react';
import type { McpConnectionTestResult } from '../../global.d';
import { errorText } from '../../shared/error-text';
import { DetailDialog } from '../../shared/DetailDialog';
import { InfoHint } from '../../shared/InfoHint';

type McpServer = {
  name: string;
  transport: string;
  enabled: boolean;
  target: string;
  cwd: string;
  description: string;
  exposure: 'direct' | 'deferred' | 'hidden';
  timeoutSeconds: number;
  envKeys: string[];
  headerKeys: string[];
  oauthConnected: boolean;
  connected: boolean;
  toolCount: number;
  error: string;
  stderr: string;
  tools: Array<{
    name: string;
    originalName: string;
    description: string;
    exposure: 'direct' | 'deferred' | 'hidden';
  }>;
};

type Props = {
  server: McpServer;
  workspace: string;
  onClose: () => void;
  onRefresh: () => Promise<void>;
};

function exposureLabel(exposure: string) {
  if (exposure === 'deferred') return '按需加载';
  if (exposure === 'direct') return '直接加载';
  return '仅内部调用';
}

export function McpDetailDialog({
  server,
  workspace,
  onClose,
  onRefresh,
}: Props) {
  const [testing, setTesting] = useState(false);
  const [oauthBusy, setOauthBusy] = useState(false);
  const [testResult, setTestResult] = useState<McpConnectionTestResult | null>(null);
  const [actionError, setActionError] = useState('');
  const [actionMessage, setActionMessage] = useState('');

  async function testConnection() {
    if (testing) return;
    setTesting(true);
    setActionError('');
    setActionMessage('');
    setTestResult(null);
    try {
      setTestResult(await window.piApi.testSavedMcp(server.name));
    } catch (error) {
      setActionError(errorText(error));
    } finally {
      setTesting(false);
    }
  }

  async function authorize() {
    if (oauthBusy) return;
    setOauthBusy(true);
    setActionError('');
    setActionMessage('');
    try {
      await window.piApi.startMcpOAuth(server.name, workspace);
      await onRefresh();
      setActionMessage('OAuth 授权完成，连接已重新加载。');
    } catch (error) {
      setActionError(errorText(error));
    } finally {
      setOauthBusy(false);
    }
  }

  async function logout() {
    if (oauthBusy) return;
    setOauthBusy(true);
    setActionError('');
    setActionMessage('');
    try {
      await window.piApi.logoutMcpOAuth(server.name, workspace);
      await onRefresh();
      setActionMessage('OAuth 凭据已清除，连接已重新加载。');
    } catch (error) {
      setActionError(errorText(error));
    } finally {
      setOauthBusy(false);
    }
  }

  const status = !server.enabled
    ? { label: '已停用', tone: 'is-off' }
    : server.connected
      ? { label: '已连接', tone: 'is-on' }
      : { label: '需要处理', tone: 'is-error' };
  const testTools = Array.isArray(testResult?.tools) ? testResult.tools : [];
  const testResources = Array.isArray(testResult?.resources) ? testResult.resources : [];
  const tools = testResult ? testTools : Array.isArray(server.tools) ? server.tools : [];
  const envKeys = Array.isArray(server.envKeys) ? server.envKeys : [];
  const headerKeys = Array.isArray(server.headerKeys) ? server.headerKeys : [];

  return <DetailDialog className="mcp-detail-dialog" onClose={onClose}>
    <header className="detail-header">
      <div className="detail-heading">
        <span className="detail-icon"><Plug /></span>
        <div>
          <div className="mcp-detail-title-line">
            <h2>{server.name}</h2>
            <span className={`mcp-detail-status ${status.tone}`}>{status.label}</span>
          </div>
          <p>{server.transport === 'stdio' ? '本地进程 · stdio' : 'HTTP 服务 · Streamable HTTP'}</p>
        </div>
      </div>
      <button className="icon-button" aria-label="关闭 MCP 详情" onClick={onClose}><X /></button>
    </header>

    <div className="mcp-detail-body">
      <section className="mcp-detail-actions" aria-label="MCP 连接操作">
        <div className="mcp-detail-action-buttons">
          <button type="button" className="settings-outline" disabled={testing || oauthBusy} onClick={() => void testConnection()}>
            {testing ? <LoaderCircle className="spin" /> : <Plug />}
            {testing ? '正在测试…' : '测试连接'}
          </button>
          {server.transport === 'http' && (server.oauthConnected
            ? <button type="button" className="settings-outline" disabled={oauthBusy} onClick={() => void logout()}>
                {oauthBusy ? <LoaderCircle className="spin" /> : <LogOut />}
                {oauthBusy ? '正在退出…' : '退出 OAuth'}
              </button>
            : <button type="button" className="settings-outline" disabled={oauthBusy} onClick={() => void authorize()}>
                {oauthBusy ? <LoaderCircle className="spin" /> : <LogIn />}
                {oauthBusy ? '等待浏览器授权…' : 'OAuth 登录'}
              </button>)}
        </div>
      </section>

      {actionError && <div className="settings-error mcp-detail-feedback" role="alert">{actionError}</div>}
      {actionMessage && <div className="mcp-detail-success mcp-detail-feedback" role="status"><CheckCircle2 />{actionMessage}</div>}

      {testResult && <section className="mcp-detail-test" aria-label="连接测试结果">
        <header>
          <span><CheckCircle2 /><strong>连接成功</strong></span>
          <small>{testResult.durationMs}ms · {testTools.length} 个工具 · {testResources.length} 个资源</small>
        </header>
        {testResult.instructions && <p>{testResult.instructions}</p>}
        <div className="mcp-detail-capabilities">
          <span><ShieldCheck />Tools {testResult.capabilities?.tools ? '已声明' : '未声明'}</span>
          <span>Resources {testResult.capabilities?.resources ? '已声明' : '未声明'}</span>
        </div>
      </section>}

      <section className="mcp-detail-section">
        <header><div className="mcp-detail-section-heading"><h3>连接信息</h3><InfoHint label="MCP 连接由 Studio 全局共享，所有工作区使用同一份连接配置。" /></div></header>
        <dl className="mcp-detail-facts">
          <div><dt>目标</dt><dd><code>{server.target}</code></dd></div>
          <div><dt>作用域</dt><dd>全局 · 所有工作区</dd></div>
          {server.transport === 'stdio' && <div><dt>工作目录</dt><dd><code>{server.cwd || 'Studio 应用数据目录'}</code></dd></div>}
          <div><dt>工具暴露</dt><dd>{server.exposure === 'deferred' ? '按需搜索 · tool_search' : server.exposure === 'direct' ? '直接提供' : '不提供给模型'}</dd></div>
          <div><dt>请求超时</dt><dd>{server.timeoutSeconds || 60} 秒</dd></div>
          <div><dt>凭据名称</dt><dd>{server.transport === 'stdio'
            ? (envKeys.length ? envKeys.join('、') : '无')
            : (headerKeys.length ? headerKeys.join('、') : '无')} <span>值始终隐藏</span></dd></div>
          {server.transport === 'http' && <div><dt>OAuth</dt><dd>{server.oauthConnected ? '已授权' : '未授权'}</dd></div>}
          {server.description && <div><dt>说明</dt><dd>{server.description}</dd></div>}
        </dl>
      </section>

      <section className="mcp-detail-section">
        <header><div className="mcp-detail-section-heading"><h3>工具</h3>{tools.length > 0 && <span className="count-badge">{tools.length}</span>}<InfoHint label="按需工具会通过 tool_search 在下一轮请求中加载。" /></div></header>
        {tools.length > 0 && <div className="mcp-detail-tools">
          {tools.map((tool) => <div key={tool.name}>
            <code>{'originalName' in tool ? tool.originalName : tool.name}</code>
            {tool.description && <span>{tool.description}</span>}
            <small>{exposureLabel(tool.exposure)}</small>
          </div>)}
        </div>}
      </section>

      {(server.error || testResult?.stderr || server.stderr) && <section className="mcp-detail-section is-diagnostic">
        <header><div className="mcp-detail-section-heading"><h3>诊断</h3><InfoHint label="凭据和已保存的 Header 值会脱敏。" /></div></header>
        {server.error && <p className="detail-error-text">{server.error}</p>}
        {(testResult?.stderr || server.stderr) && <pre className="detail-code mcp-stderr">{testResult?.stderr || server.stderr}</pre>}
      </section>}
    </div>

    <footer className="detail-footer">
      <span />
      <button type="button" className="settings-outline" onClick={onClose}>关闭</button>
    </footer>
  </DetailDialog>;
}
