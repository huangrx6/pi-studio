import { useEffect, useState } from 'react';
import { pollServiceCount } from './service-count-polling';
import { Activity, Columns2, ChevronRight, Folder, FolderOpen, Globe, MessageCirclePlus, PanelRight, Terminal, type LucideIcon } from 'lucide-react';

export type RightPanelToolId = 'files' | 'terminal' | 'services' | 'browser' | 'temporary' | 'comparison';

export type RightPanelToolAction = {
  id: RightPanelToolId;
  label: string;
  description?: string;
  disabled?: boolean;
  onSelect: () => void;
};

const TOOL_ICONS: Record<RightPanelToolId, LucideIcon> = {
  comparison: Columns2,
  files: Folder,
  terminal: Terminal,
  services: Activity,
  browser: Globe,
  temporary: MessageCirclePlus,
};

export function RightPanelToolList({
  actions,
  serviceCount,
  menu = false,
}: {
  actions: RightPanelToolAction[];
  serviceCount?: number;
  menu?: boolean;
}) {
  return <div className={menu ? 'panel-tool-menu-list' : 'panel-start-tools'} role={menu ? 'menu' : undefined}>
    {actions.map((action) => {
      const Icon = TOOL_ICONS[action.id];
      return <button
        key={action.id}
        type="button"
        className="panel-tool"
        aria-label={action.label}
        role={menu ? 'menuitem' : undefined}
        tabIndex={menu ? -1 : undefined}
        disabled={action.disabled}
        onClick={action.onSelect}
      >
        <span className="panel-tool-icon"><Icon aria-hidden /></span>
        <span className="panel-tool-copy">
          <span className="panel-tool-label">{action.label}</span>
          {action.description && <span className="panel-tool-description">{action.description}</span>}
        </span>
        {action.id === 'services' && Boolean(serviceCount) && <span className="panel-tool-count" aria-label={`${serviceCount} 个运行服务`}>{serviceCount}</span>}
        {!menu && <ChevronRight className="panel-tool-arrow" aria-hidden />}
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
    <div className="panel-start-intro">
      <span className="panel-start-mark"><PanelRight aria-hidden /></span>
      <div>
        <strong>工作台</strong>
        <span>{workspace || cwd ? '快速打开当前工作区的工具' : '打开工作区后开始使用工具'}</span>
      </div>
    </div>
    <span className="panel-start-section-label">快速访问</span>
    {!workspace && !cwd && <button type="button" className="panel-workspace-prompt" onClick={onChooseWorkspace}>
      <FolderOpen aria-hidden />
      <span>选择工作区</span>
    </button>}
    <RightPanelToolList actions={actions} serviceCount={serviceCount} />
  </div>;
}
