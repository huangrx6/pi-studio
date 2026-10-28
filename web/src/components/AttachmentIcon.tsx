import { File, FileArchive, FileCode2, FileImage, FileSpreadsheet, FileText } from 'lucide-react';

type AttachmentVisual = { Icon: typeof File; tone: string; label: string };

export function attachmentVisual(name: string, mime = ''): AttachmentVisual {
  const ext = (name.split('.').pop() || '').toLowerCase();
  if (mime.startsWith('image/') || ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'avif'].includes(ext)) return { Icon: FileImage, tone: 'is-image', label: ext || 'IMG' };
  if (['zip', 'tar', 'gz', 'tgz', 'rar', '7z', 'bz2', 'xz'].includes(ext) || /zip|tar|archive/.test(mime)) return { Icon: FileArchive, tone: 'is-archive', label: ext || 'ZIP' };
  if (['csv', 'xls', 'xlsx', 'numbers', 'ods'].includes(ext)) return { Icon: FileSpreadsheet, tone: 'is-sheet', label: ext || 'SHEET' };
  if (['ts', 'tsx', 'js', 'jsx', 'py', 'go', 'rs', 'java', 'kt', 'swift', 'c', 'cpp', 'h', 'css', 'scss', 'html', 'json', 'yaml', 'yml', 'toml', 'sh', 'sql'].includes(ext)) return { Icon: FileCode2, tone: 'is-code', label: ext || 'CODE' };
  if (['md', 'txt', 'log', 'pdf', 'doc', 'docx', 'rtf', 'pptx', 'ppt'].includes(ext)) return { Icon: FileText, tone: 'is-doc', label: ext || 'TXT' };
  return { Icon: File, tone: 'is-generic', label: ext || 'FILE' };
}

export function AttachmentIcon({ name, mime, className = '' }: { name: string; mime?: string; className?: string }) {
  const { Icon, tone } = attachmentVisual(name, mime);
  return <span className={`attachment-icon ${tone} ${className}`}><Icon /></span>;
}
