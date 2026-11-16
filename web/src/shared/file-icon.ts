import { fileExtensions, fileNames } from 'virtual:studio-file-icons';

const mimeExtensions: Record<string, string> = {
  'application/pdf': 'pdf', 'application/json': 'json', 'application/xml': 'xml',
  'application/zip': 'zip', 'application/gzip': 'gz', 'application/x-tar': 'tar',
  'application/x-7z-compressed': '7z', 'application/vnd.rar': 'rar',
  'text/markdown': 'md', 'text/html': 'html', 'text/csv': 'csv', 'text/javascript': 'js',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
};

/** Scoped names win over basenames, and compound extensions over the last suffix. */
export function fileIconId(path: string, mimeType = ''): string {
  const normalized = path.replaceAll('\\', '/').toLowerCase();
  const name = normalized.slice(normalized.lastIndexOf('/') + 1);
  for (let candidate = normalized; candidate; candidate = candidate.slice(candidate.indexOf('/') + 1)) {
    const icon = fileNames.get(candidate);
    if (icon) return icon;
    if (!candidate.includes('/')) break;
  }
  if (/^(dockerfile|containerfile)\./.test(name)) return 'docker';
  if (/^\.env(?:\.|$)/.test(name)) return 'tune';
  if (/(?:^|\/)\.github\/workflows\/[^/]+\.ya?ml$/.test(normalized)) return 'github-actions-workflow';
  for (let dot = name.indexOf('.'); dot >= 0; dot = name.indexOf('.', dot + 1)) {
    const icon = fileExtensions.get(name.slice(dot + 1));
    if (icon) return icon;
  }
  const mime = mimeType.split(';', 1)[0].trim().toLowerCase();
  if (Object.hasOwn(mimeExtensions, mime)) return fileExtensions.get(mimeExtensions[mime]) || 'file';
  if (mime.endsWith('+json')) return 'json';
  if (mime.endsWith('+xml')) return 'xml';
  const family = mime.split('/')[0];
  if (['image', 'audio', 'video', 'font'].includes(family)) return family;
  return family === 'text' ? 'document' : 'file';
}
