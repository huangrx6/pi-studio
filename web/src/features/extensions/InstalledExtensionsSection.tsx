import { useState, type ReactNode } from 'react';
import { ArrowDown, ArrowUp, Layers3, ListOrdered, X } from 'lucide-react';
import { Accordion } from '../../shared/Accordion';
import { DetailDialog } from '../../shared/DetailDialog';
import { errorText } from '../../shared/error-text';
import { LoadingState } from '../../shared/LoadingState';
import { useSettingsToast } from '../../shared/SettingsToast';
import type { ExtensionHostItem, ExtensionUiItem } from '../../types/extension-types';
import { moveConversationExtension } from '../conversation/conversation-extension-order';
import { ExtensionStatusIcon } from './ExtensionStatusIcon';
import { InstalledExtensionCard } from './InstalledExtensionCard';
import './styles/extension-lists.css';

type ExtensionDisplayOrderProps = {
  items: ExtensionUiItem[];
  order?: string[] | null;
  saving: boolean;
  onSave: (order: string[]) => Promise<void>;
  onRetry: () => void;
};

function ExtensionDisplayOrder({ items, order, saving, onSave, onRetry }: ExtensionDisplayOrderProps) {
  const [open, setOpen] = useState(false);
  const showToast = useSettingsToast();
  async function move(extensionId: string, offset: -1 | 1) {
    if (!order || saving) return;
    try {
      await onSave(moveConversationExtension(order, items.map(item => item.extensionId), extensionId, offset));
    } catch (error) {
      showToast(`扩展顺序保存失败：${errorText(error)}`, 'error');
    }
  }
  return <>
    <button type="button" className="extension-library-tool" aria-haspopup="dialog"
      onClick={() => setOpen(true)}><ListOrdered aria-hidden="true" />对话显示顺序</button>
    {open && <DetailDialog className="extension-display-order" onClose={() => setOpen(false)}>{close => <>
      <header className="detail-header">
        <div className="detail-heading"><div><h2>对话显示顺序</h2><p>扩展菜单和状态摘要按此顺序显示，适用于所有对话。</p></div></div>
        <button className="icon-button" type="button" aria-label="关闭对话显示顺序" onClick={close}><X /></button>
      </header>
      <div className="detail-body">
        {order === null ? <div className="extension-order-feedback" role="status">
          无法读取扩展顺序<button className="settings-outline" type="button" onClick={onRetry}>重试</button>
        </div> : !order ? <LoadingState variant="section">正在读取扩展顺序…</LoadingState> : (
          <ol className="extension-order-list" aria-label="扩展显示顺序" aria-busy={saving}>
            {items.map((item, index) => <li key={item.extensionId} className="extension-order-row">
              <ExtensionStatusIcon item={item} /><span>{item.extensionName}</span>
              <div className="extension-order-actions">
                <button type="button" className="icon-button" aria-label={`上移 ${item.extensionName}`} title="上移"
                  disabled={saving || index === 0} onClick={() => void move(item.extensionId, -1)}><ArrowUp aria-hidden="true" /></button>
                <button type="button" className="icon-button" aria-label={`下移 ${item.extensionName}`} title="下移"
                  disabled={saving || index === items.length - 1} onClick={() => void move(item.extensionId, 1)}><ArrowDown aria-hidden="true" /></button>
              </div>
            </li>)}
          </ol>
        )}
      </div>
    </>}</DetailDialog>}
  </>;
}

export function InstalledExtensionsSection({ items, displayOrder, publisherSettings, onOpenDetail }: {
  items: ExtensionHostItem[];
  displayOrder: ExtensionDisplayOrderProps;
  publisherSettings?: ReactNode;
  onOpenDetail: (item: ExtensionHostItem) => void;
}) {
  const installed = items.filter(item => item.scope !== 'builtin');
  const builtins = items.filter(item => item.scope === 'builtin');
  function collection(entries: ExtensionHostItem[]) {
    return <div className="extension-library-items">
      {entries.map(item => <InstalledExtensionCard key={`${item.scope}:${item.id}`} item={item} onOpenDetail={onOpenDetail} />)}
    </div>;
  }
  return <>
    <section className="installed-extension-section" aria-label="已安装扩展">
      <header className="extension-library-heading">
        <h2>已安装扩展 <span>{installed.length}</span></h2>
        <div className="extension-library-actions">
          {publisherSettings}
          {displayOrder.items.length > 1 && <ExtensionDisplayOrder {...displayOrder} />}
        </div>
      </header>
      {installed.length ? collection(installed) : <div className="plugin-hub-empty extension-library-empty">
        <span className="plugin-hub-empty-mark" aria-hidden="true"><Layers3 /></span>
        <h3>还没有安装扩展</h3>
        <p>可从本地目录、扩展包或插件市场安装界面与智能体能力模块。</p>
      </div>}
    </section>
    {builtins.length > 0 && <Accordion
      className="extension-disclosure-card builtin-extension-section"
      summary="内置能力"
      badge={builtins.length}
      description="Pi Studio 自带，可查看和单独启停"
      summaryClassName="builtin-extension-summary"
      compact
      defaultOpen={builtins.some(item => !item.enabled)}
    >{collection(builtins)}</Accordion>}
  </>;
}
