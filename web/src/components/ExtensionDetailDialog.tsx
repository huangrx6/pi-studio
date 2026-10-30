import {
  AlertTriangle,
  CheckCircle2,
  Clock3,
  Plug,
  RotateCw,
  ShieldCheck,
  ShieldX,
  X,
} from 'lucide-react';
import type { ExtensionHostItem } from '../types/extension-types';
import {
  extensionContributionCount,
  extensionScopeLabel,
  extensionStateLabel,
  extensionStateTone,
  extensionTierLabel,
} from '../lib/extension-presentation';
import { DetailDialog } from './DetailDialog';

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

  return <DetailDialog className="extension-detail-dialog" onClose={onClose}>
    <header className="detail-header">
      <div className="detail-heading">
        <span className="detail-icon is-extension"><Plug /></span>
        <div>
          <div className="extension-detail-title">
            <h2>{item.name}</h2>
            <span>v{item.version}</span>
            <span className={`extension-state-badge is-${stateTone}`}>
              {stateTone === 'ready' ? <CheckCircle2 /> : stateTone === 'pending' ? <Clock3 /> : <AlertTriangle />}
              {extensionStateLabel(item)}
            </span>
          </div>
          <p>{item.manifest?.description || '这个扩展没有填写描述。'}</p>
        </div>
      </div>
      <button className="icon-button" aria-label="关闭扩展详情" onClick={onClose}><X /></button>
    </header>

    <div className="detail-body extension-detail-body">
      <div className="extension-detail-overview">
        <div><span>层级</span><strong>{extensionTierLabel(item.tier)}</strong></div>
        <div><span>范围</span><strong>{extensionScopeLabel(item.scope)}</strong></div>
        <div><span>能力</span><strong>{contributions} 项</strong></div>
        <div><span>信任</span><strong>{item.trusted ? '已信任' : '未信任'}</strong></div>
      </div>

      {item.blockedReason && <div className="extension-detail-notice is-error" role="status">
        <AlertTriangle />
        <span>{item.blockedReason}</span>
      </div>}

      <section className="extension-detail-section">
        <div className="extension-detail-section-head">
          <h3>能力范围</h3>
          <span>{permissions.length} 项权限</span>
        </div>
        <div className="extension-card-capabilities">
          {permissions.map((permission) => (
            <span key={permission}>{PERMISSION_LABELS[permission] || permission}</span>
          ))}
          {permissions.length === 0 && <span>仅声明式界面</span>}
        </div>
      </section>

      <section className="extension-detail-section">
        <div className="extension-detail-section-head"><h3>运行信息</h3></div>
        <dl className="detail-list">
          <div><dt>发布者</dt><dd>{publisher || '未注明'}</dd></div>
          <div><dt>扩展 ID</dt><dd><code>{item.id}</code></dd></div>
          <div><dt>运行时</dt><dd>{runtimeNames.length > 0 ? <code>{runtimeNames.join(', ')}</code> : '没有运行时名称'}</dd></div>
          <div><dt>安装时间</dt><dd>{dateText(item.installedAt)}</dd></div>
          <div><dt>最后更新</dt><dd>{dateText(item.updatedAt)}</dd></div>
          <div><dt>内容哈希</dt><dd><code title={item.contentHash}>{item.contentHash}</code></dd></div>
          {item.installation && <>
            <div><dt>安装来源</dt><dd><code title={item.installation.source}>{item.installation.source}</code></dd></div>
            <div><dt>来源类型</dt><dd>{item.installation.sourceKind}</dd></div>
            <div><dt>版本哈希</dt><dd><code title={item.installation.sha256}>{item.installation.sha256}</code></dd></div>
          </>}
          {requirements.length > 0 && <div><dt>依赖</dt><dd>{requirements.join(', ')}</dd></div>}
        </dl>
      </section>

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
    </div>

    <footer className="detail-footer">
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
      <button className="settings-outline" onClick={onClose}>关闭</button>
    </footer>
  </DetailDialog>;
}
