/**
 * Pure file-preview classification and parsing helpers shared by the renderer.
 * File reads stay in Electron; this module only maps JSON-safe preview data to
 * a renderer mode so every preview surface can use the same behavior.
 */

const FORMAT_BY_EXTENSION = new Map([
  ['md', 'markdown'],
  ['markdown', 'markdown'],
  ['json', 'json'],
  ['jsonl', 'json'],
  ['ndjson', 'json'],
  ['csv', 'csv'],
  ['tsv', 'csv'],
  ['png', 'image'],
  ['jpg', 'image'],
  ['jpeg', 'image'],
  ['gif', 'image'],
  ['webp', 'image'],
  ['avif', 'image'],
  ['bmp', 'image'],
  ['ico', 'image'],
  ['svg', 'image'],
  ['mp3', 'audio'],
  ['wav', 'audio'],
  ['ogg', 'audio'],
  ['oga', 'audio'],
  ['m4a', 'audio'],
  ['aac', 'audio'],
  ['flac', 'audio'],
  ['mp4', 'video'],
  ['webm', 'video'],
  ['mov', 'video'],
  ['m4v', 'video'],
  ['ogv', 'video'],
  ['pdf', 'unsupported'],
  ['doc', 'unsupported'],
  ['docx', 'unsupported'],
  ['xls', 'unsupported'],
  ['xlsx', 'unsupported'],
  ['ppt', 'unsupported'],
  ['pptx', 'unsupported'],
  ['zip', 'unsupported'],
  ['gz', 'unsupported'],
  ['tar', 'unsupported'],
]);

const LANGUAGE_BY_EXTENSION = new Map([
  ['md', 'markdown'],
  ['markdown', 'markdown'],
  ['js', 'javascript'],
  ['jsx', 'javascript'],
  ['mjs', 'javascript'],
  ['cjs', 'javascript'],
  ['ts', 'typescript'],
  ['tsx', 'typescript'],
  ['py', 'python'],
  ['rb', 'ruby'],
  ['go', 'go'],
  ['rs', 'rust'],
  ['java', 'java'],
  ['kt', 'kotlin'],
  ['kts', 'kotlin'],
  ['c', 'c'],
  ['h', 'c'],
  ['cpp', 'cpp'],
  ['cc', 'cpp'],
  ['cxx', 'cpp'],
  ['hpp', 'cpp'],
  ['cs', 'csharp'],
  ['swift', 'swift'],
  ['dart', 'dart'],
  ['php', 'php'],
  ['lua', 'lua'],
  ['r', 'r'],
  ['scala', 'scala'],
  ['sh', 'bash'],
  ['bash', 'bash'],
  ['zsh', 'bash'],
  ['fish', 'bash'],
  ['ps1', 'powershell'],
  ['sql', 'sql'],
  ['css', 'css'],
  ['scss', 'scss'],
  ['sass', 'sass'],
  ['less', 'less'],
  ['html', 'html'],
  ['htm', 'html'],
  ['xml', 'xml'],
  ['svg', 'xml'],
  ['yaml', 'yaml'],
  ['yml', 'yaml'],
  ['toml', 'ini'],
  ['ini', 'ini'],
  ['conf', 'ini'],
  ['env', 'ini'],
  ['graphql', 'graphql'],
  ['gql', 'graphql'],
  ['vue', 'html'],
  ['svelte', 'html'],
]);

const LANGUAGE_BY_NAME = new Map([
  ['dockerfile', 'dockerfile'],
  ['makefile', 'makefile'],
  ['gemfile', 'ruby'],
  ['rakefile', 'ruby'],
  ['package.json', 'json'],
  ['tsconfig.json', 'json'],
  ['pnpm-workspace.yaml', 'yaml'],
]);

/** Return the lower-case extension without the leading dot. */
export function previewExtension(filePath) {
  const name = String(filePath || '').split(/[\\/]/).pop() || '';
  const index = name.lastIndexOf('.');
  return index > 0 ? name.slice(index + 1).toLocaleLowerCase() : '';
}

/** Return a compact extension badge used by the preview toolbar and tree. */
export function previewTypeLabel(filePath) {
  const extension = previewExtension(filePath);
  if (extension) return extension.toLocaleUpperCase();
  const name = String(filePath || '').split(/[\\/]/).pop() || '';
  return name ? name.slice(0, 6).toLocaleUpperCase() : 'FILE';
}

/** Resolve the visual mode used by the unified preview component. */
export function previewFormatForFile(filePath, mimeType = '', kind = 'text') {
  if (kind === 'binary') return 'unsupported';
  if (kind === 'image' || kind === 'audio' || kind === 'video') return kind;
  const extensionFormat = FORMAT_BY_EXTENSION.get(previewExtension(filePath));
  if (extensionFormat) return extensionFormat;
  if (/markdown/i.test(mimeType)) return 'markdown';
  if (/json/i.test(mimeType)) return 'json';
  if (/csv/i.test(mimeType)) return 'csv';
  if (kind === 'text') {
    const name = String(filePath || '').split(/[\\/]/).pop()?.toLocaleLowerCase();
    return LANGUAGE_BY_NAME.has(name) || LANGUAGE_BY_EXTENSION.has(previewExtension(filePath))
      ? 'code'
      : 'text';
  }
  return 'unsupported';
}

/** Highlight.js language identifier inferred from the path. */
export function previewLanguageForFile(filePath) {
  const name = String(filePath || '').split(/[\\/]/).pop()?.toLocaleLowerCase() || '';
  return LANGUAGE_BY_NAME.get(name)
    || LANGUAGE_BY_EXTENSION.get(previewExtension(filePath))
    || 'text';
}

/** Pretty-print JSON while preserving a clear error for inline feedback. */
export function prettyJson(text) {
  try {
    return { ok: true, text: JSON.stringify(JSON.parse(text), null, 2), error: '' };
  } catch (error) {
    return {
      ok: false,
      text,
      error: error instanceof Error ? error.message : String(error || 'JSON 解析失败'),
    };
  }
}

/** Build a fenced Markdown block without accidentally closing on existing runs. */
export function markdownCodeFence(text, language = 'text') {
  const value = String(text || '').replace(/\r\n?/g, '\n');
  const longestRun = Math.max(0, ...[...value.matchAll(/`+/g)].map((match) => match[0].length));
  const fence = '`'.repeat(Math.max(3, longestRun + 1));
  return `${fence}${language}\n${value}${value.endsWith('\n') ? '' : '\n'}${fence}`;
}

/**
 * Parse RFC 4180-style CSV/TSV without putting an unbounded table in the DOM.
 * Quoted delimiters, escaped quotes and embedded newlines are supported.
 */
export function parseDelimitedPreview(text, delimiter = ',', { maxRows = 300, maxColumns = 24 } = {}) {
  const source = String(text || '').replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  let totalRows = 0;
  let clippedRows = false;
  let clippedColumns = false;

  const pushRow = () => {
    totalRows += 1;
    if (row.length > maxColumns) clippedColumns = true;
    if (totalRows <= maxRows + 1) rows.push(row.slice(0, maxColumns));
    else clippedRows = true;
    row = [];
  };

  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (char === '"') {
      if (inQuotes && source[index + 1] === '"') {
        field += '"';
        index += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }
    if (!inQuotes && char === delimiter) {
      row.push(field);
      field = '';
      continue;
    }
    if (!inQuotes && char === '\n') {
      row.push(field);
      field = '';
      pushRow();
      continue;
    }
    field += char;
  }

  if (field.length > 0 || row.length > 0 || (source.length > 0 && !source.endsWith('\n'))) {
    row.push(field);
    pushRow();
  }

  const [headers = [], ...body] = rows;
  return {
    headers,
    rows: body,
    totalRows: Math.max(0, totalRows - 1),
    clippedRows,
    clippedColumns,
  };
}

/** Split a relative path into a compact title and supporting directory. */
export function splitPreviewPath(filePath) {
  const normalized = String(filePath || '').replace(/\\/g, '/');
  const index = normalized.lastIndexOf('/');
  return index < 0
    ? { name: normalized, directory: '' }
    : { name: normalized.slice(index + 1), directory: normalized.slice(0, index) };
}
