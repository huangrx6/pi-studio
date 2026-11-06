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
import { previewFormatForFile } from './file-preview.mjs';

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

/** Reuse the same file-type marks in tree rows and preview headers. */
export function FileKindIcon({ path, className = '' }: { path: string; className?: string }) {
  const format = previewFormatForFile(path) as FilePreviewFormat;
  return <span className={className} aria-hidden="true"><FileFormatIcon format={format} /></span>;
}
