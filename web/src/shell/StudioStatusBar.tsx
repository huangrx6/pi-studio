import { ProviderQuotaPanel } from '../features/models/ProviderQuotaView';
import { QUOTA_EXTENSION_ID } from '../types/provider-quota';
import { useLayoutEffect, useRef, type ReactNode } from 'react';
import { ExtensionStatusIcon } from '../features/extensions/ExtensionStatusIcon';
import { ExtensionSlot } from '../features/extensions/ExtensionSlot';
import { ExtensionSummaries, type ExtensionSummaryContext } from '../features/extensions/ExtensionSummaries';
import { ExtensionViewPanel, type ExtensionViewSize, type ExtensionViewWorkspace, type OpenTemporaryChatOptions } from '../features/extensions/ExtensionViewPanel';
import { RuntimeServicesStatus } from '../features/runtime-services/RuntimeServicesStatus';
import { ToolPanelLauncher } from './ToolPanelLauncher';
import { LoadingIndicator } from '../shared/LoadingState';
import { PopoverSurface } from '../shared/PopoverSurface';
import { restoreDismissedFocus } from '../shared/keyboard-navigation';
import { useStatusBarPopover } from '../shared/useStatusBarPopover';
import type { ExtensionUiItem } from '../types/extension-types';
import './styles/studio-statusbar.css';

type StatusBarProps = {
  loading: boolean;
  gitControls?: ReactNode;
  extensions: ExtensionSummaryContext;
  items: ExtensionUiItem[];
  panel?: ExtensionUiItem;
  workspace?: string;
  workspaces: ExtensionViewWorkspace[];
  onOpenTemporaryChat: (options?: OpenTemporaryChatOptions) => void;
  onClose: () => void;
};

export function StudioStatusBar({ loading, gitControls, extensions, items, panel: current, workspace, workspaces, onOpenTemporaryChat, onClose }: StatusBarProps) {
  const { surface, rendered: panel, phase } = useStatusBarPopover(current);
  const returnFocus = useRef<HTMLElement | null>(null);
  const compactSize = useRef<ExtensionViewSize>();
  const panelId = current?.id;
  function closeAndRestoreFocus() {
    onClose();
    restoreDismissedFocus(returnFocus.current);
  }
  useLayoutEffect(() => {
    if (!panelId || !surface.current) return;
    returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const popover = surface.current;
    const trigger = returnFocus.current;
    const footer = popover.closest('footer');
    const alignWithTrigger = () => {
      if (!footer || !trigger || !footer.contains(trigger)) return;
      const left = trigger.getBoundingClientRect().left - footer.getBoundingClientRect().left;
      popover.style.left = Math.max(8, Math.min(left, footer.clientWidth - popover.offsetWidth - 8)) + 'px';
    };
    alignWithTrigger();
    window.addEventListener('resize', alignWithTrigger);
    popover.focus({ preventScroll: true });
    const dismiss = (event: Event) => {
      if (!(event.target instanceof Element) || surface.current?.contains(event.target)) return;
      if (event.target.closest<HTMLElement>('[data-extension-detail]')?.dataset.extensionDetail === panelId) return;
      onClose();
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || document.querySelector('dialog[open]')) return;
      event.preventDefault();
      closeAndRestoreFocus();
    };
    document.addEventListener('pointerdown', dismiss);
    document.addEventListener('focusin', dismiss);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('pointerdown', dismiss);
      window.removeEventListener('resize', alignWithTrigger);
      document.removeEventListener('focusin', dismiss);
      document.removeEventListener('keydown', escape);
    };
  }, [panelId, onClose, surface]);

  return <footer className="studio-statusbar" aria-label="状态栏">
    <div className="studio-statusbar-controls" aria-busy={loading}>
      {gitControls}
      <ExtensionSummaries {...extensions} items={items} slot="status.chip" placement="statusbar" openPanelId={panelId} />
      <RuntimeServicesStatus cwd={extensions.cwd} workspace={workspace} />
      <ToolPanelLauncher />
    </div>
    <span className="studio-statusbar-loading" role="status" aria-label="正在加载状态栏"><LoadingIndicator /></span>
    {panel && <PopoverSurface ref={surface} role="dialog" aria-label={panel.title} tabIndex={-1}
      className="studio-status-details" data-status-popover={phase} data-size={panel.size}
      heading={<><ExtensionStatusIcon item={panel} />{panel.title}</>} onClose={closeAndRestoreFocus}>
      {panel.extensionId === QUOTA_EXTENSION_ID && extensions.quotaSource
        ? <ProviderQuotaPanel key={extensions.quotaSource.id} id={extensions.quotaSource.id} />
        : panel.view
        ? <ExtensionViewPanel {...extensions} title={panel.title} view={panel.view} compactSize={panel.size === 'compact' ? compactSize : undefined}
            workspaces={workspaces} generation={extensions.surface.syncedAt} onOpenTemporaryChat={onOpenTemporaryChat} onClose={closeAndRestoreFocus} />
        : <ExtensionSlot {...extensions} slot="status.detail" selectedItemId={panel.id}
            presentation="page" showHeading={false} snapshot={extensions.surface} />}
    </PopoverSurface>}
  </footer>;
}
