/**
 * 附件图标：根据文件名扩展名（必要时结合 MIME）挑选 lucide 图标、色调 class
 * 和右上角的扩展名角标。纯展示组件，不涉及 IPC。
 *
 * 被用户消息的附件卡片（ChatMessage.tsx）和输入框附件列表共用；
 * `is-image` 等 tone 对应的样式定义在 app.css 中。
 */
import { Database, File, FileArchive, FileAudio2, FileCode2, FileImage, FileJson2, FileSliders, FileSpreadsheet, FileTerminal, FileText, FileType2, FileVideo2, Presentation } from 'lucide-react';

/** 图标、色调与角标文本的组合；tone 会拼到容器的 className 上。 */
type AttachmentVisual = { Icon: typeof File; tone: string; label: string };

/**
 * 计算附件的视觉表示。
 *
 * 按文件名、格式及 MIME 区分代码、配置、数据、文档、媒体和归档。
 * 无法识别的文件使用通用图标；引用标签和附件列表共用这套映射。
 *
 * @param name 文件名（含扩展名）
 * @param mime 可选 MIME；图片和压缩包主要靠它兜底没有扩展名的情况
 */
export function attachmentVisual(name: string, mime = ''): AttachmentVisual {
  const ext = (typeof name === 'string' ? name.split('.').pop() || '' : '').toLowerCase();
  mime = typeof mime === 'string' ? mime.toLowerCase() : '';
  const base = typeof name === 'string' ? name.split(/[/\\]/).pop()?.toLowerCase() || '' : '';
  if (['json', 'jsonc', 'json5', 'ipynb'].includes(ext)) return { Icon: FileJson2, tone: 'is-code', label: ext };
  if (['yaml', 'yml', 'toml', 'ini', 'conf', 'config', 'env', 'properties'].includes(ext) || base.startsWith('.env.') || ['.gitignore', '.gitattributes', '.editorconfig', '.npmrc'].includes(base)) return { Icon: FileSliders, tone: 'is-code', label: ext };
  if (['sh', 'bash', 'zsh', 'fish', 'ps1', 'bat', 'cmd'].includes(ext) || ['dockerfile', 'makefile', 'justfile'].includes(base)) return { Icon: FileTerminal, tone: 'is-code', label: ext };
  if (['sql', 'db', 'sqlite', 'sqlite3'].includes(ext)) return { Icon: Database, tone: 'is-code', label: ext };
  if (mime.startsWith('audio/') || ['mp3', 'wav', 'flac', 'aac', 'ogg', 'm4a', 'aiff'].includes(ext)) return { Icon: FileAudio2, tone: 'is-audio', label: ext || 'AUDIO' };
  if (mime.startsWith('video/') || ['mp4', 'mov', 'webm', 'avi', 'mkv', 'm4v'].includes(ext)) return { Icon: FileVideo2, tone: 'is-video', label: ext || 'VIDEO' };
  if (['ppt', 'pptx', 'key', 'odp'].includes(ext)) return { Icon: Presentation, tone: 'is-doc', label: ext };
  if (['pdf', 'epub'].includes(ext) || mime === 'application/pdf') return { Icon: FileType2, tone: 'is-doc', label: ext || 'PDF' };
  if (mime.startsWith('image/') || ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'avif', 'ico', 'bmp', 'tif', 'tiff', 'heic'].includes(ext)) return { Icon: FileImage, tone: 'is-image', label: ext || 'IMG' };
  if (['zip', 'tar', 'gz', 'tgz', 'rar', '7z', 'bz2', 'xz'].includes(ext) || /zip|tar|archive/.test(mime)) return { Icon: FileArchive, tone: 'is-archive', label: ext || 'ZIP' };
  if (['csv', 'xls', 'xlsx', 'numbers', 'ods', 'tsv'].includes(ext)) return { Icon: FileSpreadsheet, tone: 'is-sheet', label: ext || 'SHEET' };
  if (['ts', 'tsx', 'js', 'jsx', 'py', 'go', 'rs', 'java', 'kt', 'swift', 'c', 'cpp', 'h', 'css', 'scss', 'html', 'json', 'yaml', 'yml', 'toml', 'sh', 'sql', 'vue', 'svelte', 'mjs', 'cjs', 'mts', 'cts', 'rb', 'php', 'cs', 'lua', 'r', 'dart', 'xml', 'graphql', 'gql', 'ipynb'].includes(ext)) return { Icon: FileCode2, tone: 'is-code', label: ext || 'CODE' };
  if (['md', 'txt', 'log', 'pdf', 'doc', 'docx', 'rtf', 'pptx', 'ppt', 'mdx', 'rst', 'adoc', 'odt'].includes(ext)) return { Icon: FileText, tone: 'is-doc', label: ext || 'TXT' };
  return { Icon: File, tone: 'is-generic', label: ext || 'FILE' };
}

/**
 * 附件图标组件。
 *
 * @param name 文件名，用于推断类型和扩展名角标
 * @param mime 可选 MIME，参与图片/压缩包判断
 * @param className 额外 class（由调用方控制尺寸或间距）
 */
export function AttachmentIcon({ name, mime, className = '' }: { name: string; mime?: string; className?: string }) {
  const { Icon, tone } = attachmentVisual(name, mime);
  return <span className={`attachment-icon ${tone} ${className}`}><Icon /></span>;
}
