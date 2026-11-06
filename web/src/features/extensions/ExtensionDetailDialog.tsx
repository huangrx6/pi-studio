import {
  AlertTriangle,
  RotateCw,
  ShieldCheck,
  ShieldX,
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
import './extension-detail.css';

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
  busy,
  onClose,
  onRollback,
  onTrust,
}: {
  item: ExtensionHostItem;
  busy: boolean;
  onClose: () => void;
  onRollback: (item: ExtensionHostItem) => void;
  onTrust: (item: ExtensionHostItem, trusted: boolean) => void;
}) {
  const stateTone = extensionStateTone(item);
  const contributions = extensionContributionCount(item);
  const permissions = item.manifest?.permissions || [];
  const requirements = item.requirements || [];
  const runtimeNames = item.runtimeNames || [];
  const publisher = item.installation?.publisher || item.manifest?.publisher || item.manifest?.author;
  const source = item.installation?.source || item.source || item.manifest?.source;
  const trustBlockedReason = item.scope === 'project' && item.enabled && !item.canDisable
    ? item.disableBlockedReason : '';

  return <DetailDialog className="extension-detail-dialog" onClose={onClose}>
    <header className="detail-header">
      <div className="detail-heading">
        <div>
          <div className="extension-detail-title">
            <h2>{item.name}</h2>
          </div>
          <div className="extension-detail-meta">
            <span>v{item.version}</span>
            <span className={`extension-detail-state is-${stateTone}`}>{extensionStateLabel(item)}</span>
          </div>
          {item.manifest?.description && <p>{item.manifest.description}</p>}
        </div>
      </div>
      <button className="icon-button" aria-label="关闭扩展详情" onClick={onClose}><X /></button>
    </header>

    <div className="detail-body extension-detail-body">
      <dl className="extension-detail-facts">
        <div><dt>发布者</dt><dd>{publisher || '未注明'}</dd></div>
        <div><dt>来源</dt><dd>{source || '未注明'}</dd></div>
        <div><dt>生效范围</dt><dd>{extensionScopeLabel(item.scope)}</dd></div>
        <div><dt>信任状态</dt><dd>{item.trusted ? '已信任' : '未信任'}</dd></div>
      </dl>

      {item.blockedReason && <div className="extension-detail-notice is-error" role="status">
        <AlertTriangle />
        <span>{item.blockedReason}</span>
      </div>}

      <section className="extension-detail-section">
        <div className="extension-detail-section-head">
          <h3>声明的权限</h3>
          <span>{permissions.length} 项</span>
        </div>
        {permissions.length > 0 ? <ul className="extension-detail-permissions">
          {permissions.map((permission) => <li key={permission}>{PERMISSION_LABELS[permission] || permission}</li>)}
        </ul> : <p className="extension-detail-empty-permissions">未声明扩展权限</p>}
        <p className="extension-detail-trust-note">权限声明不代表运行隔离；扩展的 Node 代码在 Electron 主进程执行，请仅信任可靠来源。</p>
      </section>

      <details className="extension-detail-technical">
        <summary>技术与运行信息</summary>
        <dl className="extension-detail-facts">
          <div><dt>扩展 ID</dt><dd><code>{item.id}</code></dd></div>
          <div><dt>层级</dt><dd>{extensionTierLabel(item.tier)}</dd></div>
          <div><dt>贡献能力</dt><dd>{contributions} 项</dd></div>
          <div><dt>运行时</dt><dd>{runtimeNames.length > 0 ? <code>{runtimeNames.join(', ')}</code> : '没有运行时名称'}</dd></div>
          <div><dt>安装时间</dt><dd>{dateText(item.installedAt)}</dd></div>
          <div><dt>最后更新</dt><dd>{dateText(item.updatedAt)}</dd></div>
          <div><dt>内容哈希</dt><dd><code>{item.contentHash}</code></dd></div>
          {item.installation && <>
            <div><dt>来源类型</dt><dd>{item.installation.sourceKind}</dd></div>
            <div><dt>版本哈希</dt><dd><code>{item.installation.sha256}</code></dd></div>
          </>}
          {requirements.length > 0 && <div><dt>依赖</dt><dd>{requirements.join(', ')}</dd></div>}
        </dl>
      </details>

      {item.installation && item.installation.versions.length > 0 && <section className="extension-detail-section">
        <div className="extension-detail-section-head">
          <h3>版本记录</h3>
          <span>{item.installation.versions.length} 个版本</span>
        </div>
        <div className="extension-version-list">
          {item.installation.versions.map((version) => <div className={version.active ? 'is-active' : ''} key={`${version.version}:${version.activatedAt}`}>
            <span><strong>v{version.version}</strong>{version.active && <em>当前</em>}</span>
            <small>{version.sourceKind} · {dateText(version.activatedAt)}</small>
          </div>)}
        </div>
      </section>}
      {trustBlockedReason && <p className="extension-detail-action-note">{trustBlockedReason}</p>}
    </div>
    {(item.installation?.canRollback || item.scope === 'project') && <footer className="detail-footer">
      <span />
      {item.installation?.canRollback && <button
        className="settings-outline"
        disabled={busy}
        onClick={() => onRollback(item)}
      ><RotateCw />回滚版本</button>}
      {item.scope === 'project' && <button
        className="settings-outline"
        disabled={busy || (item.enabled && !item.canDisable)}
        title={item.enabled && !item.canDisable ? item.disableBlockedReason : undefined}
        onClick={() => onTrust(item, !item.trusted)}
      >{item.trusted ? <ShieldX /> : <ShieldCheck />}{item.trusted ? '撤销信任' : '信任扩展'}</button>}
    </footer>}
  </DetailDialog>;
}
