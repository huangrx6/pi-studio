import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Activity, Bot, ChevronRight, Plug, SlidersHorizontal } from 'lucide-react';
import { ExtensionSlot } from '../features/extensions/ExtensionSlot';
import type { ExtensionSettingsPage, ExtensionUiSnapshot } from '../types/extension-types';
import type { ExtensionChipEntry } from '../features/extensions/ExtensionChips';

type ConversationWorkspaceMenuProps = {
  agentKind: 'conversation' | 'agents' | 'extensions' | 'trace';
  subagentCount: number;
  hasActiveSubagents: boolean;
  extensionCount: number;
  chips: ExtensionChipEntry[];
  extensionSurface: ExtensionUiSnapshot;
  cwd?: string;
  sessionId?: string;
  modelRef?: string;
  onReturnToMainAgent: () => void;
  onOpenAgentOverview: () => void;
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
  live,
  onClick,
}: {
  icon: ReactNode;
  label: string;
  meta?: string;
  active: boolean;
  live?: boolean;
  onClick: () => void;
}) {
  return <button type="button" className={`workspace-menu-row ${active ? 'is-active' : ''}`} aria-current={active ? 'page' : undefined} onClick={onClick}>
    <span className="workspace-menu-row-icon">{icon}</span>
    <span className="workspace-menu-row-label">{label}</span>
    <span className="workspace-menu-row-meta">
      {live && <i className="workspace-menu-live" aria-label="有运行中的子智能体" />}
      {meta}
    </span>
    <ChevronRight className="workspace-menu-row-arrow" aria-hidden="true" />
  </button>;
}

export function ConversationWorkspaceMenu({
  agentKind,
  subagentCount,
  hasActiveSubagents,
  extensionCount,
  chips,
  extensionSurface,
  cwd,
  sessionId,
  modelRef,
  onReturnToMainAgent,
  onOpenAgentOverview,
  onOpenConversationExtensionHub,
  onOpenTrace,
  onOpenChip,
  onOpenExtensionSettings,
  onSendPromptFromExtension,
  onNotifyExtension,
}: ConversationWorkspaceMenuProps) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const availableExtensionCount = extensionCount || chips.length;

  useEffect(() => {
    if (!open) return undefined;
    const onPointerDown = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
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
      aria-label="打开工作区面板"
      aria-haspopup="dialog"
      aria-expanded={open}
      title="工作区"
      onClick={() => setOpen(value => !value)}
    >
      <SlidersHorizontal aria-hidden="true" />
    </button>
    {open && <section className="workspace-menu" role="dialog" aria-label="工作区面板">
      <header className="workspace-menu-head">
        <div>
          <strong>工作区</strong>
          <span>在当前会话中切换工作视图</span>
        </div>
        <span className="workspace-menu-head-icon"><SlidersHorizontal aria-hidden="true" /></span>
      </header>

      <div className="workspace-menu-section" role="group" aria-label="会话视图">
        <span className="workspace-menu-section-label">视图</span>
        {agentKind !== 'conversation' && <WorkspaceRow icon={<span className="workspace-menu-dot" />} label="返回对话" active={false} onClick={() => navigate(onReturnToMainAgent)} />}
        <WorkspaceRow icon={<Bot />} label="子智能体" meta={subagentCount ? String(subagentCount) : undefined} live={hasActiveSubagents} active={agentKind === 'agents'} onClick={() => navigate(onOpenAgentOverview)} />
        <WorkspaceRow icon={<Plug />} label="扩展" meta={availableExtensionCount ? String(availableExtensionCount) : undefined} active={agentKind === 'extensions'} onClick={() => navigate(onOpenConversationExtensionHub)} />
        {onOpenTrace && <WorkspaceRow icon={<Activity />} label="轨迹" active={agentKind === 'trace'} onClick={() => navigate(onOpenTrace)} />}
      </div>

      {chips.length > 0 && <div className="workspace-menu-section workspace-menu-extension-section" role="group" aria-label="扩展状态">
        <div className="workspace-menu-section-heading">
          <span className="workspace-menu-section-label">扩展状态</span>
          <button type="button" onClick={() => navigate(onOpenConversationExtensionHub)}>查看全部</button>
        </div>
        <div className="workspace-menu-extension-list">
          {chips.map(chip => <div className="workspace-menu-extension-row" key={chip.item.id}>
            <span className="workspace-menu-extension-icon"><Activity aria-hidden="true" /></span>
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
  </div>;
}
