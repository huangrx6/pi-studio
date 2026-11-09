import { ChevronRight, Trash2 } from 'lucide-react';
import { EmptyStateArt } from '../../shared/EmptyStateArt';
import { StatusGlyph } from '../../shared/StatusGlyph';
import { installedSkillStatus } from './installed-skill-status';
import './installed-skills.css';

export type InstalledSkill = {
  name: string;
  description: string;
  path: string;
  scope: 'user' | 'project';
  origin: 'studio' | 'agents';
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
  const groups = [
    { key: 'userStudio', title: 'Studio 应用技能', scope: 'user', origin: 'studio', scopeLabel: '用户级' },
    { key: 'userAgents', title: '共享技能', scope: 'user', origin: 'agents', scopeLabel: '用户级 · Agent Skills' },
    { key: 'projectStudio', title: 'Studio 项目技能', scope: 'project', origin: 'studio', scopeLabel: '项目级' },
    { key: 'projectAgents', title: '项目共享技能', scope: 'project', origin: 'agents', scopeLabel: '项目级 · Agent Skills' },
  ] as const;
  const configuredDirectories = groups.filter(group => paths[group.key]);
  const hasProjectSkills = skills.some(skill => skill.scope === 'project');
  const populatedGroupCount = groups.filter(group => skills.some(skill => skill.scope === group.scope && skill.origin === group.origin)).length;
  return <section className="installed-skills" aria-label="已安装技能">
    <header className="installed-skills-heading"><h2>已安装技能</h2>{populatedGroupCount > 1 && <span>{skills.length} 个</span>}</header>
    {hasProjectSkills && <p className="installed-skills-guidance">项目技能需审查目录内容和来源后手动信任；内容变化后，旧信任会失效。</p>}
    {!skills.length && <div className="installed-skills-empty">
      <EmptyStateArt />
      <p>还没有已安装技能</p>
      <span>可以在技能中心安装，或把技能目录放进工作区。</span>
    </div>}
    {groups.map(group => {
      const items = skills.filter(skill => skill.scope === group.scope && skill.origin === group.origin);
      const defaultDiscovery = items.some(skill => skill.available && !skill.disableModelInvocation);
      const directory = paths[group.key];
      if (!items.length) return null;
      return <section className="installed-skill-group" aria-label={group.title} key={group.key}>
        <div className="installed-skill-group-heading">
          <h3>{group.title}</h3><span>{group.scopeLabel}{group.scope === 'project' && workspaceName ? ` · ${workspaceName}` : ''}</span><span>{items.length} 个</span>
          {defaultDiscovery && <span>默认自动发现</span>}
        </div>
        <ul className="installed-skill-list">
          {items.map(skill => {
            const status = installedSkillStatus(skill);
            return <li className="installed-skill-row" data-availability={skill.available ? 'available' : 'unavailable'} data-invocation={skill.disableModelInvocation ? 'explicit' : 'auto'} key={skill.path}>
              <div className="installed-skill-copy">
                <button type="button" className="installed-skill-open" title={skill.path} aria-label={`查看技能 ${skill.name}`} onClick={() => onOpen(skill)}>
                  <strong>{skill.name}</strong><ChevronRight aria-hidden="true" />
                </button>
                <p title={skill.description}>{skill.description}</p>
                {status.label !== '自动发现' && <span className="installed-skill-status"><StatusGlyph state={skill.available && !skill.disableModelInvocation ? 'on' : skill.available ? 'off' : 'attention'} />{status.label}</span>}
              </div>
              <div className="installed-skill-actions">
                {status.canTrust && <button type="button" className="settings-text-button" disabled={busy} onClick={() => onTrust(skill)}>{status.trustLabel}</button>}
                <button type="button" className="icon-button" data-destructive="true" aria-label={`删除技能 ${skill.name}`} title="删除技能" disabled={busy} onClick={() => onDelete(skill)}><Trash2 /></button>
              </div>
            </li>;
          })}
        </ul>
      </section>;
    })}
    {configuredDirectories.length > 0 && <details className="installed-skills-directories">
      <summary>技能目录</summary>
      <dl>{configuredDirectories.map(group => <div key={group.key}><dt>{group.title}</dt><dd><code>{paths[group.key]}</code></dd></div>)}</dl>
    </details>}
    {errors.length > 0 && <section className="installed-skill-diagnostics" aria-label="技能检查提示">
      <h3>检查提示</h3>
      <ul>{errors.map(error => <li key={`${error.path}:${error.message}`}><code>{error.path}</code><p>{error.message}</p></li>)}</ul>
    </section>}
  </section>;
}
