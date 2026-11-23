import { useEffect, useState } from 'react';
import { pollServiceCount } from './service-count-polling';
import {
  Activity,
  Clapperboard,
  Columns2,
  Folder,
  FolderOpen,
  Globe,
  LayoutGrid,
  MessageCirclePlus,
  Terminal,
  type LucideIcon,
} from 'lucide-react';

export type RightPanelToolId = 'files' | 'terminal' | 'services' | 'browser' | 'temporary' | 'comparison' | 'storyboard';

export type RightPanelToolAction = {
  id: RightPanelToolId;
  label: string;
  description?: string;
  disabled?: boolean;
  onSelect: () => void;
};

const TOOL_ICONS: Record<RightPanelToolId, LucideIcon> = {
  comparison: Columns2,
  storyboard: Clapperboard,
  files: Folder,
  terminal: Terminal,
  services: Activity,
  browser: Globe,
  temporary: MessageCirclePlus,
};

/** Compact list for the tab-bar overflow menu; launcher grid for the start page. */
export function RightPanelToolList({
  actions,
  serviceCount,
  menu = false,
}: {
  actions: RightPanelToolAction[];
  serviceCount?: number;
  menu?: boolean;
}) {
  if (menu) {
    return <div className="panel-tool-menu-list" role="menu">
      {actions.map((action) => {
        const Icon = TOOL_ICONS[action.id];
        return <button
          key={action.id}
          type="button"
          className="panel-tool"
          aria-label={action.label}
          role="menuitem"
          tabIndex={-1}
          disabled={action.disabled}
          onClick={action.onSelect}
        >
          <span className="panel-tool-icon"><Icon aria-hidden /></span>
          <span className="panel-tool-copy">
            <span className="panel-tool-label">{action.label}</span>
          </span>
          {action.id === 'services' && Boolean(serviceCount) && (
            <span className="panel-tool-count" aria-label={`${serviceCount} 个运行服务`}>{serviceCount}</span>
          )}
        </button>;
      })}
    </div>;
  }

  return <div className="panel-launcher-grid" role="list">
    {actions.map((action) => {
      const Icon = TOOL_ICONS[action.id];
      return <button
        key={action.id}
        type="button"
        className="panel-launcher-tile"
        role="listitem"
        aria-label={action.description ? `${action.label}：${action.description}` : action.label}
        disabled={action.disabled}
        onClick={action.onSelect}
      >
        <span className="panel-launcher-icon" aria-hidden>
          <Icon />
          {action.id === 'services' && Boolean(serviceCount) && (
            <span className="panel-launcher-badge">{serviceCount}</span>
          )}
        </span>
        <span className="panel-launcher-label">{action.label}</span>
        {action.description && <span className="panel-launcher-description">{action.description}</span>}
      </button>;
    })}
  </div>;
}

export function RightPanelStart({
  workspace,
  cwd,
  actions,
  onChooseWorkspace,
}: {
  workspace?: string;
  cwd?: string;
  actions: RightPanelToolAction[];
  onChooseWorkspace: () => void;
}) {
  const [serviceCount, setServiceCount] = useState(0);
  const hasWorkspace = Boolean(workspace || cwd);

  useEffect(() => {
    if (!workspace && !cwd) {
      setServiceCount(0);
      return;
    }
    setServiceCount(0);
    const roots = [...new Set([cwd, workspace].filter(Boolean))] as string[];
    return pollServiceCount(
      async () => (await window.piApi.runtimeServices({ cwd, roots })).summary.related,
      setServiceCount,
      {
        isVisible: () => !document.hidden,
        onVisibilityChange: (callback) => {
          document.addEventListener('visibilitychange', callback);
          return () => document.removeEventListener('visibilitychange', callback);
        },
        schedule: (callback, delay) => window.setTimeout(callback, delay),
        cancel: (id) => window.clearTimeout(id),
      },
    );
  }, [cwd, workspace]);

  return <div className="panel-start">
    <header className="panel-start-intro">
      <span className="panel-start-mark"><LayoutGrid aria-hidden /></span>
      <div>
        <strong>启动台</strong>
        <span>{hasWorkspace ? '打开工具，继续当前工作区的事' : '先选择工作区，再启动工具'}</span>
      </div>
    </header>

    {!hasWorkspace && <button type="button" className="panel-workspace-prompt" onClick={onChooseWorkspace}>
      <span className="panel-workspace-prompt-icon" aria-hidden><FolderOpen /></span>
      <span className="panel-workspace-prompt-copy">
        <strong>选择工作区</strong>
        <span>文件、终端和服务需要工作区后才能使用</span>
      </span>
    </button>}

    <section className="panel-launcher" aria-label="工作台应用">
      <div className="panel-start-section-label">应用</div>
      <RightPanelToolList actions={actions} serviceCount={serviceCount} />
    </section>
  </div>;
}
