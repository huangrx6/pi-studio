import { AlertTriangle, CheckCircle2, ChevronRight, Clock3, Plug, Trash2 } from 'lucide-react';
import type { ExtensionHostItem } from '../types/extension-types';
import {
  extensionContributionCount,
  extensionScopeLabel,
  extensionStateLabel,
  extensionStateTone,
  extensionTierLabel,
} from '../lib/extension-presentation';
import {
  SettingsResourceCard,
  SettingsResourceCardBody,
  SettingsResourceCardFooter,
  SettingsResourceCardIcon,
  SettingsResourceCardMain,
} from './SettingsResourceCard';

export function InstalledExtensionCard({
  item,
  busy,
  onOpenDetail,
  onToggle,
  onDelete,
}: {
  item: ExtensionHostItem;
  busy: boolean;
  onOpenDetail: (item: ExtensionHostItem) => void;
  onToggle: (item: ExtensionHostItem, enabled: boolean) => void;
  onDelete: (id: string, name: string) => void;
}) {
  const stateTone = extensionStateTone(item);
  const contributions = extensionContributionCount(item);
  const publisher = item.installation?.publisher || item.manifest?.publisher || item.manifest?.author;

  return <SettingsResourceCard className="extension-card installed-extension-card">
    <SettingsResourceCardMain className="installed-extension-main">
      <SettingsResourceCardIcon className="extension-card-icon"><Plug /></SettingsResourceCardIcon>
      <SettingsResourceCardBody>
        <span className="settings-resource-card-heading">
          <span className="extension-card-title installed-extension-title">
            <strong>{item.name}</strong>
            <code>v{item.version}</code>
          </span>
          <span className={`extension-card-state is-${stateTone}`}>
            {stateTone === 'ready' ? <CheckCircle2 /> : stateTone === 'pending' ? <Clock3 /> : <AlertTriangle />}
            {extensionStateLabel(item)}
          </span>
        </span>
        <span className="extension-card-meta">
          {publisher || '未注明发布者'} · {extensionScopeLabel(item.scope)}
        </span>
        <p>{item.manifest?.description || '这个扩展没有填写描述。'}</p>
        <span className="extension-card-capabilities">
          <span>{extensionTierLabel(item.tier)}</span>
          <span>{contributions > 0 ? `${contributions} 项能力` : '无界面能力'}</span>
          {item.runtimeNames.length > 0 && <span>{item.runtimeNames[0]}</span>}
        </span>
        {item.blockedReason && <span className="installed-extension-blocked" role="status">
          <AlertTriangle />
          <span>{item.blockedReason}</span>
        </span>}
      </SettingsResourceCardBody>
    </SettingsResourceCardMain>

    <SettingsResourceCardFooter className="extension-card-footer">
      <span
        className="resource-status extension-card-footer-meta"
        title={item.installation?.source || item.source}
      >{item.id}</span>
      <div>
        {item.scope !== 'builtin' && <button
          type="button"
          className="icon-button resource-delete installed-extension-delete"
          aria-label={`卸载 ${item.name}`}
          title={item.canRemove ? '卸载扩展' : item.removeBlockedReason}
          disabled={busy || !item.canRemove}
          onClick={() => onDelete(item.id, item.name)}
        ><Trash2 /></button>}
        <button
          type="button"
          className="settings-text-button installed-extension-detail"
          aria-label={`查看 ${item.name} 详情`}
          onClick={() => onOpenDetail(item)}
        >
          详情
          <ChevronRight />
        </button>
        <button
          type="button"
          className={`switch ${item.enabled ? 'is-on' : ''}`}
          role="switch"
          aria-checked={item.enabled}
          aria-label={`${item.enabled ? '停用' : '启用'} ${item.name}`}
          title={item.enabled && !item.canDisable ? item.disableBlockedReason : undefined}
          disabled={busy || (item.enabled && !item.canDisable)}
          onClick={() => onToggle(item, !item.enabled)}
        ><span /></button>
      </div>
    </SettingsResourceCardFooter>
  </SettingsResourceCard>;
}
