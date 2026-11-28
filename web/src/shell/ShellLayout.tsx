import type { ReactNode, Ref } from 'react';
import { PanelLeftClose, PanelLeftOpen, PanelRightClose, PanelRightOpen } from 'lucide-react';
import { HintButton } from '../shared/HintButton';
import { BrandMark } from './app-shell-config';
import { SurfaceActiveContext } from '../shared/surface-visibility';
import { ToolPanelAnchor } from './ToolPanelLauncher';

/** The sidebar and title band surround the same inset canvas in both views. */
export function ShellLayout({ sidebar, resizeHandle, isNewConversation, active = true, children }: {
  sidebar: ReactNode;
  resizeHandle?: ReactNode;
  isNewConversation?: boolean;
  active?: boolean;
  children: ReactNode;
}) {
  return <>
    {sidebar}
    {resizeHandle}
    <ToolPanelAnchor />
    <SurfaceActiveContext.Provider value={active}>
      <div className={isNewConversation ? 'content-region is-new-conversation' : 'content-region'} hidden={!active}>
        {children}
      </div>
    </SurfaceActiveContext.Provider>
  </>;
}

export function ShellSidebar({ className, label, onCollapse, children }: {
  className: string;
  label?: string;
  onCollapse: () => void;
  children: ReactNode;
}) {
  return <aside className={`shell-sidebar ${className}`} aria-label={label}>
    <div className="sidebar-top-row">
      <div className="brand">
        <BrandMark />
        <span className="brand-name">Pi Studio</span>
      </div>
      <HintButton className="icon-button shell-panel-toggle sidebar-top-toggle"
        aria-label="收起侧边栏" aria-expanded={true} onClick={onCollapse}>
        <PanelLeftClose aria-hidden="true" />
      </HintButton>
    </div>
    {children}
  </aside>;
}

export function ShellHeader({ className, onExpandSidebar, expandRef, children }: {
  className: string;
  onExpandSidebar?: () => void;
  expandRef?: Ref<HTMLButtonElement>;
  children?: ReactNode;
}) {
  return <header className={`shell-header ${className}`}>
    {onExpandSidebar && <HintButton ref={expandRef} className="icon-button shell-panel-toggle sidebar-expand"
      aria-label="展开侧边栏" aria-expanded={false} onClick={onExpandSidebar}>
      <PanelLeftOpen aria-hidden="true" />
    </HintButton>}
    {children}
  </header>;
}

export function WorkspacePanelToggle({ expanded, onToggle, toggleRef }: {
  expanded: boolean;
  onToggle: () => void;
  toggleRef: Ref<HTMLButtonElement>;
}) {
  return <HintButton ref={toggleRef} className="icon-button shell-panel-toggle workspace-panel-toggle"
    aria-label={expanded ? '收起右侧面板' : '打开右侧面板'}
    aria-expanded={expanded} aria-controls={expanded ? 'workspace-side-panel' : undefined} onClick={onToggle}>
    {expanded ? <PanelRightClose aria-hidden="true" /> : <PanelRightOpen aria-hidden="true" />}
  </HintButton>;
}
