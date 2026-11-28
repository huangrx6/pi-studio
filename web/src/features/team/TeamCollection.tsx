import { useEffect, useState } from 'react';
import { Bot, Plus } from 'lucide-react';
import { errorText } from '../../shared/error-text';
import { LoadingState } from '../../shared/LoadingState';
import { SettingsDialog } from '../../shared/SettingsDialog';
import type { TeamBot, TeamProjectState, TeamRoom } from '../../types/team';
import { TeamProjectRooms } from './TeamProjectRooms';

type TeamEditor = { kind: 'bot' } | { kind: 'room' } | { kind: 'members'; room: TeamRoom };

function TeamEditDialog({ editor, bots, onSave, onClose }: {
  editor: TeamEditor;
  bots: TeamBot[];
  onSave: (name: string, botIds: string[]) => Promise<void>;
  onClose: () => void;
}) {
  const [name, setName] = useState('');
  const [botIds, setBotIds] = useState(editor.kind === 'members' ? editor.room.botIds : []);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const members = editor.kind === 'members';
  const title = members ? '管理群聊成员' : editor.kind === 'bot' ? '新建 Bot' : '新建群聊';
  return <SettingsDialog title={title} description={members ? editor.room.name : undefined}
    action={members ? '保存成员' : '创建'} busy={busy} loading={false} error={error}
    unavailable={members ? !bots.length : !name.trim()} onClose={onClose}
    onSubmit={async dismiss => {
      setBusy(true);
      setError(null);
      try {
        await onSave(name.trim(), botIds);
        await dismiss(onClose);
      } catch (cause) {
        setBusy(false);
        setError(errorText(cause));
      }
    }}>
    {members ? <div className="team-member-options">
      {bots.length ? bots.map(bot => <label key={bot.id}>
        <input type="checkbox" checked={botIds.includes(bot.id)} onChange={event =>
          setBotIds(event.target.checked ? [...botIds, bot.id] : botIds.filter(id => id !== bot.id))} />
        <span>{bot.name}</span>
      </label>) : <p>还没有可邀请的 Bot。请先在「Bot 成员」中新建 Bot。</p>}
    </div> : <label className="settings-field"><span>{editor.kind === 'bot' ? 'Bot 名称' : '群聊名称'}</span>
      <input value={name} maxLength={100} onChange={event => setName(event.target.value)} />
    </label>}
  </SettingsDialog>;
}

export function TeamCollection({ project, roomId, onOpenRoom }: {
  project?: { cwd: string; name: string };
  roomId?: string;
  onOpenRoom?: (id: string) => void;
}) {
  const [state, setState] = useState<TeamProjectState | null>(null);
  const [editor, setEditor] = useState<TeamEditor | null>(null);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const cwd = project?.cwd;
  useEffect(() => {
    let active = true;
    async function load() {
      try {
        const result = await window.piApi.teamProject(cwd);
        if (active) setState(result);
      } catch (cause) {
        if (active) setError(errorText(cause));
      }
    }
    void load();
    return () => { active = false; };
  }, [cwd, attempt]);

  if (error) return <div role="alert" className="team-notice">{error}
    <button className="secondary-button" onClick={() => { setError(''); setAttempt(n => n + 1); }}>重试</button>
  </div>;
  if (!state) return <LoadingState>正在读取团队资料…</LoadingState>;

  async function save(name: string, botIds: string[]) {
    if (editor?.kind === 'bot') {
      const bot = await window.piApi.teamCreateBot(name);
      setState(current => current && { ...current, bots: [...current.bots, bot] });
    } else if (editor?.kind === 'room' && cwd) {
      const room = await window.piApi.teamCreateRoom(cwd, name);
      setState(current => current && { ...current, rooms: [...current.rooms, room] });
      onOpenRoom?.(room.id);
    } else if (editor?.kind === 'members' && cwd) {
      const room = await window.piApi.teamSetRoomBots(cwd, editor.room.id, botIds);
      setState(current => current && { ...current, rooms: current.rooms.map(item => item.id === room.id ? room : item) });
    }
  }

  return <>
    {project && onOpenRoom ? <>
      <h1>{project.name}</h1>
      <TeamProjectRooms projectName={project.name} rooms={state.rooms} bots={state.bots}
        roomId={roomId} onOpenRoom={onOpenRoom} onCreateRoom={() => setEditor({ kind: 'room' })}
        onManageMembers={room => setEditor({ kind: 'members', room })} />
    </> : <>
      <div className="team-heading-row"><h1>Bot 成员</h1>
        <button type="button" className="secondary-button" onClick={() => setEditor({ kind: 'bot' })}><Plus />新建 Bot</button>
      </div>
      <p>成员库中的 Bot 可以加入不同项目的群聊。智能体运行配置将在后续开放。</p>
      {state.bots.length ? <ul className="team-roster" aria-label="Bot 成员列表">
        {state.bots.map(bot => <li key={bot.id}><Bot aria-hidden="true" />{bot.name}</li>)}
      </ul> : <p className="team-notice">暂无 Bot 成员</p>}
      <dl className="team-roles">
        <div><dt>团队负责人 <span>Super Agent</span></dt><dd>确定优先级、分派任务、验收结果。</dd></div>
        <div><dt>执行成员 <span>Bot</span></dt><dd>使用各自配置的智能体完成任务，在群聊中交付成果。</dd></div>
      </dl>
    </>}
    {editor && <TeamEditDialog editor={editor} bots={state.bots} onSave={save} onClose={() => setEditor(null)} />}
  </>;
}
