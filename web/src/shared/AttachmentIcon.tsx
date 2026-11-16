import { FileKindIcon } from './FileKindIcon';

export function AttachmentIcon({ name, mime, className = '' }: { name: string; mime?: string; className?: string }) {
  return <span className={`attachment-icon ${className}`}><FileKindIcon path={name} mime={mime} /></span>;
}
