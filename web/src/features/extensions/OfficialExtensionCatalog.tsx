import { LoaderCircle } from 'lucide-react';
import type { OfficialExtensionCatalogItem, OfficialExtensionCatalogSnapshot } from '../../types/extension-types';
import './extension-lists.css';

const PERMISSION_LABELS: Record<string, string> = {
  'agent.tools': '智能体工具', 'agent.sections': '提示词', 'agent.hooks': '工具钩子', 'agent.tasks': '持久任务',
  'ui.commands': '命令', 'ui.panels': '界面面板', 'ui.settings': '设置面板', 'ui.data': '实时数据',
  'provider.credentials': '只读模型凭证', network: '网络访问',
};

function updateSummary(item: OfficialExtensionCatalogItem) {
  return [
    item.addedPermissions.length ? `${item.addedPermissions.length} 项新权限` : '',
    item.addedProviderAccess.length ? `${item.addedProviderAccess.length} 个新来源` : '',
    item.addedRequirements.length ? `${item.addedRequirements.length} 个新依赖` : '',
    item.executableExpansion ? '将启用主进程代码' : '',
  ].filter(Boolean).join(' · ');
}

export function OfficialExtensionCatalog({ snapshot, busy, busyId, error, onInstall, onAutoUpdateChange }: {
  snapshot: OfficialExtensionCatalogSnapshot | null;
  busy: boolean;
  busyId: string | null;
  error: string | null;
  onInstall: (item: OfficialExtensionCatalogItem) => void;
  onAutoUpdateChange: (item: OfficialExtensionCatalogItem, enabled: boolean) => void;
}) {
  const consentRequired = snapshot?.autoUpdate?.results.filter((result) => result.status === 'consent-required') || [];
  return <section className="official-extension-section extension-list-section">
    <div className="extension-list-heading"><h2>官方精选</h2>{busy && <LoaderCircle className="spin" aria-label="正在读取官方目录" />}</div>
    {consentRequired.length > 0 && <p className="extension-list-notice is-warning" role="status">
      <strong>{consentRequired.length} 个更新包含能力变化。</strong> 自动更新已暂停。请打开对应更新预览，确认新增权限、来源访问或执行能力后再安装。
    </p>}
    {error && <p className="extension-list-notice is-error" role="alert">{error}</p>}
    <div className="extension-list official-extension-list" aria-busy={busy}>
      {(snapshot?.extensions || []).map((item) => {
        const conflict = item.installed && !item.officialManaged;
        const current = item.officialManaged && !item.updateAvailable;
        const update = item.officialManaged && item.updateAvailable;
        const summary = updateSummary(item);
        return <article className="extension-list-row official-extension-row" key={item.id} aria-label={item.name}>
          <div className="extension-list-main">
            <div className="extension-list-title">
              <h3>{item.name}</h3><span className="extension-list-version">v{item.version}</span>
              {(current || update || conflict) && <span className={`extension-list-state ${conflict ? 'is-pending' : ''}`}>{current ? '已安装' : update ? '可更新' : '来源冲突'}</span>}
            </div>
            <p className="extension-list-meta">{item.publisher}{item.installedVersion && !current && ` · 已安装 v${item.installedVersion}`}</p>
            <p className="extension-list-description">{item.description}</p>
            {(item.executable || item.permissions.length > 0) && <p className="extension-list-access">
              {[item.executable ? '主进程 Node 代码' : '', ...item.permissions.map((permission) => PERMISSION_LABELS[permission] || permission)].filter(Boolean).join(' · ')}
            </p>}
            {update && summary && <p className="extension-list-notice is-warning"><strong>更新需要确认：</strong>{summary}</p>}
            {conflict && <p className="extension-list-notice is-warning">已从其他来源安装，请先在已安装列表中处理来源冲突。</p>}
          </div>
          <div className="extension-list-actions">
            {item.officialManaged && <label className="extension-list-auto" title="仅自动安装不扩大能力的版本">
              <span>自动更新</span>
              <button type="button" role="switch" aria-checked={item.autoUpdate}
                aria-label={`${item.autoUpdate ? '关闭' : '开启'} ${item.name} 自动更新`}
                className={`switch ${item.autoUpdate ? 'is-on' : ''}`} disabled={Boolean(busyId)}
                onClick={() => onAutoUpdateChange(item, !item.autoUpdate)}><span /></button>
            </label>}
            {!current && <button type="button" className="settings-outline" disabled={conflict || busy || Boolean(busyId)}
              title={conflict ? '请先卸载由其他来源安装的同 ID 扩展' : undefined} onClick={() => onInstall(item)}>
              {busyId === item.id && <LoaderCircle className="spin" />}{update ? '查看更新' : '安装'}
            </button>}
          </div>
        </article>;
      })}
      {!busy && snapshot && snapshot.extensions.length === 0 && <div className="settings-empty">当前构建没有可用的官方扩展。</div>}
      {!snapshot && busy && <div className="settings-empty">正在读取官方目录…</div>}
    </div>
    {snapshot?.errors.length ? <div className="extension-list-errors">
      {snapshot.errors.map((item) => <p className="extension-list-notice is-error" role="alert" key={`${item.id || item.path}:${item.message}`}><strong>{item.id || '官方扩展目录'}：</strong>{item.message}</p>)}
    </div> : null}
  </section>;
}
