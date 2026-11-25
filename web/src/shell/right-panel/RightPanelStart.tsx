import { useEffect, useRef, useState } from 'react';
import { pollServiceCount } from './service-count-polling';
import { ExtensionStatusIcon } from '../../features/extensions/ExtensionStatusIcon';
import type { ExtensionUiItem } from '../../types/extension-types';
import { launcherToolOrder, moveLauncherEntry, orderLauncherEntries, type RightPanelToolId } from './launcher-order';
import {
  Activity,
  ArrowDown,
  ArrowUp,
  Check,
  Folder,
  FolderOpen,
  GitBranch,
  Globe,
  GripVertical,
  ListOrdered,
  ListChecks,
  MessageCirclePlus,
  Terminal,
  Users,
  type LucideIcon,
} from 'lucide-react';

export type RightPanelToolAction = {
  id: RightPanelToolId;
  label: string;
  description?: string;
  disabled?: boolean;
  needsWorkspace?: boolean;
  group?: 'conversation';
  onSelect: () => void;
};

type LauncherAction = RightPanelToolAction | (Omit<RightPanelToolAction, 'id' | 'group'> & { id: string; panel: ExtensionUiItem });

const TOOL_ICONS: Record<RightPanelToolId, LucideIcon> = {
  files: Folder,
  terminal: Terminal,
  services: Activity,
  browser: Globe,
  temporary: MessageCirclePlus,
  progress: ListChecks,
  trace: Activity,
  subagents: Users,
  git: GitBranch,
};

function LauncherIcon({ action, serviceCount }: { action: LauncherAction; serviceCount?: number }) {
  const Icon = 'panel' in action ? null : TOOL_ICONS[action.id];
  return <span className="panel-launcher-icon" aria-hidden="true">
    {'panel' in action ? <ExtensionStatusIcon item={action.panel} /> : Icon && <Icon />}
    {action.id === 'services' && Boolean(serviceCount) && <span className="panel-launcher-badge">{serviceCount}</span>}
  </span>;
}

/** Compact list for the tab-bar menu and launcher grid for the start page. */
export function RightPanelToolList(props: (
  { actions: RightPanelToolAction[]; menu: true }
  | { actions: LauncherAction[]; menu?: false; onNeedWorkspace?: () => void }
) & { serviceCount?: number }) {
  const { serviceCount } = props;
  if (props.menu) {
    const { actions } = props;
    return <div className="panel-tool-menu-list">
      {(['conversation', 'tools'] as const).map(group => {
        const items = actions.filter(action => (action.group ?? 'tools') === group);
        if (!items.length) return null;
        const label = group === 'conversation' ? '会话' : '工具';
        return <div key={group} role="group" aria-label={label}>
          <div className="panel-tool-group-title" aria-hidden="true">{label}</div>
          {items.map(action => {
            const Icon = TOOL_ICONS[action.id];
            return <button key={action.id} type="button" className="panel-tool" role="menuitem" tabIndex={-1}
              disabled={action.disabled} onClick={action.onSelect}>
              <span className="panel-tool-icon"><Icon aria-hidden /></span>
              <span className="panel-tool-copy"><span className="panel-tool-label">{action.label}</span></span>
              {action.id === 'services' && Boolean(serviceCount) && (
                <span className="panel-tool-count" aria-label={`${serviceCount} 个运行服务`}>{serviceCount}</span>
              )}
            </button>;
          })}
        </div>;
      })}
    </div>;
  }

  return <ul className="panel-launcher-grid">
    {props.actions.map(action => {
      const needsWorkspace = !('panel' in action) && Boolean(action.needsWorkspace);
      const interactiveDisabled = Boolean(action.disabled) && !(needsWorkspace && props.onNeedWorkspace);
      const handleSelect = needsWorkspace && props.onNeedWorkspace ? props.onNeedWorkspace : action.onSelect;
      const hint = needsWorkspace
        ? `先选择工作区以使用「${action.label}」`
        : action.description
          ? `${action.label} · ${action.description}`
          : action.label;
      return <li key={action.id}>
        <button
          type="button"
          className={`panel-launcher-tile${needsWorkspace ? ' is-needs-workspace' : ''}`}
          aria-label={action.label}
          title={hint}
          disabled={interactiveDisabled}
          onClick={handleSelect}
        >
          <LauncherIcon action={action} serviceCount={serviceCount} />
          <span className="panel-launcher-copy">
            <span className="panel-launcher-label">{action.label}</span>
            {action.description && <span className="panel-launcher-description">{action.description}</span>}
          </span>
        </button>
      </li>;
    })}
  </ul>;
}

function LauncherOrderEditor({ actions, label, onMove }: {
  actions: LauncherAction[];
  label: string;
  onMove: (source: string, target: string) => void;
}) {
  const dragging = useRef('');
  const [dropTarget, setDropTarget] = useState('');
  function endDrag() {
    dragging.current = '';
    setDropTarget('');
  }
  return <ol className="panel-launcher-order" aria-label={`${label}顺序`}>
    {actions.map((action, index) => <li key={action.id} className={dropTarget === action.id ? 'is-drop-target' : undefined}
      onDragOver={event => {
        if (!dragging.current) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = 'move';
        setDropTarget(dragging.current === action.id ? '' : action.id);
      }}
      onDrop={event => {
        const source = dragging.current;
        if (!source) return;
        event.preventDefault();
        endDrag();
        onMove(source, action.id);
      }}>
      <span className="panel-launcher-grip" draggable aria-hidden="true" title={`拖动 ${action.label}`}
        onDragStart={event => {
          dragging.current = action.id;
          event.dataTransfer.effectAllowed = 'move';
          event.dataTransfer.setData('application/pi-workbench-entry', action.id);
        }} onDragEnd={endDrag}><GripVertical /></span>
      <LauncherIcon action={action} />
      <span className="panel-launcher-label" title={action.label}>{action.label}</span>
      <div className="panel-launcher-move">
        <button type="button" className="icon-button" aria-label={`上移 ${action.label}`} title="上移" disabled={index === 0}
          onClick={() => onMove(action.id, actions[index - 1].id)}><ArrowUp aria-hidden="true" /></button>
        <button type="button" className="icon-button" aria-label={`下移 ${action.label}`} title="下移" disabled={index === actions.length - 1}
          onClick={() => onMove(action.id, actions[index + 1].id)}><ArrowDown aria-hidden="true" /></button>
      </div>
    </li>)}
  </ol>;
}

export function RightPanelStart({
  workspace,
  workspaces = [],
  cwd,
  actions,
  extensionPanels,
  onOpenExtension,
  order,
  onOrderChange,
  onSelectWorkspace,
  onChooseWorkspace,
}: {
  workspace?: string;
  workspaces?: Array<{ cwd: string; name: string }>;
  cwd?: string;
  actions: RightPanelToolAction[];
  extensionPanels: ExtensionUiItem[];
  onOpenExtension: (panelId: string) => void;
  order: string[];
  onOrderChange: (order: string[]) => void;
  onSelectWorkspace?: (cwd: string) => void;
  onChooseWorkspace: () => void;
}) {
  const [serviceCount, setServiceCount] = useState(0);
  const [sorting, setSorting] = useState(false);
  const sortButton = useRef<HTMLButtonElement>(null);
  const hasWorkspace = Boolean(workspace || cwd);
  const quickWorkspaces = onSelectWorkspace ? workspaces.slice(0, 4) : [];
  const launcherActions: LauncherAction[] = [
    ...orderLauncherEntries(actions, launcherToolOrder),
    ...extensionPanels.map(panel => ({
      id: panel.extensionId,
      label: panel.extensionName,
      description: panel.description,
      panel,
      onSelect: () => onOpenExtension(panel.id),
    })),
  ];
  const pluginActions = launcherActions.filter(action => 'panel' in action && action.panel.ownerPluginId);
  const groups = [
    { label: '系统工具', actions: launcherActions.filter(action => !('panel' in action) || action.panel.scope === 'builtin') },
    { label: '插件', actions: pluginActions },
    { label: '扩展', actions: launcherActions.filter(action => 'panel' in action && action.panel.scope !== 'builtin' && !action.panel.ownerPluginId) },
  ].filter(group => group.actions.length);

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
    {!hasWorkspace && <div className="panel-workspace-card">
      <div className="panel-workspace-card-head">
        <span className="panel-workspace-prompt-icon" aria-hidden="true"><FolderOpen /></span>
        <span className="panel-workspace-prompt-copy">
          <strong>选择工作区</strong>
          <span>文件、终端和服务将绑定到所选目录</span>
        </span>
        <button type="button" className="panel-workspace-browse" onClick={onChooseWorkspace}>打开目录…</button>
      </div>
      {quickWorkspaces.length > 0 && <div className="panel-workspace-chips" role="list" aria-label="快速选择工作区">
        {quickWorkspaces.map((item) => (
          <button
            key={item.cwd}
            type="button"
            className="panel-workspace-chip"
            title={item.cwd}
            onClick={() => onSelectWorkspace?.(item.cwd)}
          >
            <Folder aria-hidden="true" />
            <span>{item.name}</span>
          </button>
        ))}
      </div>}
    </div>}

    <section className="panel-launcher" aria-label="工作台应用" onKeyDown={event => {
      if (!sorting || event.key !== 'Escape' || event.nativeEvent.isComposing) return;
      event.stopPropagation();
      setSorting(false);
      sortButton.current?.focus();
    }}>
      {groups.map(({ label, actions: groupActions }, index) => {
        const ordered = orderLauncherEntries(groupActions, order);
        return <section key={label} className="panel-launcher-group" aria-label={label}>
          <div className="panel-launcher-toolbar">
            <h2 className="panel-start-section-label">{label}</h2>
            {index === 0 && <div className="panel-launcher-toolbar-actions">
              {sorting && <button type="button" className="panel-launcher-action" disabled={order.length === 0}
                onClick={() => onOrderChange([])}>恢复默认</button>}
              <button ref={sortButton} type="button" className="panel-launcher-action" aria-pressed={sorting}
                onClick={() => setSorting(!sorting)}>{sorting ? <Check aria-hidden="true" /> : <ListOrdered aria-hidden="true" />}{sorting ? '完成' : '排序'}</button>
            </div>}
          </div>
          {sorting ? <LauncherOrderEditor label={label} actions={ordered}
            onMove={(source, target) => onOrderChange(moveLauncherEntry(order, ordered.map(action => action.id), source, target))} />
            : <RightPanelToolList actions={ordered} serviceCount={serviceCount} onNeedWorkspace={onChooseWorkspace} />}
        </section>;
      })}
    </section>
  </div>;
}
