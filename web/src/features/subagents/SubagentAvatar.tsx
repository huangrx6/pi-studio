import { Bot } from 'lucide-react';
import './styles/subagent-avatar.css';

const portraits = import.meta.glob<string>('./avatars/*.webp', { eager: true, import: 'default' });

export function SubagentAvatar({ id }: { id: string }) {
  const src = portraits[`./avatars/${id}.webp`];
  return src
    ? <img className="subagent-avatar" src={src} alt="" draggable={false} />
    : <Bot className="subagent-avatar" aria-hidden="true" />;
}
