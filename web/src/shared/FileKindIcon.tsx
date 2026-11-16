import {
  FileArchive,
  FileCode2,
  FileJson,
  FileSpreadsheet,
  FileText,
  Image as ImageIcon,
  Music2,
  Video,
} from 'lucide-react';
import type { CSSProperties } from 'react';
import { lightIcons, urls } from 'virtual:studio-file-icons';
import { fileIconId } from './file-icon';

export type FilePreviewFormat =
  | 'markdown'
  | 'json'
  | 'csv'
  | 'code'
  | 'text'
  | 'html'
  | 'pdf'
  | 'image'
  | 'audio'
  | 'video'
  | 'unsupported';

export function FileFormatIcon({ format }: { format: FilePreviewFormat }) {
  if (format === 'markdown' || format === 'text' || format === 'pdf') return <FileText />;
  if (format === 'html') return <FileCode2 />;
  if (format === 'json') return <FileJson />;
  if (format === 'csv') return <FileSpreadsheet />;
  if (format === 'code') return <FileCode2 />;
  if (format === 'image') return <ImageIcon />;
  if (format === 'audio') return <Music2 />;
  if (format === 'video') return <Video />;
  return <FileArchive />;
}

/** Decorative identity for a specific file; the adjacent filename supplies the label. */
export function FileKindIcon({ path, mime, className = '' }: { path: string; mime?: string; className?: string }) {
  const id = fileIconId(path, mime);
  const light = lightIcons[id];
  return <img alt="" aria-hidden="true" draggable={false} width={16} height={16} data-file-icon={id} data-light-file-icon={light}
    className={`studio-file-icon ${className}`}
    style={light ? { '--light-file-icon': `url("${urls[light]}")` } as CSSProperties : undefined}
    src={urls[id]} />;
}
