import { useState } from 'react';
import { ChevronRight, Folder, FolderOpen } from 'lucide-react';
import { TeamCollection } from '../features/team/TeamCollection';
import { LoadingState } from '../shared/LoadingState';
import { errorText } from '../shared/error-text';
import { ShellHeader } from './ShellLayout';
import { teamMenu } from './app-shell-config';
import type { PiWorkspace } from './app-types';
import './styles/team-canvas.css';

export type TeamRoute =
  | { view: 'members' | 'board' }
  | { view: 'workspace'; cwd?: string; roomId?: string };

export function TeamCanvas({ tabs, route, onNavigate, workspaces, loadingProjects, projectsError, onReloadProjects, onExpandSidebar }: {
  tabs?: import('react').ReactNode;
  route: TeamRoute;
  onNavigate: (next: TeamRoute) => void;
  workspaces: PiWorkspace[];
  loadingProjects: boolean;
  projectsError: boolean;
  onReloadProjects: () => Promise<void>;
  onExpandSidebar?: () => void;
}) {
  const [browsing, setBrowsing] = useState(false);
  const [browseError, setBrowseError] = useState('');
  const project = route.view === 'workspace' ? workspaces.find(item => item.cwd === route.cwd) : undefined;
  const section = teamMenu.find(item => item.id === route.view)!;
  const openProject = (cwd: string, roomId?: string) => onNavigate({ view: 'workspace', cwd, roomId });

  async function browseProjects(pick: boolean) {
    setBrowsing(true);
    setBrowseError('');
    try {
      const cwd = pick ? await window.piApi.chooseWorkspace() : undefined;
      if (pick && !cwd) return;
      await onReloadProjects();
      if (cwd) openProject(cwd);
    } catch (error) {
      setBrowseError(errorText(error));
    } finally {
      setBrowsing(false);
    }
  }

  return <>
    <ShellHeader className="chat-header" onExpandSidebar={onExpandSidebar}>
      {tabs ?? (project ? <nav className="team-breadcrumb" aria-label="团队工作区路径">
        <button onClick={() => onNavigate({ view: 'workspace' })}>工作区</button>
        <ChevronRight aria-hidden="true" />
        {route.view === 'workspace' && route.roomId
          ? <button onClick={() => openProject(project.cwd)}>{project.name}</button>
          : <span aria-current="page">{project.name}</span>}
      </nav> : <span className="main-app-title">{section.label}</span>)}
    </ShellHeader>
    <main className="main shell-canvas team-canvas" aria-label={project?.name ?? section.label}>
      <div className="team-page">
        {route.view === 'members' && <TeamCollection key="members" />}
        {route.view === 'board' && <>
          <h1>协作看板</h1>
          <p>团队任务开放后，可在这里查看各项目的分工与验收进度。</p>
          <ol className="team-board-stages" aria-label="团队任务状态">
            {['待分派', '进行中', '待验收', '已完成'].map(stage => <li key={stage}>{stage}</li>)}
          </ol>
        </>}
        {route.view === 'workspace' && (project
          ? <TeamCollection key={project.cwd} project={project} roomId={route.roomId}
              onOpenRoom={id => openProject(project.cwd, id)} />
          : <>
            <div className="team-heading-row">
              <h1>项目工作区</h1>
              <button type="button" className="secondary-button" disabled={browsing} onClick={() => void browseProjects(true)}>
                <FolderOpen aria-hidden="true" />打开项目
              </button>
            </div>
            <p>选择项目，查看群聊，或为一项工作新建群聊并邀请 Bot。</p>
            {workspaces.length > 0 && <nav className="team-destinations" aria-label="项目工作区列表">
              {workspaces.map(({ cwd, name }) => <button type="button" key={cwd} onClick={() => openProject(cwd)}>
                <Folder aria-hidden="true" /><span><strong>{name}</strong><small>{cwd}</small></span>
                <ChevronRight aria-hidden="true" />
              </button>)}
            </nav>}
            {loadingProjects && !workspaces.length && <LoadingState>正在读取项目…</LoadingState>}
            {(projectsError || browseError) ? <div className="team-notice" role="alert">
              <span>{browseError || '项目列表加载失败'}</span>
              <button className="secondary-button" disabled={browsing} onClick={() => void browseProjects(false)}>重新加载</button>
            </div> : !loadingProjects && !workspaces.length && <p className="team-notice">还没有项目。打开本机的项目文件夹即可开始。</p>}
          </>)}
      </div>
    </main>
  </>;
}
