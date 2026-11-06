import { useEffect, useRef, useState } from 'react';
import {
  AlertTriangle,
  Check,
  FileArchive,
  FolderOpen,
  Globe2,
  PackageCheck,
  ShieldCheck,
} from 'lucide-react';
import type {
  ExtensionInstallPreview,
  ExtensionInstallResult,
  ExtensionInstallScope,
  ExtensionPermission,
} from '../../types/extension-types';
import { InfoHint } from '../../shared/InfoHint';
import { SettingsDialog } from '../../shared/SettingsDialog';
import { createExtensionInstallSession, extensionInstallOwnerKey, type InstallSessionState } from './extension-install-session';
import './extension-install.css';

const PERMISSION_LABELS: Record<ExtensionPermission, string> = {
  'agent.tools': '向智能体提供工具',
  'agent.sections': '影响系统提示词',
  'agent.hooks': '拦截或观察工具调用',
  'agent.tasks': '创建后台任务',
  'ui.commands': '添加命令与输入框动作',
  'ui.panels': '添加界面面板',
  'ui.settings': '添加设置页面',
  'ui.data': '提供实时界面数据',
  'provider.credentials': '按授权读取指定模型来源的当前密钥',
  network: '声明会访问网络（审计标记）',
};

const SOURCE_KIND_LABELS: Record<string, string> = {
  'local-directory': '本地目录',
  archive: '本地扩展包',
  https: 'HTTPS 包',
  'github-release': 'GitHub Release',
  'github-commit': 'GitHub 提交',
  registry: 'Registry',
  official: 'Pi Studio 官方目录',
};

function fileName(value: string) {
  return value.split(/[\\/]/).filter(Boolean).pop() || value;
}

function extensionKind(preview: ExtensionInstallPreview) {
  const agent = preview.permissions.some((permission) => permission.startsWith('agent.'));
  const ui = preview.permissions.some((permission) => permission.startsWith('ui.'));
  if (preview.executable && !agent && !ui) return '主进程扩展';
  if (agent && ui) return 'Agent + 声明式 UI';
  if (agent) return 'Agent';
  return preview.executable ? '主进程运行时 + 声明式 UI' : '声明式 UI';
}

export function ExtensionInstallDialog({
  cwd,
  workspaceName,
  registryUrl,
  initialPreview,
  onClose,
  onInstalled,
}: {
  cwd: string;
  workspaceName?: string;
  registryUrl: string;
  initialPreview?: ExtensionInstallPreview | null;
  onClose: () => void;
  onInstalled: (result: ExtensionInstallResult) => void | Promise<void>;
}) {
  const [scope, setScope] = useState<ExtensionInstallScope>(initialPreview?.scope || 'user');
  const [sourceMode, setSourceMode] = useState<'local' | 'remote'>('local');
  const [remoteSource, setRemoteSource] = useState('');
  const [registry, setRegistry] = useState(registryUrl);
  const [accepted, setAccepted] = useState(false);
  const [inputError, setInputError] = useState<string | null>(null);
  const contextKey = extensionInstallOwnerKey(cwd, initialPreview);
  const propsRef = useRef({ contextKey, onInstalled, onClose });
  propsRef.current = { contextKey, onInstalled, onClose };
  const [sessionState, setSessionState] = useState<InstallSessionState>({
    owner: contextKey, preview: initialPreview || null, source: '', phase: null, error: null, committed: false,
  });
  const sessionRef = useRef<ReturnType<typeof createExtensionInstallSession> | null>(null);
  if (!sessionRef.current) sessionRef.current = createExtensionInstallSession({
    api: window.piApi, cwd, initialPreview,
    isContextCurrent: key => propsRef.current.contextKey === key,
    onChange: setSessionState,
    onInstalled: result => propsRef.current.onInstalled(result),
    onClose: () => propsRef.current.onClose(),
  });
  const session = sessionRef.current;
  const preview = sessionState.owner === contextKey ? sessionState.preview : null;
  const source = sessionState.owner === contextKey ? sessionState.source : '';
  const busy = sessionState.phase !== null;
  const error = inputError || sessionState.error;
  const committed = sessionState.committed && sessionState.owner === contextKey;
  useEffect(() => {
    session.activate();
    session.setContext(cwd, initialPreview);
    setScope(initialPreview?.scope || 'user');
    setRemoteSource('');
    setInputError(null);
    return () => session.deactivate();
  }, [contextKey, session]);
  useEffect(() => { setRegistry(registryUrl); }, [registryUrl]);
  useEffect(() => { setAccepted(false); setInputError(null); }, [preview?.token]);

  const addedPermissions = preview?.addedPermissions || [];
  const addedProviderAccess = preview?.addedProviderAccess || [];
  const retainedPermissions = preview
    ? preview.permissions.filter((permission) => !addedPermissions.includes(permission))
    : [];
  const consentRequired = Boolean(
    preview
    && (
      preview.executable
      || preview.executableExpansion
      || addedPermissions.length
      || addedProviderAccess.length
      || (preview.addedRequirements || []).length
      || preview.requiresPublisherTrust
    ),
  );
  const missingDependencies = preview?.missingDependencies || [];
  const activeSource = sourceMode === 'local' ? source : remoteSource.trim();
  const canSubmitPreview = Boolean(
    preview
    && missingDependencies.length === 0
    && (!consentRequired || accepted),
  );
  const footerHint = preview
    ? missingDependencies.length > 0
      ? '请先安装缺失依赖，再继续。'
      : consentRequired && !accepted
        ? '勾选正文末尾的“我了解并接受这些能力”后即可安装。'
        : null
    : null;

  const action = committed ? '刷新安装结果' : !preview ? '校验并预览'
    : preview.upgrade ? `升级到 v${preview.version}`
      : preview.alreadyInstalled ? '完成完整性检查' : `安装 v${preview.version}`;
  function prepare() {
    if (!activeSource) { setInputError(sourceMode === 'local' ? '请选择扩展目录或安装包' : '请输入扩展来源'); return; }
    setInputError(null);
    void session.prepare({ source: activeSource, scope, registryUrl: registry.trim() });
  }
  function back() { session.back(); setAccepted(false); setInputError(null); }

  return <SettingsDialog
    title={committed ? '扩展已安装' : preview ? '确认扩展安装' : '安装扩展'}
    closeLabel={committed ? '关闭' : '取消'}
    hint={preview
      ? '来源已在临时校验目录完成格式、完整性与兼容性校验；确认后才会切换活动版本。这不是操作系统沙箱。'
      : '支持本地目录、带完整性清单的扩展包、GitHub Release 或 Registry；安装不会执行 postinstall 脚本。'}
    action={action}
    busy={busy}
    fieldsDisabled={committed}
    busyAction={sessionState.phase === 'pick' ? '正在选择…' : sessionState.phase === 'prepare' ? '正在校验…' : sessionState.phase === 'apply' ? '正在刷新…' : '正在安装…'}
    loading={false}
    unavailable={Boolean(!committed && preview && !canSubmitPreview)}
    error={error}
    autoFocusFirstField={!preview}
    showBackdrop={false}
    scrollResetKey={preview ? preview.token : `${sourceMode}:${scope}`}
    footerHint={committed ? '安装已完成，重试只刷新设置，不会再次安装。' : footerHint}
    onClose={() => session.close()}
    onSubmit={() => { setInputError(null); void (committed ? session.retryApply() : preview ? session.install(accepted) : prepare()); }}
  >
    {!preview ? <div className="extension-install-form">
      <div className="extension-install-section">
        <span className="field-label">生效范围</span>
        <div className="extension-scope-cards">
          <button
            type="button"
            className={scope === 'user' ? 'is-selected' : ''}
            aria-pressed={scope === 'user'}
            onClick={() => setScope('user')}
          >
            <Globe2 />
            <span><strong>全局扩展</strong><small>所有工作区可用，安装后默认信任</small></span>
            {scope === 'user' && <Check />}
          </button>
          <button
            type="button"
            className={scope === 'project' ? 'is-selected' : ''}
            aria-pressed={scope === 'project'}
            disabled={!cwd}
            onClick={() => setScope('project')}
          >
            <FolderOpen />
            <span><strong>当前工作区</strong><small>{workspaceName || '请先选择一个工作区'}</small></span>
            {scope === 'project' && <Check />}
          </button>
        </div>
      </div>

      <div className="extension-install-section">
        <div className="extension-field-label-row">
          <span className="field-label">安装来源</span>
          <InfoHint align="end" label="开发目录必须包含 pi-studio.extension.json；安装包必须是 .pi-extension.zip，并会逐文件校验摘要。" />
        </div>
        <div className="extension-source-tabs" role="group" aria-label="扩展安装来源">
          <button
            type="button"
            aria-pressed={sourceMode === 'local'}
            aria-controls="extension-local-source-panel"
            className={sourceMode === 'local' ? 'is-active' : ''}
            onClick={() => {
              setSourceMode('local');
              setInputError(null);
            }}
          >
            <FileArchive />本地文件
          </button>
          <button
            type="button"
            aria-pressed={sourceMode === 'remote'}
            aria-controls="extension-remote-source-panel"
            className={sourceMode === 'remote' ? 'is-active' : ''}
            onClick={() => {
              setSourceMode('remote');
              setInputError(null);
            }}
          >
            <Globe2 />网络与 Registry
          </button>
        </div>

        {sourceMode === 'local' ? <div
          id="extension-local-source-panel"
          className="extension-local-source"
        >
          <button
            type="button"
            className="extension-source-picker"
            aria-label="选择扩展开发目录"
            title="目录必须包含 pi-studio.extension.json"
            onClick={() => { setInputError(null); void session.pick('directory'); }}
          >
            <FolderOpen />
            <span><strong>开发目录</strong></span>
          </button>
          <button
            type="button"
            className="extension-source-picker"
            aria-label="选择扩展安装包"
            title="选择 .pi-extension.zip"
            onClick={() => { setInputError(null); void session.pick('package'); }}
          >
            <FileArchive />
            <span><strong>安装包</strong></span>
          </button>
          {source && <div className="extension-selected-source">
            <PackageCheck />
            <span><strong>{fileName(source)}</strong><small title={source}>{source}</small></span>
            <button type="button" className="settings-text-button" onClick={() => session.clearSource()}>更换</button>
          </div>}
        </div> : <div
          id="extension-remote-source-panel"
          className="extension-remote-source"
        >
          <div className="extension-remote-field">
            <div className="extension-field-label-row">
              <label htmlFor="extension-remote-source">扩展来源</label>
              <InfoHint align="end" label="HTTPS 包必须带外部 SHA-256；GitHub 优先读取 Release 的 digest 或 checksums。" />
            </div>
            <textarea
              id="extension-remote-source"
              rows={3}
              value={remoteSource}
              onChange={(event) => setRemoteSource(event.target.value)}
              placeholder={'registry:pi-metrics@1.0.0\ngithub:owner/pi-metrics@v1.0.0\nhttps://example.com/pi-metrics.zip#sha256=…'}
            />
          </div>
          <div className="extension-remote-field">
            <div className="extension-field-label-row">
              <label htmlFor="extension-registry-url">Registry 地址</label>
              <InfoHint align="end" label="Registry 地址保存在 Studio SQLite。留空时只能使用本地、GitHub 或带摘要的 HTTPS 来源。" />
            </div>
            <input
              id="extension-registry-url"
              type="url"
              value={registry}
              onChange={(event) => setRegistry(event.target.value)}
              placeholder="https://registry.example.com/pi-studio.json"
            />
          </div>
        </div>}
      </div>
    </div> : <div className="extension-preview">
      <header className="extension-preview-head">
        <div>
          <div className="extension-preview-title">
            <h3>{preview.name}</h3>
            <span>v{preview.version}</span>
            {preview.upgrade && <em>升级</em>}
            {preview.alreadyInstalled && <em>已安装</em>}
          </div>
          {preview.description && <p>{preview.description}</p>}
        </div>
      </header>

      <dl className="extension-preview-meta">
        <div><dt>发布者</dt><dd>{preview.publisher}</dd></div>
        <div><dt>范围</dt><dd>{preview.scope === 'project' ? '当前工作区' : '全局扩展'}</dd></div>
        <div><dt>来源</dt><dd>{SOURCE_KIND_LABELS[preview.sourceKind] || preview.sourceKind}</dd></div>
        <div><dt>类型</dt><dd>{extensionKind(preview)}</dd></div>
        <div><dt>执行方式</dt><dd>{preview.executable ? '受信任的主进程 Node 代码' : '仅声明式数据'}</dd></div>
        {!committed && <div><dt>当前版本</dt><dd>{preview.installedVersion ? `v${preview.installedVersion}` : '未安装'}</dd></div>}
        <div className="is-wide">
          <dt>已解析来源</dt>
          <dd>{preview.source}</dd>
        </div>
        {preview.resolvedRef && <div><dt>固定引用</dt><dd>{preview.resolvedRef}</dd></div>}
      </dl>

      <section className="extension-permission-preview">
        <div className="extension-preview-section-head">
          <div><h4>权限</h4><p>Agent contribution 和声明式 UI 能力受 Studio 契约限制；可执行扩展仍拥有受信任的主进程 Node 能力。</p></div>
          <span>{preview.permissions.length} 项</span>
        </div>
        {addedPermissions.length > 0 ? <div className="extension-permission-list">
          {addedPermissions.map((permission) => <div key={permission}>
            <ShieldCheck />
            <span><strong>{PERMISSION_LABELS[permission] || permission}</strong><code>{permission}</code></span>
            <em>新增</em>
          </div>)}
        </div> : <div className="extension-preview-empty">本次没有新增权限。</div>}
        {retainedPermissions.length > 0 && <p className="extension-retained-permissions">
          已确认并继续使用：{retainedPermissions.map((permission) => (
            PERMISSION_LABELS[permission] || permission
          )).join('、')}
        </p>}
      </section>

      {preview.requires.length > 0 && <section className="extension-dependencies">
        <div className="extension-preview-section-head">
          <div><h4>依赖 <InfoHint label="缺失依赖会阻止安装；启用与信任状态在扩展设置中继续检查。" /></h4></div>
        </div>
        {preview.requires.map((requirement) => <div
          className={missingDependencies.includes(requirement) ? 'is-missing' : ''}
          key={requirement}
        >
          {missingDependencies.includes(requirement) ? <AlertTriangle /> : <Check />}
          <code>{requirement}</code>
          <span>
            {missingDependencies.includes(requirement)
              ? '未安装'
              : preview.addedRequirements.includes(requirement)
                ? '新增依赖'
                : '已安装'}
          </span>
        </div>)}
      </section>}

      {preview.providerAccess.length > 0 && <section className="extension-permission-preview">
        <div className="extension-preview-section-head">
          <div>
            <h4>模型来源凭证访问</h4>
            <p>扩展只能通过 <code>activate(context).providerCredentials.read()</code> 按以下 ID 读取当前来源的 API Key，不能枚举、修改或导出其他来源。</p>
          </div>
          <span>{addedProviderAccess.length} 个新增</span>
        </div>
        <div className="extension-provider-access-list">
          {preview.providerAccess.map((providerId) => <code key={providerId}>{providerId}{addedProviderAccess.includes(providerId) ? '（新增）' : '（继续使用）'}</code>)}
        </div>
      </section>}

      {preview.executableExpansion && <div className="extension-notice is-warning">
        <AlertTriangle />
        <span><strong>可执行能力发生变化</strong>这个升级会从纯声明式 UI 变为可运行的主进程代码，必须重新确认。</span>
      </div>}

      <section className={`extension-publisher-signature is-${preview.publisherTrust}`}>
        <span className="extension-publisher-signature-icon">
          {preview.publisherTrust === 'trusted'
            ? <ShieldCheck />
            : preview.publisherTrust === 'untrusted'
              ? <AlertTriangle />
              : <PackageCheck />}
        </span>
        <div>
          <strong>
            {preview.publisherTrust === 'trusted'
              ? '发布者身份已受信任'
              : preview.publisherTrust === 'untrusted'
                ? '这是新的发布者公钥'
                : '扩展未附带发布者签名'}
          </strong>
          <p>
            {preview.publisherTrust === 'trusted'
              ? `签名与 manifest 一致，公钥指纹已由你在本机信任。`
              : preview.publisherTrust === 'untrusted'
                ? `签名自洽，但公钥尚未在本机受信任。确认后会把 ${preview.signaturePublisher || preview.publisher} 与此指纹绑定。`
                : 'SHA-256 用于核对内容一致性，不能证明发布者身份。registry 发布者应提供 Ed25519 公钥。'}
          </p>
          {preview.signatureKeyId && <code title={preview.signatureKeyId}>{preview.signatureKeyId}</code>}
        </div>
      </section>

      <details className="extension-integrity">
        <summary>技术信息与完整性校验</summary>
        <div><span>扩展 ID</span><code>{preview.id}</code></div>
        <div>
          <span>包 SHA-256</span>
          <code title={preview.archiveSha256 || undefined}>{preview.archiveSha256 || '本地目录未提供外部包摘要'}</code>
        </div>
        <div>
          <span>内容树 SHA-256</span>
          <code title={preview.treeSha256}>{preview.treeSha256}</code>
        </div>
        <p>SHA-256 只证明下载内容与安装状态或 Registry 元数据一致，不代表发布者签名或身份认证。</p>
      </details>

      {!committed && consentRequired && <label className="extension-consent">
        <input type="checkbox" checked={accepted} onChange={(event) => setAccepted(event.target.checked)} />
        <span>
          <strong>我了解并接受这些能力</strong>
          <small>{preview.executable
            ? 'Agent 扩展代码在 Pi Studio 主进程中运行，可访问当前用户有权限访问的本机资源。'
            : '扩展可以向界面提供命令、面板或实时数据。'}</small>
          {preview.requiresPublisherTrust && <small>我也会信任上方显示的发布者公钥指纹。之后同一公钥的签名会自动校验；撤销后不再允许安装。</small>}
        </span>
      </label>}

      {preview.scope === 'project' && <p className="extension-project-trust-note">
        {preview.alreadyInstalled
          ? '当前内容与已安装版本完全一致，现有项目信任状态保持不变。'
          : '安装、升级或回滚到新内容后都会撤销旧信任；回到设置页重新审查并信任后才会加载可执行代码。'}
      </p>}

      {!committed && <button type="button" className="settings-text-button extension-preview-back" disabled={busy} onClick={back}>
        返回修改来源
      </button>}
    </div>}
  </SettingsDialog>;
}
