import { Folder, Sparkles, SquareTerminal } from 'lucide-react';
import { attachmentVisual } from '../../shared/AttachmentIcon';
import type { Reference } from './references';

/** Shared by the editor and transcript. Raw paths only live in the token/title. */
export function ReferenceChip({ reference, command }: { reference: Reference; command?: boolean }) {
  const folder = reference.kind === 'file' && /[/\\]$/u.test(reference.location || '');
  const visual = attachmentVisual(reference.label);
  const Icon = command ? SquareTerminal : reference.kind === 'skill' ? Sparkles : folder ? Folder : visual.Icon;
  const kind = command ? 'command' : reference.kind === 'skill' ? 'skill' : folder ? 'folder' : visual.tone.slice(3);
  return <span className={`ref-chip is-${kind}`} title={reference.location || reference.token}
    data-reference-token={reference.token} contentEditable={false}>
    <Icon aria-hidden="true" />
    <span className="ref-chip-label">{reference.label}</span>
  </span>;
}
