import { Accordion } from '../../shared/Accordion';
import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import { LoadingIndicator } from '../../shared/LoadingState';
import { errorText } from '../../shared/error-text';
import { SettingsToast, useSettingsToast } from '../../shared/SettingsToast';
import type { McpConnectionTestResult, SettingsSnapshot } from '../../types/global.d';
import type { CommittedProjection } from '../../types/mutation-types';
import { InfoHint } from '../../shared/InfoHint';
import { Select } from '../../shared/Select';
import './styles/mcp-editor.css';

export type McpEditorDraft = {
  name: string; transport: string; command: string; args: string; cwd: string; url: string;
  description: string; env: string; headers: string; exposure: string; timeoutSeconds: string;
  toolExposure: string; clearEnv: boolean; clearHeaders: boolean;
};

export type McpEditorOAuth = {
  serverName: string;
  connected: boolean;
  workspace: string;
  onRefresh: () => Promise<void>;
  onCommitted?: (result: CommittedProjection<SettingsSnapshot>, cwd: string, summary: string) => void;
  onRecovered?: (snapshot: SettingsSnapshot, cwd: string) => void;
};

type OAuthOperation = 'authorize' | 'logout' | 'refresh';

export function McpEditorFields({ draft, setDraft, editing, mcpTesting, settingsBusy, testCurrentMcp, testResult, oauth }: {
  draft: McpEditorDraft;
  setDraft: Dispatch<SetStateAction<McpEditorDraft>>;
  editing: boolean;
  mcpTesting: boolean;
  settingsBusy: boolean;
  testCurrentMcp: () => void | Promise<void>;
  testResult: McpConnectionTestResult | null;
  oauth?: McpEditorOAuth | null;
}) {
  const stdio = draft.transport === 'stdio';
  const configured = Boolean((stdio && draft.cwd) || draft.description || draft.toolExposure || (draft.timeoutSeconds && draft.timeoutSeconds !== '60'));
  const [advancedOpen, setAdvancedOpen] = useState(configured);
  const [oauthLocked, setOAuthLocked] = useState(false);
  const update = <K extends keyof McpEditorDraft>(key: K, value: McpEditorDraft[K]) => setDraft(current => ({ ...current, [key]: value }));
  const clearSecrets = stdio ? draft.clearEnv : draft.clearHeaders;
  const showOAuth = Boolean(editing && !stdio && oauth);
  return <div className="plugin-flat-form mcp-editor-fields">
    <section className="plugin-flat-section" aria-label="基本信息">
      <div className="mcp-editor-identity">
        <label>名称<input autoFocus required value={draft.name} onChange={event => update('name', event.target.value)} placeholder="例如 filesystem" /></label>
        <div className="settings-field"><span>传输方式</span><Select label="传输方式" disabled={settingsBusy} value={draft.transport} onChange={value => update('transport', value)} options={[{ value: 'stdio', label: '本地进程 · stdio' }, { value: 'http', label: 'Streamable HTTP' }]} /></div>
      </div>
      <p className="mcp-editor-note">全局 MCP 连接，所有工作区共享配置与凭据。</p>
    </section>

    <section className="plugin-flat-section" aria-label="连接与凭据">
      <h3>连接与凭据</h3>
      <div className="settings-form-grid">
        {stdio ? <>
          <div className="settings-field field-wide">
            <span className="settings-field-heading"><label htmlFor="mcp-command">启动命令</label><InfoHint label="只填写可执行文件，不要拼接 shell 命令。开头支持 ~/ 展开。" /></span>
            <input id="mcp-command" required value={draft.command} onChange={event => update('command', event.target.value)} placeholder="npx" />
          </div>
          <div className="settings-field mcp-connection-field">
            <span className="settings-field-heading"><label htmlFor="mcp-args">启动参数</label><InfoHint label="每行一个参数；路径中的空格会保留。" /></span>
            <textarea id="mcp-args" value={draft.args} onChange={event => update('args', event.target.value)} rows={3} placeholder={'-y\n@modelcontextprotocol/server-filesystem\n/path/to/workspace'} />
          </div>
        </> : <div className="settings-field field-wide">
          <span className="settings-field-heading"><label htmlFor="mcp-url">服务器地址</label><InfoHint label="远程服务必须使用 HTTPS；localhost、127.0.0.1 与 ::1 可使用 HTTP 做本机开发。" /></span>
          <input id="mcp-url" required type="url" value={draft.url} onChange={event => update('url', event.target.value)} placeholder="https://example.com/mcp" />
        </div>}
        <div className={`settings-field ${stdio ? 'mcp-connection-field' : 'field-wide'}`}>
          <span className="settings-field-heading"><label htmlFor={stdio ? 'mcp-env' : 'mcp-headers'}>{stdio ? '环境变量' : 'HTTP Headers'}</label>
            <InfoHint label={stdio
              ? '每行 KEY=value；支持 ${ENV_VAR} 引用。Studio 只传入 PATH、HOME 等运行所需变量，不会自动透传 shell 密钥；编辑时 KEY= 可保留已保存值。值只保存在主进程的加密存储中。'
              : '每行 Header=value；支持 ${ENV_VAR} 引用。页面只接收 Header 名称，已保存的值不会回显；编辑时 Header= 可保留已保存值。'} />
          </span>
          <textarea id={stdio ? 'mcp-env' : 'mcp-headers'} disabled={clearSecrets} value={stdio ? draft.env : draft.headers}
            onChange={event => update(stdio ? 'env' : 'headers', event.target.value)} rows={3}
            placeholder={stdio ? 'TOKEN=值\nBASE_URL=${BASE_URL}' : 'Authorization=Bearer ${TOKEN}\nX-API-Key=...'} />
          {editing && <>
            <label className="mcp-editor-secret-clear"><input type="checkbox" checked={clearSecrets} onChange={event => update(stdio ? 'clearEnv' : 'clearHeaders', event.target.checked)} />{stdio ? '清除全部已保存环境变量' : '清除全部已保存 Headers'}</label>
            {clearSecrets && <small className="mcp-editor-clear-note">保存或测试时将使用空{stdio ? '环境变量配置' : ' Headers 配置'}，上方输入不会生效。</small>}
          </>}
        </div>
      </div>
    </section>

    <section className="plugin-flat-section" aria-label="工具与运行">
      <div className="mcp-editor-exposure-row">
        <div className="mcp-editor-exposure-copy">
          <h3>工具暴露</h3>
        </div>
        <Select label="工具暴露" disabled={settingsBusy} value={draft.exposure} onChange={value => update('exposure', value)}
          options={[{ value: 'deferred', label: '按需搜索 · tool_search' }, { value: 'direct', label: '直接提供' }, { value: 'hidden', label: '不提供给模型' }]} />
      </div>
      <Accordion className="plugin-flat-disclosure mcp-editor-advanced" open={advancedOpen} onToggle={event => setAdvancedOpen(event.currentTarget.open)}
        onInvalidCapture={event => { event.currentTarget.open = true; setAdvancedOpen(true); }}
        summary="高级选项" badge={configured ? '已配置' : undefined}>
        <div className="plugin-flat-disclosure-body">
          <div className="settings-form-grid">
            {stdio && <div className="settings-field field-wide">
              <span className="settings-field-heading"><label htmlFor="mcp-cwd">工作目录</label><InfoHint label="MCP 连接由所有工作区共享，这里只接受绝对路径或 ~/ 路径，避免不同会话隐式复用错误目录。" /></span>
              <input id="mcp-cwd" value={draft.cwd} onChange={event => update('cwd', event.target.value)} placeholder="可选；例如 /path/to/workspace 或 ~/projects/demo" />
            </div>}
            <div className="settings-field">
              <span className="settings-field-heading"><label htmlFor="mcp-timeout">请求超时</label><InfoHint label="单位为秒，默认 60；收到进度通知会重新计时。" /></span>
              <input id="mcp-timeout" type="number" min="1" max="3600" step="1" value={draft.timeoutSeconds} onChange={event => update('timeoutSeconds', event.target.value)} />
            </div>
            <label>描述<input value={draft.description} onChange={event => update('description', event.target.value)} placeholder="简要说明用途，可选" /></label>
            <div className="settings-field field-wide">
              <span className="settings-field-heading"><label htmlFor="mcp-tool-exposure">逐工具暴露覆盖</label><InfoHint label="每行一个“工具名或通配符=direct|deferred|hidden”。精确名称优先，随后按输入顺序匹配通配符。" /></span>
              <textarea id="mcp-tool-exposure" value={draft.toolExposure} onChange={event => update('toolExposure', event.target.value)} rows={3} placeholder={'search_*=deferred\ndelete_*=hidden\nstatus=direct'} />
            </div>
          </div>
        </div>
      </Accordion>
    </section>

    <section className="plugin-flat-section mcp-editor-test" aria-label="MCP 草稿连接测试">
      <div className="mcp-editor-test-actions">
        <button type="button" className="settings-outline" disabled={mcpTesting || settingsBusy || oauthLocked} onClick={event => {
          if (mcpTesting || settingsBusy || oauthLocked) return;
          if (!event.currentTarget.form || event.currentTarget.form.reportValidity()) void testCurrentMcp();
        }}>{mcpTesting && <LoadingIndicator />}{mcpTesting ? '正在连接…' : '测试连接'}</button>
        {showOAuth && oauth && <McpEditorOAuthControl
          key={`${oauth.serverName}:${oauth.workspace}`}
          oauth={oauth}
          disabled={mcpTesting || settingsBusy}
          onLockChange={setOAuthLocked}
        />}
        <span>{showOAuth ? '测试使用当前草稿；OAuth 授权针对已保存服务器生效。' : '使用当前草稿连接一次，不保存配置。'}</span>
      </div>
      {testResult && <McpEditorTestResult key={JSON.stringify([testResult.ok, testResult.durationMs])} result={testResult} />}
    </section>
  </div>;
}

function McpEditorOAuthControl({ oauth, disabled, onLockChange }: {
  oauth: McpEditorOAuth;
  disabled: boolean;
  onLockChange: (locked: boolean) => void;
}) {
  const showToast = useSettingsToast();
  const live = useRef(true);
  const locked = useRef(false);
  const recoveryPending = useRef(false);
  const recoverySummary = useRef('');
  const runtimeRefreshNeeded = useRef(false);
  const recoveredSnapshot = useRef<SettingsSnapshot | null>(null);
  const [operation, setOperation] = useState<OAuthOperation | null>(null);
  const [refreshError, setRefreshError] = useState('');
  const [authorized, setAuthorized] = useState<boolean | null>(null);

  useEffect(() => {
    live.current = true;
    return () => { live.current = false; onLockChange(false); };
  }, [onLockChange]);

  const begin = (kind: OAuthOperation) => {
    if (!live.current || locked.current || (recoveryPending.current && kind !== 'refresh')) return false;
    locked.current = true;
    setOperation(kind);
    onLockChange(true);
    return true;
  };
  const finish = () => {
    locked.current = false;
    if (live.current) {
      setOperation(null);
      onLockChange(recoveryPending.current);
    }
  };

  async function refreshState(message = 'OAuth 状态已刷新') {
    try {
      if (runtimeRefreshNeeded.current) {
        recoveredSnapshot.current = await window.piApi.refreshMcp(oauth.workspace);
        runtimeRefreshNeeded.current = false;
        if (!live.current) return;
      }
      await oauth.onRefresh();
      if (!live.current) return;
      if (recoveredSnapshot.current) oauth.onRecovered?.(recoveredSnapshot.current, oauth.workspace);
      recoveryPending.current = false;
      setRefreshError('');
      setAuthorized(null);
      onLockChange(false);
      showToast(message);
    } catch (cause) {
      if (live.current) setRefreshError(errorText(cause));
    }
  }

  async function retryRefresh() {
    if (!begin('refresh')) return;
    try { await refreshState(); } finally { finish(); }
  }

  async function changeOAuth(kind: 'authorize' | 'logout') {
    if (disabled || !begin(kind)) return;
    try {
      const result = kind === 'authorize'
        ? await window.piApi.startMcpOAuth(oauth.serverName, oauth.workspace)
        : await window.piApi.logoutMcpOAuth(oauth.serverName, oauth.workspace);
      const summary = kind === 'authorize' ? 'OAuth 授权已完成。' : 'OAuth 凭据已清除。';
      recoveryPending.current = true;
      recoverySummary.current = summary;
      runtimeRefreshNeeded.current = result.projection.status === 'error';
      recoveredSnapshot.current = result.projection.status === 'ready' ? result.projection.value : null;
      if (live.current) setAuthorized(kind === 'authorize');
      try { oauth.onCommitted?.(result, oauth.workspace, summary); } catch {
        if (live.current) setRefreshError('页面状态更新未完成，请重试刷新。');
        return;
      }
      if (!live.current) return;
      if (result.projection.status === 'error') {
        setRefreshError(result.projection.message);
        return;
      }
      await refreshState(summary);
    } catch (cause) {
      if (live.current) showToast(errorText(cause), 'error');
    } finally { finish(); }
  }

  const busy = operation !== null;
  const writeDisabled = disabled || busy || Boolean(refreshError);
  const connected = authorized ?? oauth.connected;

  return <>
    {connected
      ? <button type="button" className="settings-outline" disabled={writeDisabled} onClick={() => void changeOAuth('logout')}>
          {operation === 'logout' && <LoadingIndicator />}{operation === 'logout' ? '正在退出…' : '退出 OAuth'}
        </button>
      : <button type="button" className="settings-outline" disabled={writeDisabled} onClick={() => void changeOAuth('authorize')}>
          {operation === 'authorize' && <LoadingIndicator />}{operation === 'authorize' ? '等待浏览器授权…' : 'OAuth 登录'}
        </button>}
    {refreshError && <div className="mcp-editor-oauth-recovery">
      <SettingsToast tone="error" message={`${recoverySummary.current} 状态刷新失败。${refreshError}`}>
        <button type="button" className="text-button" disabled={busy} onClick={() => void retryRefresh()}>
          {operation === 'refresh' ? '正在刷新…' : '重试刷新'}
        </button>
      </SettingsToast>
    </div>}
  </>;
}

function McpEditorTestResult({ result }: { result: McpConnectionTestResult }) {
  const [toolsOpen, setToolsOpen] = useState(false);
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false);
  return <div className="mcp-editor-test-result" data-state={result.ok ? 'success' : 'error'}>
    <div className="mcp-editor-test-summary" role={result.ok ? 'status' : 'alert'} data-state={result.ok ? 'success' : 'error'}>
      <strong>{result.ok ? '连接成功' : '连接测试未成功'}</strong>
      <span>{result.durationMs}ms · {result.tools.length} 个工具 · {result.resources.length} 个资源</span>
    </div>
    {result.instructions && <p>{result.instructions}</p>}
    <small>Resources {result.capabilities.resources ? `已发现 ${result.resources.length}` : '未声明'}</small>
    {result.tools.length > 0 && <Accordion compact open={toolsOpen} onToggle={event => setToolsOpen(event.currentTarget.open)} summary="测试工具" badge={result.tools.length}>
      {toolsOpen && <div className="mcp-editor-test-tools">{result.tools.map(tool => <div key={tool.name}>
        <code>{tool.name}</code><span>{tool.argumentCount} 参数 · {tool.exposure === 'deferred' ? '按需' : tool.exposure === 'direct' ? '直接' : '隐藏'}</span>
        {tool.description && <p>{tool.description}</p>}
      </div>)}</div>}
    </Accordion>}
    {result.stderr && <Accordion compact open={diagnosticsOpen} onToggle={event => setDiagnosticsOpen(event.currentTarget.open)} summary="测试诊断信息">
      {diagnosticsOpen && <pre>{result.stderr}</pre>}
    </Accordion>}
  </div>;
}
