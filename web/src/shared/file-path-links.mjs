/**
 * Local-path detection for rendered chat markdown.
 *
 * Model output frequently mentions deliverables such as `travel/一周旅游计划.md`
 * or `/Users/me/report.pdf`. Those are files on disk, so they should behave like
 * the file chips elsewhere in Studio: click opens the preview, right click
 * offers Finder and "open with".
 *
 * The rules stay deliberately conservative: a candidate must either start with
 * an explicit path root, or end in a known file extension. Anything that could
 * be prose (spaces, punctuation-heavy, URLs, emails) is left as plain text.
 */

export const KNOWN_EXTENSIONS = new Set([
  'aac', 'ai', 'apk', 'avif', 'bash', 'bmp', 'c', 'cc', 'cfg', 'conf', 'cpp', 'cs',
  'css', 'csv', 'dmg', 'doc', 'docx', 'eot', 'epub', 'exe', 'gif', 'go', 'gz', 'h',
  'heic', 'hpp', 'htm', 'html', 'ico', 'ini', 'java', 'jpeg', 'jpg', 'js', 'json',
  'jsonl', 'jsx', 'kt', 'less', 'lock', 'log', 'md', 'mdx', 'mkv', 'mov', 'mp3',
  'mp4', 'mjs', 'cjs', 'otf', 'pdf', 'php', 'plist', 'png', 'ppt', 'pptx', 'py',
  'rb', 'rpm', 'rs', 'rst', 'sass', 'scss', 'sh', 'sql', 'sqlite', 'svg', 'swift',
  'tar', 'tex', 'tgz', 'toml', 'ts', 'tsx', 'ttf', 'txt', 'vue', 'wav', 'webm',
  'webp', 'woff', 'woff2', 'xls', 'xlsx', 'xml', 'yaml', 'yml', 'zip', 'zsh',
]);

/** Trailing prose punctuation that is not part of a path. */
const TRAILING = /[.,;:!?，。、；：！？）」』】》〉”’]$/u;

const URL_LIKE = /^[a-z][a-z0-9+.-]*:\/\//i;
const SCHEME_LIKE = /^(mailto|data|tel|javascript):/i;

export function isWebUrl(text) {
  return /^https?:\/\/\S+$/i.test(text.trim());
}

function extensionOf(path) {
  const name = path.split('/').pop() || '';
  const dot = name.lastIndexOf('.');
  if (dot <= 0 || dot === name.length - 1) return '';
  return name.slice(dot + 1).toLowerCase();
}

/** Strip wrapping punctuation that markdown prose often glues to a path. */
export function trimPathPunctuation(text) {
  let value = String(text || '').trim();
  for (let index = 0; index < 8 && value; index += 1) {
    const next = value.replace(TRAILING, '');
    if (next === value) break;
    value = next.trim();
  }
  return value;
}

/**
 * Return the path a token refers to, or null when the token is ordinary prose.
 *
 * @param {string} raw candidate token, already whitespace-delimited
 */
export function pathToken(raw) {
  const text = trimPathPunctuation(raw);
  if (!text || text.length > 400) return null;
  if (/\s/.test(text)) return null;
  if (URL_LIKE.test(text) || SCHEME_LIKE.test(text)) return null;
  if (text.startsWith('#') || text.startsWith('@')) return null;
  // Prose glued to a path ("已交付（travel/") never survives: parentheses,
  // CJK punctuation and quotes cannot appear in a path we link.
  if (/[（）()「」『』【】《》〈〉“”‘’"'`,;:：；，。！？、]/.test(text)) return null;
  // A bare word is never enough: it must either carry a path root or a known
  // extension, otherwise "readme" and "TODO" would turn into links.
  const rooted = text.startsWith('/') || text.startsWith('~/') || text.startsWith('./') || text.startsWith('../');
  if (rooted) return text.length > (text.startsWith('/') ? 1 : 2) ? text : null;
  if (!text.includes('/')) return KNOWN_EXTENSIONS.has(extensionOf(text)) ? text : null;
  if (text.startsWith('-') || text.includes('..') && !text.startsWith('../')) return null;
  // A directory token is only a path when every segment is path-shaped, so
  // "已交付（travel/" stays prose while "travel/" links.
  if (text.endsWith('/')) return /^[\w.@~/-]+$/.test(text) && text.length > 1 ? text : null;
  return KNOWN_EXTENSIONS.has(extensionOf(text)) ? text : null;
}

/** Resolve a detected token against the conversation working directory. */
export function resolvePathToken(token, cwd = '') {
  const text = String(token || '');
  if (!text) return '';
  if (text.startsWith('~/')) {
    // The renderer never sees the home directory; the main process expands it.
    return text;
  }
  if (text.startsWith('/')) return text;
  const root = String(cwd || '').replace(/\/+$/, '');
  if (!root) return text;
  const parts = `${root}/${text}`.split('/');
  const stack = [];
  for (const part of parts) {
    if (!part || part === '.') continue;
    if (part === '..') stack.pop();
    else stack.push(part);
  }
  return `/${stack.join('/')}`;
}

/** True when a whole rendered code span is just a path. */
export function isPathOnly(text) {
  return pathToken(text) !== null;
}
