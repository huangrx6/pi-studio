import { Folder, Sparkles, SquareTerminal } from 'lucide-react';
import { FileKindIcon } from '../../shared/FileKindIcon';
import type { Reference } from './references';

/** Shared by the editor and transcript. Raw paths only live in the token/title. */
export function ReferenceChip({ reference, command }: { reference: Reference; command?: boolean }) {
  const folder = reference.kind === 'file' && /[/\\]$/u.test(reference.location || '');
  const Icon = command ? SquareTerminal : reference.kind === 'skill' ? Sparkles : folder ? Folder : null;
  const kind = command ? 'command' : reference.kind === 'skill' ? 'skill' : folder ? 'folder' : 'file';
  return <span className={`ref-chip is-${kind}`} title={reference.location || reference.token}
    data-reference-token={reference.token} contentEditable={false}>
    {Icon ? <Icon aria-hidden="true" /> : <FileKindIcon path={reference.location || reference.label} />}
    <span className="ref-chip-label">{reference.label}</span>
  </span>;
}
