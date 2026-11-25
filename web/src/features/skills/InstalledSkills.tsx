import { useState } from 'react';
import { BookOpen, ChevronRight, Folder, FolderOpen, Folders, Library, Puzzle, Trash2, X } from 'lucide-react';
import { Accordion } from '../../shared/Accordion';
import { DetailDialog } from '../../shared/DetailDialog';
import { StatusGlyph } from '../../shared/StatusGlyph';
import {
  isPluginOwnedResource,
  pluginOwnershipBadge,
  pluginOwnershipLabel,
} from '../../shared/plugin-ownership.ts';
import { installedSkillStatus } from './installed-skill-status';
import './styles/skill-library.css';
import './styles/installed-skills.css';

const DEFAULT_OPEN_GROUP_LIMIT = 5;
const SKILL_GROUPS = [
  { key: 'userStudio', pathKey: 'userStudio', title: 'Studio 应用技能', scope: 'user', origin: 'studio', icon: BookOpen },
  { key: 'userPlugin', pathKey: null, title: '插件技能', scope: 'user', origin: 'plugin', icon: Puzzle },
  { key: 'userAgents', pathKey: 'userAgents', title: '共享技能', scope: 'user', origin: 'agents', icon: Library },
  { key: 'projectStudio', pathKey: 'projectStudio', title: 'Studio 项目技能', scope: 'project', origin: 'studio', icon: Folder },
  { key: 'projectAgents', pathKey: 'projectAgents', title: '项目共享技能', scope: 'project', origin: 'agents', icon: Folders },
] as const;

export type InstalledSkill = {
  name: string;
  description: string;
  path: string;
  scope: 'user' | 'project';
  origin: 'studio' | 'agents' | 'plugin';
  ownerPluginId?: string;
  managed?: boolean;
  userOverride?: boolean;
  available: boolean;
  trusted: boolean;
  trustChanged: boolean;
  disableModelInvocation: boolean;
};

export function InstalledSkills<T extends InstalledSkill>({ skills, errors, paths, workspaceName, busy, onOpen, onTrust, onDelete }: {
  skills: readonly T[];
  errors: readonly { path: string; message: string }[];
  paths: { userStudio: string; userAgents: string; projectStudio: string; projectAgents: string };
  workspaceName?: string;
  busy: boolean;
  onOpen: (skill: T) => void;
  onTrust: (skill: T) => void;
  onDelete: (skill: T) => void;
}) {
  const [showDirectories, setShowDirectories] = useState(false);
  const directories = SKILL_GROUPS.flatMap(({ pathKey, title }) =>
    pathKey && paths[pathKey] ? [{ title, path: paths[pathKey] }] : []);
  const groups = SKILL_GROUPS.map(group => ({
    ...group,
    items: skills.filter(skill => skill.scope === group.scope && skill.origin === group.origin),
  })).filter(group => group.items.length > 0);
  return <section className="installed-skills" aria-label="已安装技能">
    <header className="skill-library-heading">
      <h2>已安装技能{groups.length > 1 && <span>{skills.length}</span>}</h2>
      {directories.length > 0 && <button type="button" className="skill-library-action" aria-haspopup="dialog" onClick={() => setShowDirectories(true)}>
        <FolderOpen aria-hidden="true" />技能目录
      </button>}
    </header>
    {!skills.length ? <div className="installed-skills-empty">
      <p>还没有已安装技能</p>
      <span>可以从技能源安装，也可以把技能放进工作区的技能目录。</span>
    </div> : <div className="skill-library-list">
      {groups.map(group => {
        const { key, title, icon: Icon, scope, items } = group;
        return <section className="installed-skill-group" aria-label={title} key={key}>
        <Accordion summaryClassName="installed-skill-group-heading" defaultOpen={items.length <= DEFAULT_OPEN_GROUP_LIMIT} badge={`${items.length} 个`} summary={<>
          <span className="skill-group-badge" data-origin={group.origin} aria-hidden="true"><Icon /></span>
          <strong>{title}</strong>
          {scope === 'project' && workspaceName && <small title={workspaceName}>{workspaceName}</small>}
        </>}>
          <ul className="installed-skill-list">
            {items.map(skill => {
              const status = installedSkillStatus(skill);
              const pluginOwned = isPluginOwnedResource(skill);
              const pluginManaged = pluginOwned && skill.managed && !skill.userOverride;
              const pluginLabel = pluginOwnershipLabel(skill.ownerPluginId);
              return <li className="installed-skill-row" data-availability={skill.available ? 'available' : 'unavailable'} data-invocation={skill.disableModelInvocation ? 'explicit' : 'auto'} key={skill.path}>
                <div className="installed-skill-copy">
                  <button type="button" className="installed-skill-open settings-row-link" title={skill.path} aria-label={`查看技能 ${skill.name}`} onClick={() => onOpen(skill)}>
                    <strong>{skill.name}</strong><ChevronRight className="settings-row-link-indicator" aria-hidden="true" />
                  </button>
                  <p title={skill.description}>{skill.description}</p>
                  {(pluginOwned || status.label !== '自动发现') && <div className="installed-skill-meta">
                    {pluginOwned && <span className="installed-skill-origin">{pluginOwnershipBadge(skill)}</span>}
                    {status.label !== '自动发现' && <span className="installed-skill-status"><StatusGlyph state={skill.available ? 'off' : 'attention'} />{status.label}</span>}
                  </div>}
                </div>
                <div className="installed-skill-actions">
                  {status.canTrust && <button type="button" className="settings-text-button" disabled={busy} onClick={() => onTrust(skill)}>{status.trustLabel}</button>}
                  <button
                    type="button"
                    className="icon-button"
                    data-destructive="true"
                    aria-label={pluginManaged ? `请在插件页卸载「${pluginLabel}」` : `删除技能 ${skill.name}`}
                    title={pluginManaged ? '由插件托管，请在「插件」页卸载所属插件' : '删除技能'}
                    disabled={busy || pluginManaged}
                    onClick={() => onDelete(skill)}
                  ><Trash2 /></button>
                </div>
              </li>;
            })}
          </ul>
        </Accordion>
      </section>;
      })}
    </div>}
    {showDirectories && <DetailDialog className="skill-directories-dialog" onClose={() => setShowDirectories(false)}>{close => <>
      <header className="detail-header">
        <div className="detail-heading"><h2>技能目录</h2></div>
        <button type="button" className="icon-button" aria-label="关闭技能目录" onClick={close}><X aria-hidden="true" /></button>
      </header>
      <div className="detail-body"><dl className="skill-directory-list">
        {directories.map(({ title, path }) => <div key={title}><dt>{title}</dt><dd><code>{path}</code></dd></div>)}
      </dl></div>
    </>}</DetailDialog>}
    {errors.length > 0 && <section className="installed-skill-diagnostics" aria-label="技能检查提示">
      <h3>检查提示</h3>
      <ul>{errors.map(error => <li key={`${error.path}:${error.message}`}><code>{error.path}</code><p>{error.message}</p></li>)}</ul>
    </section>}
  </section>;
}
