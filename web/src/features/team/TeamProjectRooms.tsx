import { useId } from 'react';
import { Bot, MessagesSquare, Plus, UsersRound } from 'lucide-react';
import type { TeamBot, TeamRoom } from '../../types/team';
import './styles/team-project-rooms.css';

type Props = {
  projectName: string;
  rooms: TeamRoom[];
  bots: TeamBot[];
  roomId?: string;
  onOpenRoom: (id: string) => void;
  onCreateRoom: () => void;
  onManageMembers: (room: TeamRoom) => void;
};

export function TeamProjectRooms({ projectName, rooms, bots, roomId, onOpenRoom, onCreateRoom, onManageMembers }: Props) {
  const detailId = useId();
  const room = rooms.find(item => item.id === roomId);
  const members = room ? bots.filter(bot => room.botIds.includes(bot.id)) : [];

  return <section className="team-project-rooms" aria-label={`${projectName}的群聊`}>
    <header className="team-rooms-heading">
      <h2>群聊</h2>
      <button type="button" className="team-room-action" onClick={onCreateRoom}>
        <Plus aria-hidden="true" />新建群聊
      </button>
    </header>
    {rooms.length === 0 ? <div className="team-room-placeholder">
      <MessagesSquare aria-hidden="true" />
      <h3>暂无群聊</h3>
      <p>新建群聊后，可以添加参与讨论的 Bot 成员。</p>
    </div> : <div className="team-room-browser">
      <nav className="team-room-list" aria-label="项目群聊列表">
        {rooms.map(item => <button type="button" key={item.id}
          aria-controls={detailId} aria-current={item.id === room?.id ? 'true' : undefined}
          onClick={() => onOpenRoom(item.id)}>
          <MessagesSquare aria-hidden="true" /><span>{item.name}</span>
        </button>)}
      </nav>
      <section id={detailId} className="team-room-detail" aria-label={room?.name || '群聊详情'}>
        {room ? <>
          <header className="team-room-title"><h3>{room.name}</h3></header>
          <div className="team-room-members">
            <div className="team-room-members-heading">
              <h4>Bot 成员</h4>
              <button type="button" className="team-room-action" onClick={() => onManageMembers(room)}>
                <UsersRound aria-hidden="true" />管理成员
              </button>
            </div>
            {members.length ? <ul aria-label="群聊成员">
              {members.map(bot => <li key={bot.id}><Bot aria-hidden="true" /><span>{bot.name}</span></li>)}
            </ul> : <p>尚未添加 Bot 成员。</p>}
          </div>
          <div className="team-room-conversation">
            <MessagesSquare aria-hidden="true" />
            <p>群聊消息功能尚未开放。</p>
          </div>
        </> : <div className="team-room-placeholder">
          <MessagesSquare aria-hidden="true" /><h3>选择一个群聊</h3>
          <p>打开群聊即可查看成员。</p>
        </div>}
      </section>
    </div>}
  </section>;
}
