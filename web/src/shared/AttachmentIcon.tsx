import { File, FileChartColumnIncreasing, FileSpreadsheet, FileText, type LucideIcon } from 'lucide-react';
import type { CSSProperties } from 'react';
import { iconColors, lightIcons } from 'virtual:studio-file-icons';
import { FileKindIcon } from './FileKindIcon';
import { fileIconId } from './file-icon';

const documentOutlines = new Map<string, LucideIcon>([
  ['file', File], ['word', FileText], ['document', FileText], ['pdf', File],
  ['table', FileSpreadsheet], ['powerpoint', FileChartColumnIncreasing],
]);

export function AttachmentIcon({ name, mime, className = '' }: { name: string; mime?: string; className?: string }) {
  const kind = fileIconId(name, mime);
  const Outline = documentOutlines.get(kind);
  const classes = `attachment-icon ${className}`.trim();
  if (!Outline) {
    return <span className={classes} aria-hidden="true" data-file-icon={kind}>
      <FileKindIcon path={name} mime={mime} />
    </span>;
  }
  const ink = iconColors[kind];
  const light = lightIcons[kind];
  const style = {
    '--attachment-ink': ink,
    '--attachment-light-ink': light ? iconColors[light] : ink,
  } as CSSProperties;
  return <span className={classes} aria-hidden="true" data-file-icon={kind} style={style}>
    <Outline>
      {kind === 'pdf' && <text x="12" y="17.25" textAnchor="middle" fontSize="5.9"
        fontWeight="400" stroke="none" fill="currentColor">PDF</text>}
    </Outline>
  </span>;
}
