import {
  ArrowDownToLine,
  CheckCircle2,
  LoaderCircle,
  PackageOpen,
  RefreshCw,
  ShieldAlert,
  Sparkles,
} from 'lucide-react';
import type {
  OfficialExtensionCatalogItem,
  OfficialExtensionCatalogSnapshot,
} from '../types/extension-types';
import {
  SettingsResourceCard,
  SettingsResourceCardBody,
  SettingsResourceCardFooter,
  SettingsResourceCardIcon,
  SettingsResourceCardMain,
} from './SettingsResourceCard';

const PERMISSION_LABELS: Record<string, string> = {
  'agent.tools': '智能体工具',
  'agent.sections': '提示词',
  'agent.hooks': '工具钩子',
  'agent.tasks': '持久任务',
  'ui.commands': '命令',
  'ui.panels': '界面面板',
  'ui.settings': '设置面板',
  'ui.data': '实时数据',
  'provider.credentials': '只读模型凭证',
  network: '网络',
};

function updateSummary(item: OfficialExtensionCatalogItem) {
  const changes = [
    item.addedPermissions.length ? `${item.addedPermissions.length} 项新权限` : '',
    item.addedProviderAccess.length ? `${item.addedProviderAccess.length} 个新来源` : '',
    item.addedRequirements.length ? `${item.addedRequirements.length} 个新依赖` : '',
    item.executableExpansion ? '将启用主进程代码' : '',
  ].filter(Boolean);
  return changes.join(' · ');
}

export function OfficialExtensionCatalog({
  snapshot,
  busy,
  busyId,
  error,
  onInstall,
  onAutoUpdateChange,
}: {
  snapshot: OfficialExtensionCatalogSnapshot | null;
  busy: boolean;
  busyId: string | null;
  error: string | null;
  onInstall: (item: OfficialExtensionCatalogItem) => void;
  onAutoUpdateChange: (item: OfficialExtensionCatalogItem, enabled: boolean) => void;
}) {
  const consentRequired = snapshot?.autoUpdate?.results.filter(
    (result) => result.status === 'consent-required',
  ) || [];

  return <section className="settings-card official-extension-section">
    <div className="settings-card-head official-extension-heading">
      <div className="official-extension-heading-copy">
        <span className="official-extension-mark"><Sparkles /></span>
        <div>
          <h2>官方精选</h2>
          <p>随应用提供，更新沿用相同的完整性校验、隔离安装与回滚流程。</p>
        </div>
      </div>
      <span className="official-extension-count">
        {busy && <LoaderCircle className="spin" />}
        {snapshot?.extensions.length || 0} 个
      </span>
    </div>

    {consentRequired.length > 0 && <div className="official-extension-consent" role="status">
      <ShieldAlert />
      <span>
        <strong>{consentRequired.length} 个更新包含能力变化</strong>
        自动更新已暂停。打开对应扩展的更新预览，确认新增权限、来源访问或执行能力后才会安装。
      </span>
    </div>}

    {error && <div className="official-extension-error" role="alert">
      <ShieldAlert />
      <span>{error}</span>
    </div>}

    <div className="official-extension-grid" aria-busy={busy}>
      {(snapshot?.extensions || []).map((item) => {
        const conflict = item.installed && !item.officialManaged;
        const current = item.officialManaged && !item.updateAvailable;
        const update = item.officialManaged && item.updateAvailable;
        const summary = updateSummary(item);
        return <SettingsResourceCard
          className={`extension-card official-extension-card ${current ? 'is-current' : ''}`}
          key={item.id}
          selected={current}
        >
          <SettingsResourceCardMain className="official-extension-main">
            <SettingsResourceCardIcon className="extension-card-icon"><PackageOpen /></SettingsResourceCardIcon>
            <SettingsResourceCardBody>
              <span className="settings-resource-card-heading">
                <span className="extension-card-title official-extension-title">
                  <strong>{item.name}</strong>
                  <code>v{item.version}</code>
                </span>
                <span className={`extension-card-state official-extension-state ${current ? 'is-current' : update ? 'is-update' : conflict ? 'is-conflict' : ''}`}>
                  {current ? <CheckCircle2 /> : update ? <RefreshCw /> : conflict ? <ShieldAlert /> : <ArrowDownToLine />}
                  {current ? '已安装' : update ? '可更新' : conflict ? '来源冲突' : '可安装'}
                </span>
              </span>
              <span className="extension-card-meta official-extension-publisher">
                {item.publisher}
                {item.executable && <em>可执行</em>}
              </span>
              <p>{item.description}</p>
              <span className="extension-card-capabilities official-extension-capabilities">
                {item.permissions.slice(0, 5).map((permission) => (
                  <span key={permission}>{PERMISSION_LABELS[permission] || permission}</span>
                ))}
                {item.permissions.length > 5 && <span>+{item.permissions.length - 5}</span>}
              </span>
              {update && summary && <span className="official-extension-change">
                <strong>更新需要确认</strong>
                <span>{summary}</span>
              </span>}
            </SettingsResourceCardBody>
          </SettingsResourceCardMain>
          <SettingsResourceCardFooter className="extension-card-footer">
            <span className="resource-status extension-card-footer-meta">
              {item.installedVersion
                ? `已安装 v${item.installedVersion}`
                : item.keywords.slice(0, 2).join(' · ') || '官方扩展'}
            </span>
            <div>
              {item.officialManaged && <label className="official-extension-auto" title="仅自动安装不扩大能力的版本">
                <span>自动更新</span>
                <button
                  type="button"
                  role="switch"
                  aria-checked={item.autoUpdate}
                  className={`switch ${item.autoUpdate ? 'is-on' : ''}`}
                  disabled={Boolean(busyId)}
                  onClick={() => onAutoUpdateChange(item, !item.autoUpdate)}
                ><span /></button>
              </label>}
              {!current && <button
                type="button"
                className={update ? 'settings-add-button' : 'settings-outline'}
                disabled={conflict || busy || Boolean(busyId)}
                title={conflict ? '请先卸载由其他来源安装的同 ID 扩展' : undefined}
                onClick={() => onInstall(item)}
              >
                {busyId === item.id ? <LoaderCircle className="spin" /> : update ? <RefreshCw /> : <ArrowDownToLine />}
                {update ? '查看更新' : '安装'}
              </button>}
            </div>
          </SettingsResourceCardFooter>
        </SettingsResourceCard>;
      })}
      {!busy && snapshot && snapshot.extensions.length === 0 && <div className="settings-empty">
        当前构建没有可用的官方扩展。
      </div>}
      {!snapshot && busy && <div className="settings-empty"><LoaderCircle className="spin" />正在读取官方目录…</div>}
    </div>

    {snapshot?.errors.length ? <div className="official-extension-errors">
      {snapshot.errors.map((item) => <div key={`${item.id || item.path}:${item.message}`}>
        <ShieldAlert />
        <span><strong>{item.id || '官方扩展目录'}</strong>{item.message}</span>
      </div>)}
    </div> : null}
  </section>;
}
