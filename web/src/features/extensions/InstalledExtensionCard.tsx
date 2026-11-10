import type { ExtensionPlacement } from '../../shared/preferences';
import type { ExtensionHostItem } from '../../types/extension-types';
import {
  placeablePanels,
  placementFor,
  placementOptionsFor,
} from './extension-placement';
import { extensionScopeLabel, extensionStateLabel, extensionStateTone } from './extension-presentation';
import './extension-lists.css';

export function InstalledExtensionCard({ item, busy, compact = false, placements, onPlacementChange, onOpenDetail, onToggle, onDelete }: {
  item: ExtensionHostItem;
  busy: boolean;
  compact?: boolean;
  /** 全局落点偏好；只有声明了顶栏/输入框落点的扩展才显示选择器。 */
  placements?: Record<string, ExtensionPlacement>;
  onPlacementChange?: (contributionId: string, placement: ExtensionPlacement) => void;
  onOpenDetail: (item: ExtensionHostItem) => void;
  onToggle: (item: ExtensionHostItem, enabled: boolean) => void;
  onDelete: (id: string, name: string) => void;
}) {
  const stateTone = extensionStateTone(item);
  const publisher = item.installation?.publisher || item.manifest?.publisher || item.manifest?.author;
  const meta = item.scope === 'builtin'
    ? 'Pi Studio 内置'
    : `${publisher || '未注明发布者'} · ${extensionScopeLabel(item.scope)} · ${item.trusted ? '已信任' : '未信任'}`;
  const placeable = placeablePanels(item);
  const permissions = item.manifest?.permissions || [];
  const access = [
    item.manifest?.runtime?.durableEntry ? '主进程 Node 代码' : '',
    permissions.includes('network') ? '网络访问' : '',
    permissions.includes('provider.credentials') ? '读取模型凭证' : '',
    permissions.includes('agent.hooks') ? '工具钩子' : '',
    permissions.includes('agent.tasks') ? '持久任务' : '',
    permissions.includes('agent.tools') ? '智能体工具' : '',
  ].filter(Boolean);

  return <article className={`extension-list-row installed-extension-row${compact ? ' is-compact' : ''}`} aria-label={item.name}>
    <div className="extension-list-main">
      <div className="extension-list-title">
        <h3>{item.name}</h3><span className="extension-list-version">v{item.version}</span>
        {stateTone !== 'ready' && <span className={`extension-list-state is-${stateTone}`}>{extensionStateLabel(item)}</span>}
      </div>
      <p className="extension-list-meta">{meta}</p>
      {!compact && item.manifest?.description && <p className="extension-list-description">{item.manifest.description}</p>}
      {!compact && access.length > 0 && <p className="extension-list-access">{access.join(' · ')}</p>}
      {item.blockedReason && <p className="extension-list-notice is-error" role="status">{item.blockedReason}</p>}
      {/* 落点在左、操作在右，同一条基线：按钮自带内边距，单独占一行时文字会
        * 比左侧内容更靠右，看起来像没对齐。 */}
      <div className="extension-list-footer">
        {onPlacementChange && placeable.map((panel) => {
          const options = placementOptionsFor(panel.slots);
          // 单落点没有 both 这一档：缺省时把「两处」折算成它唯一的那一处，
          // 否则选择器会出现「没有任何一项被选中」的空状态。
          const stored = placementFor(placements, panel.id);
          const current = options.some((option) => option.value === stored)
            ? stored
            : panel.slots[0] === 'status.chip' ? 'chip' : 'footer';
          return <div className="extension-placement" key={panel.id}>
            <span className="extension-placement-label">显示位置</span>
            <div className="extension-placement-options" role="group" aria-label={`${item.name} 显示位置`}>
              {options.map(({ value, label, hint }) => <button
                key={value}
                type="button"
                title={hint}
                aria-pressed={current === value}
                onClick={() => onPlacementChange(panel.id, value)}
              >{label}</button>)}
            </div>
          </div>;
        })}
        <div className="extension-list-actions">
          <button type="button" className="settings-text-button" aria-label={`查看 ${item.name} 详情`} onClick={() => onOpenDetail(item)}>详情</button>
          {item.scope !== 'builtin' && <button
            type="button" className="settings-text-button extension-list-remove"
            aria-label={`卸载 ${item.name}`} title={item.canRemove ? '卸载扩展' : item.removeBlockedReason}
            disabled={busy || !item.canRemove} onClick={() => onDelete(item.id, item.name)}
          >卸载</button>}
          <button
            type="button" className={`switch ${item.enabled ? 'is-on' : ''}`} role="switch" aria-checked={item.enabled}
            aria-label={`${item.enabled ? '停用' : '启用'} ${item.name}`}
            title={item.enabled && !item.canDisable ? item.disableBlockedReason : undefined}
            disabled={busy || (item.enabled && !item.canDisable)} onClick={() => onToggle(item, !item.enabled)}
          ><span /></button>
        </div>
      </div>
    </div>
  </article>;
}
