import { Folder, Package, Plug, Sparkles, SquareTerminal } from 'lucide-react';
import { FileKindIcon } from '../../shared/FileKindIcon';
import { SubagentAvatar } from '../subagents/SubagentAvatar';
import type { Reference } from './references';
import './styles/reference-chip.css';

const capabilityLabels = { skill: '技能', mcp: 'MCP', plugin: '插件', agent: '智能体', file: '文件' };

/** Shared by the editor and transcript. Raw paths only live in the token/title. */
export function ReferenceChip({ reference, command }: { reference: Reference; command?: boolean }) {
  const folder = reference.kind === 'file' && /[/\\]$/u.test(reference.location || '');
  const Icon = command ? SquareTerminal : reference.kind === 'skill' ? Sparkles : reference.kind === 'mcp' ? Plug
    : reference.kind === 'plugin' ? Package : folder ? Folder : null;
  const kind = command ? 'command' : folder ? 'folder' : reference.kind;
  const title = reference.kind === 'agent' ? reference.token[0] + reference.label
    : reference.capabilityId ? capabilityLabels[reference.kind] + ' · ' + reference.label : reference.location || reference.token;
  return <span className={`ref-chip is-${kind}`} title={title}
    data-reference-token={reference.token} contentEditable={false}>
    {reference.kind === 'agent' ? <SubagentAvatar id={reference.avatarId || ''} />
      : Icon ? <Icon aria-hidden="true" /> : <FileKindIcon path={reference.location || reference.label} />}
    <span className="ref-chip-label">{reference.label}</span>
  </span>;
}
