import { Accordion } from '../../shared/Accordion';
import type { ReactNode } from 'react';
import {
  AlertTriangle,
  Info,
  Package,
  RotateCw,
  Settings,
  ShieldCheck,
  ShieldX,
  Trash2,
  X,
} from 'lucide-react';
import type { ExtensionHostItem } from '../../types/extension-types';
import {
  extensionContributionCount,
  extensionScopeLabel,
  extensionStateLabel,
  extensionStateTone,
  extensionTierLabel,
} from './extension-presentation';
import { DetailDialog } from '../../shared/DetailDialog';
import { PackageIcon } from '../../shared/PackageIcon';
import { SettingsToast } from '../../shared/SettingsToast';
import { isPluginOwnedResource } from '../../shared/plugin-ownership.ts';
import './styles/extension-detail.css';

export type BuiltinExtensionSettingsTab = 'browser' | 'desktop-control';

const BUILTIN_SETTINGS_TARGET: Record<string, { tab: BuiltinExtensionSettingsTab; label: string }> = {
  'builtin:studio-browser-tools': { tab: 'browser', label: '打开浏览器设置' },
  'builtin:studio-desktop-control': { tab: 'desktop-control', label: '打开电脑操控设置' },
};

const PERMISSION_LABELS: Record<string, string> = {
  'agent.tools': '智能体工具',
  'agent.sections': '系统提示词',
  'agent.hooks': '工具钩子',
  'agent.tasks': '持久任务',
  'ui.commands': '命令',
  'ui.panels': '界面面板',
  'ui.settings': '设置面板',
  'ui.data': '实时数据',
  'provider.credentials': '模型凭证',
  network: '网络访问',
};

function dateText(timestamp: number | undefined) {
  if (!timestamp) return '未知';
  return new Intl.DateTimeFormat('zh-CN', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(timestamp));
}

export function ExtensionDetailDialog({
  item,
  displaySettings,
  settingsPanel,
  busy,
  refreshError,
  refreshing,
  onRefresh,
  onClose,
  onRollback,
  onTrust,
  onToggle,
  onDelete,
  onOpenPlugins,
  onOpenSettingsPage,
}: {
  item: ExtensionHostItem;
  displaySettings?: ReactNode;
  settingsPanel?: ReactNode;
  busy: boolean;
  refreshError: string | null;
  refreshing: boolean;
  onRefresh: () => void;
  onClose: () => void;
  onRollback: (item: ExtensionHostItem) => void;
  onTrust: (item: ExtensionHostItem, trusted: boolean) => void;
  onToggle: (item: ExtensionHostItem, enabled: boolean) => void;
  onDelete: (id: string, name: string) => void;
  onOpenPlugins: () => void;
  onOpenSettingsPage?: (tab: BuiltinExtensionSettingsTab) => void;
}) {
  const stateTone = extensionStateTone(item);
  const contributions = extensionContributionCount(item);
  const contributes = item.manifest?.contributes;
  const contributedTools = contributes?.tools || [];
  const contributedCommands = contributes?.commands || [];
  const contributedPanels = contributes?.panels || [];
  const contributedComposer = contributes?.composer || [];
  const contributedDataSources = contributes?.dataSources || [];
  const capabilitySummaryParts = [
    contributedTools.length ? `${contributedTools.length} 个工具` : '',
    contributedCommands.length ? `${contributedCommands.length} 个命令` : '',
    contributedPanels.length ? `${contributedPanels.length} 个面板` : '',
    contributedComposer.length ? `${contributedComposer.length} 个输入动作` : '',
    contributedDataSources.length ? `${contributedDataSources.length} 个数据源` : '',
  ].filter(Boolean);
  const hasCapabilities = capabilitySummaryParts.length > 0;
  const builtinSettingsTarget = item.scope === 'builtin' ? BUILTIN_SETTINGS_TARGET[item.id] : undefined;
  const permissions = item.manifest?.permissions || [];
  const requirements = item.requirements || [];
  const runtimeNames = item.runtimeNames || [];
  const installation = item.installation;
  const publisher = installation?.publisher || item.manifest?.publisher || item.manifest?.author;
  const source = installation?.source || item.source || item.manifest?.source;
  const disableBlocked = item.enabled && !item.canDisable;
  const pluginOwned = isPluginOwnedResource(item);
  const pluginManaged = pluginOwned && item.managed && !item.userOverride && !item.canRemove;
  const trustStatus = item.trusted ? '已信任' : '未信任';
  const permissionSummary = permissions.length ? `${permissions.length} 项声明权限` : '未声明权限';
  const contentHash = item.contentHash?.trim();
  const versionHash = installation?.sha256?.trim();

  return <DetailDialog className="extension-detail-dialog" onClose={onClose}>
    {close => <>
    <header className="detail-header">
      <div className="detail-heading">
        <span className="detail-icon" aria-hidden="true"><PackageIcon source={item.iconDataUrl} /></span>
        <div>
          <h2>{item.name}</h2>
          <div className="extension-detail-meta">{[`v${item.version}`, publisher, extensionScopeLabel(item.scope)].filter(Boolean).join(' · ')}</div>
          {item.manifest?.description && <p>{item.manifest.description}</p>}
        </div>
      </div>
      <button type="button" className="icon-button" aria-label="关闭扩展详情" onClick={close}><X aria-hidden="true" /></button>
    </header>
    {refreshError && <SettingsToast tone="error" message={refreshError}>
      <button type="button" className="settings-outline" disabled={refreshing} onClick={onRefresh}>
        {refreshing ? '正在刷新…' : '刷新扩展状态'}
      </button>
    </SettingsToast>}
    <div className="detail-body extension-detail-body">
      <div className="extension-enable-row">
        <div><strong>启用扩展</strong>
          {disableBlocked && item.disableBlockedReason && <p className="extension-detail-action-note">{item.disableBlockedReason}</p>}
        </div>
        <div className="extension-enable-controls">
          <span className={`extension-detail-state is-${stateTone}`}>{extensionStateLabel(item)}</span>
          <button type="button" className={`switch ${item.enabled ? 'is-on' : ''}`} role="switch" aria-checked={item.enabled}
            aria-label={`${item.enabled ? '停用' : '启用'} ${item.name}`} disabled={busy || disableBlocked}
            title={disableBlocked ? item.disableBlockedReason : undefined} onClick={() => onToggle(item, !item.enabled)}><span /></button>
        </div>
      </div>
      {item.blockedReason && <div className="extension-detail-notice is-error" role="status">
        <AlertTriangle aria-hidden="true" /><span>{item.blockedReason}</span>
      </div>}
      {settingsPanel && <section className="extension-detail-section" aria-label="扩展设置">
        <h3>扩展设置</h3>
        {settingsPanel}
      </section>}
      {displaySettings}
      <div className="extension-detail-disclosures">
        {hasCapabilities && <Accordion
          className="extension-detail-capabilities"
          summary="提供的能力"
          badge={capabilitySummaryParts.join(' · ')}
          compact
          defaultOpen
        >
          <div className="extension-detail-disclosure-body">
            {(contributedPanels.length > 0 || contributedCommands.length > 0 || contributedComposer.length > 0) && (
              <section className="extension-detail-subsection">
                <h4>界面与命令 <span>{contributedPanels.length + contributedCommands.length + contributedComposer.length}</span></h4>
                <ul className="extension-capability-list">
                  {contributedPanels.map((panel) => (
                    <li key={`panel:${panel.id}`}>
                      <div className="extension-capability-head">
                        <strong>{panel.title || panel.id}</strong>
                        <span className="extension-capability-tag">{panel.slot === 'tool.view' ? '工具面板视图' : panel.slot === 'status.detail' ? '状态栏详情' : '会话摘要'}</span>
                      </div>
                      {panel.description && <small>{panel.description}</small>}
                    </li>
                  ))}
                  {contributedCommands.map((cmd) => (
                    <li key={`cmd:${cmd.id}`}>
                      <div className="extension-capability-head">
                        <code>/{cmd.id}</code>
                        {cmd.title && <span>{cmd.title}</span>}
                        <span className="extension-capability-tag">快捷命令</span>
                      </div>
                      {cmd.description && <small>{cmd.description}</small>}
                    </li>
                  ))}
                  {contributedComposer.map((act) => (
                    <li key={`composer:${act.id}`}>
                      <div className="extension-capability-head">
                        <strong>{act.title || act.id}</strong>
                        <span className="extension-capability-tag">输入动作</span>
                      </div>
                      {act.description && <small>{act.description}</small>}
                    </li>
                  ))}
                </ul>
              </section>
            )}
            {contributedTools.length > 0 && (
              <section className="extension-detail-subsection">
                <h4>扩展工具 <span>{contributedTools.length} 项</span></h4>
                <ul className="extension-capability-list is-scrollable">
                  {contributedTools.map((tool) => (
                    <li key={tool.name}>
                      <div className="extension-capability-head">
                        <code>{tool.name}</code>
                      </div>
                      {tool.description && <small>{tool.description}</small>}
                    </li>
                  ))}
                </ul>
              </section>
            )}
            {contributedDataSources.length > 0 && (
              <section className="extension-detail-subsection">
                <h4>数据源 <span>{contributedDataSources.length}</span></h4>
                <ul className="extension-capability-list">
                  {contributedDataSources.map((src) => (
                    <li key={`ds:${src.id}`}>
                      <div className="extension-capability-head">
                        <code>{src.id}</code>
                        {src.title && <span>{src.title}</span>}
                      </div>
                      {src.description && <small>{src.description}</small>}
                    </li>
                  ))}
                </ul>
              </section>
            )}
          </div>
        </Accordion>}
        <Accordion className="extension-detail-source" summary="来源与权限" badge={`${trustStatus} · ${permissionSummary}`}
          compact defaultOpen={item.scope === 'project' && !item.trusted}>
          <div className="extension-detail-disclosure-body">
            <dl className="extension-detail-code-facts">
              <div><dt>安装来源</dt><dd>{source ? <code>{source}</code> : <span>未注明</span>}</dd></div>
              {pluginOwned && <div><dt>所属插件</dt><dd><code>{item.ownerPluginId}</code>{item.managed && !item.userOverride ? <span className="extension-detail-pill">插件托管</span> : null}</dd></div>}
            </dl>
            <section className="extension-detail-subsection">
              <h4>声明的权限</h4>
              {permissions.length > 0 ? <ul className="extension-detail-permissions">
                {permissions.map((permission) => <li key={permission}>{PERMISSION_LABELS[permission] || permission}</li>)}
              </ul> : <p className="extension-detail-action-note">未声明扩展权限</p>}
            </section>
            <p className="extension-detail-callout">
              <Info aria-hidden="true" />
              <span>权限声明不代表运行隔离。扩展的 Node 代码在 Electron 主进程执行。</span>
            </p>
            {item.scope !== 'builtin' && !item.canRemove && item.removeBlockedReason && <p className="extension-detail-action-note">{item.removeBlockedReason}</p>}
          </div>
        </Accordion>
        <Accordion className="extension-detail-technical" summary="技术与运行信息" compact>
          <div className="extension-detail-disclosure-body">
            <dl className="extension-detail-specs">
              <div><dt>层级</dt><dd>{extensionTierLabel(item.tier)}</dd></div>
              <div><dt>贡献能力</dt><dd>{contributions} 项</dd></div>
              {installation && <div><dt>来源类型</dt><dd>{installation.sourceKind}</dd></div>}
              <div><dt>安装时间</dt><dd>{dateText(item.installedAt)}</dd></div>
              <div><dt>最后更新</dt><dd>{dateText(item.updatedAt)}</dd></div>
            </dl>
            <dl className="extension-detail-code-facts">
              <div><dt>扩展 ID</dt><dd><code>{item.id}</code></dd></div>
              <div><dt>运行时</dt><dd>{runtimeNames.length > 0 ? <code>{runtimeNames.join(', ')}</code> : <span>没有运行时名称</span>}</dd></div>
              {contentHash && <div><dt>内容哈希</dt><dd><code>{contentHash}</code></dd></div>}
              {versionHash && <div><dt>版本哈希</dt><dd><code>{versionHash}</code></dd></div>}
              {requirements.length > 0 && <div><dt>依赖</dt><dd><code>{requirements.join(', ')}</code></dd></div>}
            </dl>
            {installation && (installation.versions.length > 0 || installation.canRollback) && <section className="extension-detail-subsection">
              <div className="extension-detail-section-head">
                <h4>版本记录 <span>{installation.versions.length}</span></h4>
                {installation.canRollback && <button type="button" className="settings-outline extension-version-rollback" disabled={busy} onClick={() => onRollback(item)}>
                  <RotateCw aria-hidden="true" />回滚版本
                </button>}
              </div>
              <div className="extension-version-list">
                {installation.versions.map((version) => <div key={`${version.version}:${version.activatedAt}`} className={version.active ? 'is-active' : undefined}>
                  <span><strong>v{version.version}</strong>{version.active && <em>当前</em>}</span>
                  <small>{version.sourceKind} · {dateText(version.activatedAt)}</small>
                </div>)}
              </div>
            </section>}
          </div>
        </Accordion>
      </div>
    </div>
    <footer className="detail-footer extension-detail-footer">
      <div className="extension-detail-footer-start">
        {pluginManaged ? <button type="button" className="settings-outline extension-detail-manage" disabled={busy}
          onClick={onOpenPlugins}><Package aria-hidden="true" />前往插件页</button> : builtinSettingsTarget && onOpenSettingsPage ? (
            <button type="button" className="settings-outline extension-detail-manage" disabled={busy}
              onClick={() => onOpenSettingsPage(builtinSettingsTarget.tab)}>
              <Settings aria-hidden="true" />{builtinSettingsTarget.label}
            </button>
          ) : item.scope !== 'builtin' && <button type="button" className="extension-detail-remove" disabled={busy || !item.canRemove}
            aria-label={`卸载 ${item.name}`} title={item.canRemove ? '卸载扩展' : item.removeBlockedReason}
            onClick={() => onDelete(item.id, item.name)}><Trash2 aria-hidden="true" />卸载</button>}
      </div>
      <div className="extension-detail-footer-end">
        {item.scope === 'project' && <button
          type="button"
          className="settings-outline"
          disabled={busy || (item.enabled && !item.canDisable)}
          title={item.enabled && !item.canDisable ? item.disableBlockedReason : undefined}
          onClick={() => onTrust(item, !item.trusted)}
        >{item.trusted ? <ShieldX aria-hidden="true" /> : <ShieldCheck aria-hidden="true" />}{item.trusted ? '撤销信任' : '信任扩展'}</button>}
        <button type="button" className="settings-outline extension-detail-done" onClick={close}>完成</button>
      </div>
    </footer>
    </>}
  </DetailDialog>;
}
