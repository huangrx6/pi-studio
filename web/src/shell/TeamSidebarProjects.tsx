import { ChevronDown, Folder, UsersRound } from 'lucide-react';
import type { PiWorkspace } from './app-types';
import type { TeamRoute } from './TeamCanvas';
import { groupSidebarProjects, workspaceRowTitle } from './sidebar-projects';
import { SidebarWorkspaceLabel } from './SidebarWorkspaceLabel';
import { HintButton } from '../shared/HintButton';

export function TeamSidebarProjects({ workspaces, expanded, toggle, route, navigate }: {
  workspaces: PiWorkspace[];
  expanded: Set<string>;
  toggle: (key: string, open: boolean) => void;
  route: TeamRoute;
  navigate: (route: TeamRoute) => void;
}) {
  const current = route.view === 'workspace' ? route : undefined;
  return <div className="sidebar-context-scroll team-sidebar-projects">
    <h3 className="sidebar-group-title">项目群聊</h3>
    {groupSidebarProjects(workspaces).map(project => <div key={project.key} className="sidebar-project">
      {project.nested && <button type="button" className="workspace-row" title={project.name} aria-expanded={expanded.has(project.key)}
        onClick={() => toggle(project.key, expanded.has(project.key))}>
        <SidebarWorkspaceLabel name={project.name} open={expanded.has(project.key)} />
        <span className="workspace-meta"><ChevronDown className={expanded.has(project.key) ? 'chevron open' : 'chevron'} /></span>
      </button>}
      {(!project.nested || expanded.has(project.key)) && project.workspaces.map(workspace => {
        const { cwd, rooms = [], worktree } = workspace;
        const open = expanded.has(cwd);
        const selected = current?.cwd === cwd;
        const openProject = () => navigate({ view: 'workspace', cwd });
        return <div key={cwd} className={`workspace${project.nested ? ' sidebar-worktree' : ''}${selected ? ' is-current' : ''}`}>
          <div className="sidebar-row-shell workspace-row-shell">
            <HintButton className={'workspace-row' + (selected && !current?.roomId ? ' is-active' : '')}
              hint={workspaceRowTitle(workspace)} placement="right" disabled={workspace.missing && !rooms.length} aria-expanded={rooms.length ? open : undefined}
              onClick={() => rooms.length ? toggle(cwd, open) : openProject()}>
              <SidebarWorkspaceLabel name={workspace.name} worktree={worktree} open={open} />
              {workspace.missing && <small className="workspace-missing-label">目录已移除</small>}
              {rooms.length > 0 && <span className="workspace-meta"><ChevronDown className={open ? 'chevron open' : 'chevron'} /></span>}
            </HintButton>
            {rooms.length > 0 && !workspace.missing && <div className="sidebar-row-actions">
              <button type="button" title="打开团队工作区" aria-label={'打开团队工作区 ' + workspace.name} onClick={openProject}><Folder /></button>
            </div>}
          </div>
          {open && rooms.length > 0 && <div className="sessions">{rooms.map(room =>
            <button key={room.id} type="button" className={'session-row' + (selected && current?.roomId === room.id ? ' is-active' : '')}
              aria-current={selected && current?.roomId === room.id ? 'page' : undefined} title={room.name}
              onClick={() => navigate({ view: 'workspace', cwd, roomId: room.id })}>
              <UsersRound size={14} /><span className="session-title">{room.name}</span>
            </button>)}</div>}
        </div>;
      })}
    </div>)}
  </div>;
}
