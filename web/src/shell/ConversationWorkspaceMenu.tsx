import type { AgentView } from './app-types';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Activity, ChevronRight, Plug, SlidersHorizontal } from 'lucide-react';
import { ProviderQuotaMenuRow, ProviderQuotaDialog } from '../features/models/ProviderQuotaView';
import { ExtensionStatusIcon } from '../features/extensions/ExtensionStatusIcon';
import type { StatusPanel } from '../shared/extension-appearance';
import { ExtensionSlot } from '../features/extensions/ExtensionSlot';
import type { ExtensionSettingsPage, ExtensionUiSnapshot } from '../types/extension-types';
import type { ExtensionChipEntry } from '../features/extensions/ExtensionChips';

type ConversationWorkspaceMenuProps = {
  agentKind: AgentView['kind'];
  extensionCount: number;
  chips: ExtensionChipEntry[];
  extensionSurface: ExtensionUiSnapshot;
  cwd?: string;
  sessionId?: string;
  modelRef?: string;
  quotaProvider?: { id: string; name: string; item: StatusPanel };
  onOpenConversationExtensionHub: () => void;
  onOpenTrace?: () => void;
  onOpenChip: (chip: ExtensionChipEntry) => void;
  onOpenExtensionSettings?: (page?: ExtensionSettingsPage) => void;
  onSendPromptFromExtension?: (text: string, submit: boolean) => void;
  onNotifyExtension?: React.ComponentProps<typeof ExtensionSlot>['onNotify'];
};

function WorkspaceRow({
  icon,
  label,
  meta,
  active,
  onClick,
}: {
  icon: ReactNode;
  label: string;
  meta?: string;
  active: boolean;
  onClick: () => void;
}) {
  return <button type="button" className={`workspace-menu-row ${active ? 'is-active' : ''}`} aria-current={active ? 'page' : undefined} onClick={onClick}>
    <span className="workspace-menu-row-icon">{icon}</span>
    <span className="workspace-menu-row-label">{label}</span>
    <span className="workspace-menu-row-meta">{meta}</span>
    <ChevronRight className="workspace-menu-row-arrow" aria-hidden="true" />
  </button>;
}

export function ConversationWorkspaceMenu({
  agentKind,
  extensionCount,
  chips,
  extensionSurface,
  cwd,
  sessionId,
  modelRef,
  quotaProvider,
  onOpenConversationExtensionHub,
  onOpenTrace,
  onOpenChip,
  onOpenExtensionSettings,
  onSendPromptFromExtension,
  onNotifyExtension,
}: ConversationWorkspaceMenuProps) {
  const [open, setOpen] = useState(false);
  const [detailId, setDetailId] = useState('');
  const root = useRef<HTMLDivElement>(null);
  const availableExtensionCount = extensionCount || chips.length;
  useEffect(() => { setDetailId(''); }, [sessionId, quotaProvider?.id]);

  useEffect(() => {
    if (!open) return undefined;
    const onOutside = (event: Event) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.isComposing) return;
      setOpen(false);
      root.current?.querySelector<HTMLButtonElement>('.workspace-menu-trigger')?.focus();
    };
    document.addEventListener('pointerdown', onOutside);
    document.addEventListener('focusin', onOutside);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onOutside);
      document.removeEventListener('focusin', onOutside);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  const navigate = (action: () => void) => {
    setOpen(false);
    action();
  };

  return <div className="workspace-menu-anchor" ref={root}>
    <button
      type="button"
      className={`icon-button workspace-menu-trigger ${open ? 'is-active' : ''}`}
      aria-label="打开扩展与轨迹"
      aria-haspopup="dialog"
      aria-expanded={open}
      title="扩展与轨迹"
      onClick={() => setOpen(value => !value)}
    >
      <SlidersHorizontal aria-hidden="true" />
    </button>
    {open && <section className="workspace-menu" role="dialog" aria-label="扩展与轨迹">
      <header className="workspace-menu-head">
        <div>
          <strong>扩展与轨迹</strong>
        </div>
        <span className="workspace-menu-head-icon"><SlidersHorizontal aria-hidden="true" /></span>
      </header>

      <div className="workspace-menu-section" role="group" aria-label="会话视图">
        <span className="workspace-menu-section-label">视图</span>
        <WorkspaceRow icon={<Plug />} label="扩展" meta={availableExtensionCount ? String(availableExtensionCount) : undefined} active={agentKind === 'extensions'} onClick={() => navigate(onOpenConversationExtensionHub)} />
        {onOpenTrace && <WorkspaceRow icon={<Activity />} label="轨迹" active={agentKind === 'trace'} onClick={() => navigate(onOpenTrace)} />}
      </div>

      {quotaProvider && <div className="workspace-menu-section" role="group" aria-label="模型额度">
        <span className="workspace-menu-section-label">模型额度</span>
        <ProviderQuotaMenuRow key={quotaProvider.id} {...quotaProvider} onOpen={() => navigate(() => {
          root.current?.querySelector<HTMLButtonElement>('.workspace-menu-trigger')?.focus();
          setDetailId(quotaProvider.id);
        })} />
      </div>}
      {chips.length > 0 && <div className="workspace-menu-section workspace-menu-extension-section" role="group" aria-label="扩展状态">
        <div className="workspace-menu-section-heading">
          <span className="workspace-menu-section-label">扩展状态</span>
          <button type="button" onClick={() => navigate(onOpenConversationExtensionHub)}>查看全部</button>
        </div>
        <div className="workspace-menu-extension-list">
          {chips.map(chip => <div className="workspace-menu-extension-row" key={chip.item.id}>
            <span className="workspace-menu-extension-icon"><ExtensionStatusIcon item={chip.item} /></span>
            <span className="workspace-menu-extension-copy">
              <button type="button" className="workspace-menu-extension-open" onClick={() => navigate(() => onOpenChip(chip))}>{chip.item.title}</button>
              <ExtensionSlot
                slot="status.chip"
                presentation="compact"
                snapshot={extensionSurface}
                selectedItemId={chip.item.id}
                cwd={cwd}
                sessionId={sessionId}
                modelRef={modelRef}
                onOpenSettings={onOpenExtensionSettings}
                onSendPrompt={onSendPromptFromExtension}
                onNotify={onNotifyExtension}
              />
            </span>
            <button type="button" className="workspace-menu-extension-arrow" aria-label={`打开 ${chip.item.title} 详情`} onClick={() => navigate(() => onOpenChip(chip))}><ChevronRight aria-hidden="true" /></button>
          </div>)}
        </div>
      </div>}
    </section>}
    {quotaProvider && detailId === quotaProvider.id && <ProviderQuotaDialog key={detailId} {...quotaProvider} onClose={() => setDetailId('')} />}
  </div>;
}
