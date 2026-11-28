import { type ReactNode, useRef, useState } from 'react';
import { Bot, Cpu, Plus } from 'lucide-react';
import { LoadingState } from '../../shared/LoadingState';
import { useDeferredEnter } from '../../shared/useDeferredEnter';
import { SettingsPageHeader } from '../../shared/SettingsPageHeader';
import { SettingsProfileLibrary } from '../../shared/SettingsProfileLibrary';
import type { ModelOption } from '../../types/model-types';
import type { SubagentProfile } from '../../types/subagent-types';
import { SubagentAvatar } from './SubagentAvatar';
import { SubagentProfileEditor } from './SubagentProfileEditor';
import { roleAccessLabel, usesFileTools } from './RoleRuntimeFields';
import { refreshSubagentProfiles, useSubagentProfiles } from './useSubagentProfiles';
import './styles/subagent-settings.css';

const emptyProfile: SubagentProfile = {
  id: '', revision: 0, name: '', description: '', instructions: '',
  avatarId: 'indigo-bob', model: '', mcpServers: null, skills: null, harnessId: '', runtimeOverrides: {},
};

function resourceSummary(label: string, items: string[] | null) {
  if (!items) return label + ' 继承';
  return items.length ? label + ' ' + items.length : label + ' 关闭';
}

export function SubagentProfileLibrary({ cwd, models, canDelegate, embedded = false, onOpenAgentTools, defaultsAction }: {
  cwd: string; models?: Pick<ModelOption, 'id' | 'name'>[]; canDelegate?: boolean; embedded?: boolean; onOpenAgentTools?: () => void; defaultsAction: ReactNode;
}) {
  const { rows, ready, error } = useSubagentProfiles();
  const rosterReveal = useDeferredEnter(ready);
  const [editing, setEditing] = useState<{ profile: SubagentProfile; cwd: string } | null>(null);
  const createRef = useRef<HTMLButtonElement>(null);
  const open = (profile: SubagentProfile) => setEditing({ profile, cwd });
  const modelNames = new Map((models || []).map(model => [model.id, model.name]));
  function modelSubtitle(modelRef: string) {
    if (modelRef === 'parent') return '跟随父智能体';
    if (!modelRef) return '跟随运行默认值';
    return modelNames.get(modelRef) || modelRef.split('/').slice(1).join('/') || modelRef;
  }
  function closeEditor() {
    setEditing(null);
    // Creating the first role or deleting a card can remove the original opener.
    requestAnimationFrame(() => {
      if (document.activeElement === document.body) createRef.current?.focus({ preventScroll: true });
    });
  }
  const empty = ready && !error && rows.length === 0;
  const createButton = <button ref={createRef} type="button" className="settings-save" aria-haspopup="dialog"
    onClick={() => open(emptyProfile)} disabled={!ready}><Plus aria-hidden="true" />新建子智能体</button>;
  return <>
    {!embedded && <SettingsPageHeader title="子智能体" iconPosition="end" icon={<Bot />} meta={canDelegate === false
      ? <>在对话中使用 # 引用角色前，请启用子智能体工具。{onOpenAgentTools && <button type="button"
        className="settings-text-button role-enable" onClick={onOpenAgentTools}>去启用</button>}</>
      : '在对话中输入 # 即可调用已配置的角色。'} />}
    {embedded && canDelegate === false && <p className="agents-subagent-hint">
      在对话中使用 <code>#</code> 引用角色前，请先在主对话工具方案中启用 <code>subagent</code> 工具。
      {onOpenAgentTools && <button type="button" className="settings-text-button role-enable" onClick={onOpenAgentTools}>去启用</button>}
    </p>}
    <SettingsProfileLibrary title="角色库" count={rows.length} actions={<>{defaultsAction}{rows.length > 0 && createButton}</>}>
      {error && <div className="settings-load-error"><p role="alert">{error}</p><button type="button" className="settings-outline" onClick={() => void refreshSubagentProfiles()}>重新加载角色</button></div>}
      {!ready && !error && <div className="settings-loading-card"><LoadingState variant="section">正在读取角色…</LoadingState></div>}
      {rows.length > 0 && <div className={`subagent-roster-grid${rosterReveal ? ' settings-async-ready' : ''}`}>{rows.map(profile => {
        const accessTag = profile.runtimeOverrides.allowedTools !== undefined
          ? roleAccessLabel(profile.runtimeOverrides.allowedTools)
          : null;
        const mcpTag = usesFileTools(profile.runtimeOverrides.allowedTools)
          ? 'MCP 关闭'
          : resourceSummary('MCP', profile.mcpServers);
        const skillTag = resourceSummary('技能', profile.skills);
        return <button
          key={profile.id}
          type="button"
          className="settings-preference-card subagent-roster-card"
          aria-label={'编辑' + profile.name}
          aria-haspopup="dialog"
          onClick={() => open(profile)}
        >
          <div className="subagent-roster-head">
            <span className="subagent-roster-avatar"><SubagentAvatar id={profile.avatarId} /></span>
            <div className="subagent-roster-identity">
              <strong>{profile.name}</strong>
              <span className="subagent-roster-model" title={modelSubtitle(profile.model)}>
                <Cpu aria-hidden="true" /><span>{modelSubtitle(profile.model)}</span>
              </span>
            </div>
          </div>
          {profile.description && <p className="subagent-roster-bio">{profile.description}</p>}
          <div className="subagent-roster-tags">
            {accessTag && <span className="subagent-roster-tag is-access">{accessTag}</span>}
            <span className="subagent-roster-tag">{mcpTag}</span>
            <span className="subagent-roster-tag">{skillTag}</span>
          </div>
        </button>;
      })}</div>}
      {empty && <div className="settings-preference-card settings-profile-empty">
        <div className="role-empty-portraits" aria-hidden="true">
          <SubagentAvatar id="boy-copper-curls" /><SubagentAvatar id="indigo-bob" /><SubagentAvatar id="owl-lavender" />
        </div>
        <h3>还没有子智能体</h3>
        <p>创建第一个角色，为它选择模型、工具和技能。</p>
        {createButton}
      </div>}
    </SettingsProfileLibrary>
    {editing && <SubagentProfileEditor initial={editing.profile} cwd={editing.cwd} onClose={closeEditor} />}
  </>;
}
