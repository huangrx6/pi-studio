/**
 * 附件图标：根据文件名扩展名（必要时结合 MIME）挑选 lucide 图标、色调 class
 * 和右上角的扩展名角标。纯展示组件，不涉及 IPC。
 *
 * 被用户消息的附件卡片（ChatMessage.tsx）和输入框附件列表共用；
 * `is-image` 等 tone 对应的样式定义在 app.css 中。
 */
import { File, FileArchive, FileCode2, FileImage, FileSpreadsheet, FileText } from 'lucide-react';

/** 图标、色调与角标文本的组合；tone 会拼到容器的 className 上。 */
type AttachmentVisual = { Icon: typeof File; tone: string; label: string };

/**
 * 计算附件的视觉表示。
 *
 * 判断顺序是「图片 → 压缩包 → 表格 → 代码 → 文档 → 兜底」，先命中先返回：
 * 这样像 .svg 这类同时像图片和代码的扩展名会稳定落到图片分支。
 * 扩展名为空（文件名以 . 结尾或为空）时 label 用分类缩写兜底；
 * 注意 `split('.').pop()` 对无点文件名会返回整个名字，因此 Makefile 这类文件
 * 会直接显示文件名作为角标，这是既有行为。
 *
 * @param name 文件名（含扩展名）
 * @param mime 可选 MIME；图片和压缩包主要靠它兜底没有扩展名的情况
 */
export function attachmentVisual(name: string, mime = ''): AttachmentVisual {
  const ext = (name.split('.').pop() || '').toLowerCase();
  if (mime.startsWith('image/') || ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'avif'].includes(ext)) return { Icon: FileImage, tone: 'is-image', label: ext || 'IMG' };
  if (['zip', 'tar', 'gz', 'tgz', 'rar', '7z', 'bz2', 'xz'].includes(ext) || /zip|tar|archive/.test(mime)) return { Icon: FileArchive, tone: 'is-archive', label: ext || 'ZIP' };
  if (['csv', 'xls', 'xlsx', 'numbers', 'ods'].includes(ext)) return { Icon: FileSpreadsheet, tone: 'is-sheet', label: ext || 'SHEET' };
  if (['ts', 'tsx', 'js', 'jsx', 'py', 'go', 'rs', 'java', 'kt', 'swift', 'c', 'cpp', 'h', 'css', 'scss', 'html', 'json', 'yaml', 'yml', 'toml', 'sh', 'sql'].includes(ext)) return { Icon: FileCode2, tone: 'is-code', label: ext || 'CODE' };
  if (['md', 'txt', 'log', 'pdf', 'doc', 'docx', 'rtf', 'pptx', 'ppt'].includes(ext)) return { Icon: FileText, tone: 'is-doc', label: ext || 'TXT' };
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
