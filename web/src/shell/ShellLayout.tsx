import type { ReactNode, Ref } from 'react';
import { PanelLeft } from 'lucide-react';
import { BrandMark } from './app-shell-config';

/** The sidebar and title band surround the same inset canvas in both views. */
export function ShellLayout({ sidebar, resizeHandle, isNewConversation, children }: {
  sidebar: ReactNode;
  resizeHandle?: ReactNode;
  isNewConversation?: boolean;
  children: ReactNode;
}) {
  return <>
    {sidebar}
    {resizeHandle}
    <div className={isNewConversation ? 'content-region is-new-conversation' : 'content-region'}>
      {children}
    </div>
  </>;
}

export function ShellSidebar({ className, label, onCollapse, collapseRef, children }: {
  className: string;
  label?: string;
  onCollapse: () => void;
  collapseRef?: Ref<HTMLButtonElement>;
  children: ReactNode;
}) {
  return <aside className={`shell-sidebar ${className}`} aria-label={label}>
    <div className="sidebar-top-row">
      <div className="brand">
        <BrandMark />
        <span className="brand-name">Pi Studio</span>
      </div>
      <button ref={collapseRef} type="button" className="icon-button sidebar-top-toggle"
        aria-label="收起侧边栏" title="收起侧边栏" onClick={onCollapse}>
        <PanelLeft />
      </button>
    </div>
    {children}
  </aside>;
}

export function ShellHeader({ className, onExpandSidebar, expandRef, children }: {
  className: string;
  onExpandSidebar?: () => void;
  expandRef?: Ref<HTMLButtonElement>;
  children: ReactNode;
}) {
  return <header className={`shell-header ${className}`}>
    {onExpandSidebar && <button ref={expandRef} type="button" className="icon-button sidebar-expand"
      aria-label="展开侧边栏" title="展开侧边栏" onClick={onExpandSidebar}>
      <PanelLeft />
    </button>}
    {children}
  </header>;
}
