import { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  ArchiveRestore,
  Check,
  FileArchive,
  FolderOpen,
  Globe2,
  PackageCheck,
  ShieldCheck,
} from 'lucide-react';
import type {
  ExtensionInstallPreview,
  ExtensionInstallScope,
  ExtensionPermission,
} from '../types/extension-types';
import { SettingsDialog } from './SettingsDialog';

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

function errorText(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

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
  onInstalled: (result: {
    installed: {
      id: string;
      version: string;
      activeCodePath: string;
      dataPath: string;
      contentChanged: boolean;
      trustRevoked: boolean;
    };
    settings: unknown;
  }) => void;
}) {
  const [scope, setScope] = useState<ExtensionInstallScope>('user');
  const [sourceMode, setSourceMode] = useState<'local' | 'remote'>('local');
  const [source, setSource] = useState('');
  const [remoteSource, setRemoteSource] = useState('');
  const [registry, setRegistry] = useState(registryUrl);
  const [preview, setPreview] = useState<ExtensionInstallPreview | null>(initialPreview || null);
  const [accepted, setAccepted] = useState(Boolean(
    initialPreview
    && !initialPreview.executable
    && !initialPreview.executableExpansion
    && initialPreview.addedPermissions.length === 0
    && initialPreview.addedProviderAccess.length === 0
    && initialPreview.addedRequirements.length === 0
    && !initialPreview.requiresPublisherTrust,
  ));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const disposedTokens = useRef(new Set<string>());
  const latestPreviewTokenRef = useRef<string | undefined>(preview?.token);
  const unmountDisposeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  function disposeToken(token: string | undefined) {
    if (!token || disposedTokens.current.has(token)) return;
    disposedTokens.current.add(token);
    void window.piApi.disposeExtensionInstall(token);
  }

  useEffect(() => {
    setRegistry(registryUrl);
  }, [registryUrl]);

  useEffect(() => {
    latestPreviewTokenRef.current = preview?.token;
  }, [preview?.token]);

  // React StrictMode 会在开发期模拟一次卸载再挂载。直接按 preview token
  // 清理副作用会把仍然有效的预览令牌一并销毁；延迟到微任务后仅清理真正
  // 卸载时留下的令牌，并在模拟重挂载时取消这次清理。
  useEffect(() => {
    if (unmountDisposeTimerRef.current !== null) {
      clearTimeout(unmountDisposeTimerRef.current);
      unmountDisposeTimerRef.current = null;
    }
    return () => {
      const token = latestPreviewTokenRef.current;
      if (!token || disposedTokens.current.has(token)) return;
      unmountDisposeTimerRef.current = setTimeout(() => {
        unmountDisposeTimerRef.current = null;
        disposeToken(token);
      }, 0);
    };
  }, []);

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

  const action = useMemo(() => {
    if (!preview) return '校验并预览';
    if (preview.upgrade) return `升级到 v${preview.version}`;
    if (preview.alreadyInstalled) return '完成完整性检查';
    return `安装 v${preview.version}`;
  }, [preview]);

  function close() {
    if (busy) return;
    disposeToken(preview?.token);
    onClose();
  }

  async function pick(kind: 'directory' | 'package') {
    setError(null);
    try {
      const selected = await window.piApi.pickExtensionSource(kind);
      if (selected) setSource(selected);
    } catch (reason) {
      setError(errorText(reason));
    }
  }

  async function prepare() {
    if (!activeSource) {
      setError(sourceMode === 'local' ? '请选择扩展目录或安装包' : '请输入扩展来源');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      if (preview?.token && !disposedTokens.current.has(preview.token)) {
        disposedTokens.current.add(preview.token);
        await window.piApi.disposeExtensionInstall(preview.token);
      }
      const next = await window.piApi.prepareExtensionInstall({
        source: activeSource,
        scope,
        cwd,
        registryUrl: registry.trim(),
      });
      setPreview(next);
      setAccepted(
        !next.executable
        && !next.executableExpansion
        && next.addedPermissions.length === 0
        && next.addedProviderAccess.length === 0
        && next.addedRequirements.length === 0
        && !next.requiresPublisherTrust,
      );
    } catch (reason) {
      setError(errorText(reason));
    } finally {
      setBusy(false);
    }
  }

  async function install() {
    if (!preview || !canSubmitPreview) return;
    const token = preview.token;
    setBusy(true);
    setError(null);
    try {
      const result = await window.piApi.installExtension({
        token,
        scope,
        cwd,
        acceptedPermissions: addedPermissions,
        acceptedProviderAccess: addedProviderAccess,
        acceptedRequirements: (preview.addedRequirements || []).length > 0
          ? accepted
          : true,
        acceptedExecution: consentRequired ? accepted : true,
        acceptedPublisherKey: preview.requiresPublisherTrust ? accepted : true,
      });
      disposedTokens.current.add(token);
      setPreview(null);
      onInstalled(result);
      onClose();
    } catch (reason) {
      setError(errorText(reason));
    } finally {
      setBusy(false);
    }
  }

  function back() {
    if (busy) return;
    disposeToken(preview?.token);
    setPreview(null);
    setAccepted(false);
    setError(null);
  }

  return <SettingsDialog
    title={preview ? '确认扩展安装' : '安装扩展'}
    description={preview
      ? '来源已经在隔离目录中完成格式、完整性与兼容性校验。确认后才会切换活动版本。'
      : '支持本地目录、带完整性清单的扩展包、GitHub Release 或 Registry。安装不会执行 postinstall 脚本。'}
    action={action}
    busy={busy}
    loading={false}
    unavailable={Boolean(preview && !canSubmitPreview)}
    error={error}
    autoFocusFirstField={!preview}
    showBackdrop={false}
    scrollResetKey={preview ? preview.token : `${sourceMode}:${scope}`}
    footerHint={footerHint}
    onClose={close}
    onSubmit={() => void (preview ? install() : prepare())}
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
        <span className="field-label">安装来源</span>
        <div className="extension-source-tabs" role="tablist" aria-label="扩展安装来源">
          <button
            type="button"
            role="tab"
            aria-selected={sourceMode === 'local'}
            aria-controls="extension-local-source-panel"
            className={sourceMode === 'local' ? 'is-active' : ''}
            onClick={() => {
              setSourceMode('local');
              setError(null);
            }}
          >
            <FileArchive />本地文件
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={sourceMode === 'remote'}
            aria-controls="extension-remote-source-panel"
            className={sourceMode === 'remote' ? 'is-active' : ''}
            onClick={() => {
              setSourceMode('remote');
              setError(null);
            }}
          >
            <Globe2 />网络与 Registry
          </button>
        </div>

        {sourceMode === 'local' ? <div
          id="extension-local-source-panel"
          className="extension-local-source"
          role="tabpanel"
        >
          <button type="button" className="extension-source-picker" onClick={() => void pick('directory')}>
            <FolderOpen />
            <span><strong>开发目录</strong><small>选择包含 pi-studio.extension.json 的文件夹</small></span>
          </button>
          <button type="button" className="extension-source-picker" onClick={() => void pick('package')}>
            <FileArchive />
            <span><strong>安装包</strong><small>选择 .pi-extension.zip，包内摘要会逐文件校验</small></span>
          </button>
          {source && <div className="extension-selected-source">
            <PackageCheck />
            <span><strong>{fileName(source)}</strong><small title={source}>{source}</small></span>
            <button type="button" className="settings-text-button" onClick={() => setSource('')}>更换</button>
          </div>}
        </div> : <div
          id="extension-remote-source-panel"
          className="extension-remote-source"
          role="tabpanel"
        >
          <label>
            扩展来源
            <textarea
              rows={3}
              value={remoteSource}
              onChange={(event) => setRemoteSource(event.target.value)}
              placeholder={'registry:pi-metrics@1.0.0\ngithub:owner/pi-metrics@v1.0.0\nhttps://example.com/pi-metrics.zip#sha256=…'}
            />
            <small>HTTPS 包必须带外部 SHA-256；GitHub 优先读取 Release 的 digest 或 checksums。</small>
          </label>
          <label>
            Registry 地址
            <input
              type="url"
              value={registry}
              onChange={(event) => setRegistry(event.target.value)}
              placeholder="https://registry.example.com/pi-studio.json"
            />
            <small>保存到 Studio SQLite；留空时只能使用本地、GitHub 或带摘要的 HTTPS 来源。</small>
          </label>
        </div>}
      </div>

      <div className="extension-install-facts">
        <span><ShieldCheck />先隔离校验，再原子启用</span>
        <span><ArchiveRestore />保留历史版本，可一键回滚</span>
      </div>
    </div> : <div className="extension-preview">
      <header className="extension-preview-head">
        <span className="extension-preview-icon"><PackageCheck /></span>
        <div>
          <div className="extension-preview-title">
            <h3>{preview.name}</h3>
            <span>v{preview.version}</span>
            {preview.upgrade && <em>升级</em>}
            {preview.alreadyInstalled && <em>已安装</em>}
          </div>
          <p>{preview.description || '此扩展没有填写描述。'}</p>
        </div>
      </header>

      <dl className="extension-preview-meta">
        <div><dt>发布者</dt><dd>{preview.publisher}</dd></div>
        <div><dt>范围</dt><dd>{preview.scope === 'project' ? '当前工作区' : '全局扩展'}</dd></div>
        <div><dt>来源</dt><dd>{SOURCE_KIND_LABELS[preview.sourceKind] || preview.sourceKind}</dd></div>
        <div><dt>类型</dt><dd>{extensionKind(preview)}</dd></div>
        <div><dt>执行方式</dt><dd>{preview.executable ? '受信任的主进程 Node 代码' : '仅声明式数据'}</dd></div>
        <div><dt>当前版本</dt><dd>{preview.installedVersion ? `v${preview.installedVersion}` : '未安装'}</dd></div>
        <div className="is-wide">
          <dt>已解析来源</dt>
          <dd title={preview.resolvedRef || preview.source}>
            {SOURCE_KIND_LABELS[preview.sourceKind] || preview.sourceKind}
            {preview.resolvedRef ? ` · ${preview.resolvedRef}` : preview.source ? ` · ${preview.source}` : ''}
          </dd>
        </div>
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
          <div><h4>依赖</h4><p>安装前确认依赖已存在；启用与信任状态在扩展设置中继续检查。</p></div>
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

      {addedProviderAccess.length > 0 && <section className="extension-permission-preview">
        <div className="extension-preview-section-head">
          <div>
            <h4>模型来源凭证访问</h4>
            <p>扩展只能通过 <code>activate(context).providerCredentials.read()</code> 按以下 ID 读取当前来源的 API Key，不能枚举、修改或导出其他来源。</p>
          </div>
          <span>{addedProviderAccess.length} 个新增</span>
        </div>
        <div className="extension-provider-access-list">
          {addedProviderAccess.map((providerId) => <code key={providerId}>{providerId}</code>)}
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
                : 'SHA-256 仍可防止内容损坏或被替换，但不能证明发布者身份。registry 发布者应提供 Ed25519 公钥。'}
          </p>
          {preview.signatureKeyId && <code title={preview.signatureKeyId}>{preview.signatureKeyId}</code>}
        </div>
      </section>

      <section className="extension-integrity">
        <div>
          <span>包 SHA-256</span>
          <code title={preview.archiveSha256 || undefined}>{preview.archiveSha256 || '本地目录未提供外部包摘要'}</code>
        </div>
        <div>
          <span>内容树 SHA-256</span>
          <code title={preview.treeSha256}>{preview.treeSha256}</code>
        </div>
        <p>SHA-256 只证明下载内容与安装状态或 Registry 元数据一致，不代表发布者签名或身份认证。</p>
      </section>

      {consentRequired && <label className="extension-consent">
        <input type="checkbox" checked={accepted} onChange={(event) => setAccepted(event.target.checked)} />
        <span>
          <strong>我了解并接受这些能力</strong>
          <small>{preview.executable
            ? 'Agent 扩展代码在 Pi Studio 主进程中运行，可访问当前用户有权限访问的本机资源。'
            : '扩展可以向界面提供命令、面板或实时数据。'}</small>
          {preview.requiresPublisherTrust && <small>我也会信任上方显示的发布者公钥指纹。之后同一公钥的签名会自动校验；撤销后不再允许安装。</small>}
        </span>
      </label>}

      {scope === 'project' && <p className="extension-project-trust-note">
        {preview.alreadyInstalled
          ? '当前内容与已安装版本完全一致，现有项目信任状态保持不变。'
          : '安装、升级或回滚到新内容后都会撤销旧信任；回到设置页重新审查并信任后才会加载可执行代码。'}
      </p>}

      <button type="button" className="settings-text-button extension-preview-back" disabled={busy} onClick={back}>
        返回修改来源
      </button>
    </div>}
  </SettingsDialog>;
}
