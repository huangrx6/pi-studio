import { constants, watch } from 'node:fs';
import fs from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import appearanceSpec from './appearance.json' with { type: 'json' };

export const SECTIONS = [
  { id: 'inbox', name: '00 Inbox', aliases: ['inbox', '收件箱'] },
  { id: 'projects', name: '01 Projects', aliases: ['projects', 'project', '项目'] },
  { id: 'areas', name: '02 Areas', aliases: ['areas', 'area', '领域'] },
  { id: 'resources', name: '03 Resources', aliases: ['resources', 'resource', '资源', '知识'] },
  { id: 'archive', name: '04 Archive', aliases: ['archive', 'archives', '归档'] },
  { id: 'assets', name: '90 Assets', aliases: ['assets', 'attachments', '附件'] },
  { id: 'system', name: '99 System', aliases: ['system', '系统'] },
];

const IMAGES = {
  '.png': 'image/png', '.gif': 'image/gif', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.avif': 'image/avif', '.svg': 'image/svg+xml',
};
const MAX_NOTE = 2 * 1024 * 1024;
const MAX_IMAGE = 4 * 1024 * 1024;
const MAX_ENTRIES = 8_000;
const MAX_SEARCH_BYTES = 64 * 1024 * 1024;
const hash = value => createHash('sha256').update(value).digest('hex');
const nameSort = (a, b) => a.localeCompare(b, 'zh-CN', { numeric: true, sensitivity: 'base' });
const lockName = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;

export class NotesError extends Error {}

export function noteError(error) {
  if (error instanceof NotesError) return error;
  if (error?.code === 'ENOENT') return new NotesError('文件或目录已移走，或笔记目录不可用。');
  if (error?.code === 'EEXIST') return new NotesError('目标位置已有同名文件或文件夹。');
  if (error?.code === 'EACCES' || error?.code === 'EPERM') return new NotesError('当前没有访问或修改这个文件的权限。');
  return new NotesError('笔记操作未完成。请检查文件是否正在使用，然后重试。');
}

function classify(name) {
  const extension = path.extname(name).toLowerCase();
  if (extension === '.md' || extension === '.markdown') return 'markdown';
  if (extension === '.html' || extension === '.htm') return 'html';
  if (Object.hasOwn(IMAGES, extension)) return 'image';
  if (extension === '.pdf') return 'pdf';
  return null;
}

function sectionFor(name) {
  const key = name.normalize('NFC').trim().toLowerCase().replace(/^\d+[\s._-]+/, '');
  return SECTIONS.find(section => section.aliases.includes(key));
}

function relativeParts(relative, allowRoot = false) {
  if (allowRoot && relative === '') return [];
  if (typeof relative !== 'string' || !relative || relative.length > 1200 || /[\\:\x00-\x1f]/.test(relative)) {
    throw new NotesError('请选择知识库内的相对路径。');
  }
  const parts = relative.split('/');
  if (parts.length > 30 || parts.some(part => !part || part.startsWith('.') || part === 'node_modules')) {
    throw new NotesError('路径包含隐藏或无效的目录。');
  }
  return parts;
}

function newName(name) {
  if (typeof name !== 'string' || name !== name.trim() || !name || name.length > 160
    || /[<>:"/\\|?*\x00-\x1f]|\.$/.test(name) || name.startsWith('.') || lockName.test(name) || name === 'node_modules') {
    throw new NotesError('请输入有效的文件名或文件夹名。');
  }
  return name;
}

function permittedRoot(candidate) {
  if (typeof candidate !== 'string' || !path.isAbsolute(candidate)) throw new NotesError('请选择一个本地目录。');
  const directory = path.resolve(candidate);
  const home = path.resolve(os.homedir());
  const blocked = ['.pi', '.pi-studio', '.ssh', '.gnupg', '.aws', '.config'].map(name => path.join(home, name));
  const compare = process.platform === 'win32' || process.platform === 'darwin'
    ? value => value.toLowerCase()
    : value => value;
  if (directory === path.parse(directory).root || compare(directory) === compare(home)
    || blocked.some(root => compare(directory) === compare(root) || compare(directory).startsWith(compare(root) + path.sep))) {
    throw new NotesError('请选择一个专用于笔记的文件夹。');
  }
  return directory;
}

async function secureRoot(candidate) {
  const real = permittedRoot(await fs.realpath(permittedRoot(candidate)));
  if (!(await fs.stat(real)).isDirectory()) throw new NotesError('请选择文件夹。');
  return real;
}

async function resolveEntry(root, relative, { missing = false, allowRoot = false } = {}) {
  const parts = relativeParts(relative, allowRoot);
  let absolute = root;
  if (await secureRoot(root) !== root) throw new NotesError('笔记目录位置已改变，请重新选择。');
  let stat;
  for (const [index, part] of parts.entries()) {
    absolute = path.join(absolute, part);
    stat = await fs.lstat(absolute).catch(error => {
      if (missing && index === parts.length - 1 && error.code === 'ENOENT') return null;
      throw error;
    });
    if (!stat) break;
    if (stat.isSymbolicLink() || (!stat.isDirectory() && (index !== parts.length - 1 || !stat.isFile()))) {
      throw new NotesError('知识库不读取链接或非普通文件。');
    }
  }
  return { absolute, stat };
}

async function readBytes(file, limit) {
  const handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > limit) throw new NotesError('文件过大，无法在知识库内打开。');
    const buffer = Buffer.alloc(stat.size + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    if (offset !== stat.size) throw new NotesError('文件正在写入，请稍后重试。');
    return { bytes: buffer.subarray(0, offset), stat };
  } finally {
    await handle.close();
  }
}

async function readText(file, limit = MAX_NOTE) {
  const { bytes, stat } = await readBytes(file, limit);
  try {
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    return { text, revision: hash(bytes), modifiedAt: stat.mtime.toISOString(), size: bytes.length };
  } catch {
    throw new NotesError('此笔记需要使用 UTF-8 编码。');
  }
}

function textBytes(content) {
  if (typeof content !== 'string' || Buffer.byteLength(content, 'utf8') > MAX_NOTE) {
    throw new NotesError('笔记需为 UTF-8 文本，大小上限为 2 MB。');
  }
  return content;
}

async function createFile(file, content, mode) {
  const handle = await fs.open(file, 'wx', mode);
  try {
    await handle.writeFile(content, 'utf8');
    await handle.close();
  } catch (error) {
    await handle.close().catch(() => {});
    await fs.unlink(file).catch(() => {});
    throw error;
  }
}

async function replaceFile(file, content, mode, check = async () => true) {
  const temp = path.join(path.dirname(file), '.notes-' + randomUUID() + '.tmp');
  await createFile(temp, content, mode);
  try {
    if (!await check()) return false;
    await fs.rename(temp, file);
    return true;
  } finally {
    await fs.unlink(temp).catch(() => {});
  }
}

function localDay(now = new Date()) {
  return [now.getFullYear(), now.getMonth() + 1, now.getDate()]
    .map((part, index) => String(part).padStart(index === 0 ? 4 : 2, '0')).join('-');
}

function noteTemplate(name, format, parent) {
  const title = path.basename(name, path.extname(name));
  if (format === 'html') {
    const escaped = title.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
    return '<!doctype html>\n<html lang="zh-CN">\n<head>\n  <meta charset="utf-8">\n  <title>' + escaped
      + '</title>\n</head>\n<body>\n  <h1>' + escaped + '</h1>\n</body>\n</html>\n';
  }
  const day = localDay();
  const status = sectionFor(parent.split('/')[0])?.id === 'projects' ? 'status: active\n' : '';
  return '---\ntitle: ' + JSON.stringify(title) + '\ncreated: ' + day + '\nupdated: ' + day + '\ntags: []\n' + status + '---\n\n# ' + title + '\n';
}

function documentFormat(relative) {
  const format = classify(relative);
  if (format !== 'markdown' && format !== 'html') throw new NotesError('请选择 Markdown 或 HTML 笔记。');
  return format;
}

function entryPath(from, href) {
  if (typeof href !== 'string' || href.length > 1200 || href.startsWith('/') || href.startsWith('\\')) {
    throw new NotesError('只支持库内相对资源。');
  }
  let leaf;
  try { leaf = decodeURIComponent(href.split(/[?#]/, 1)[0]); }
  catch { throw new NotesError('资源链接无效。'); }
  if (!leaf || leaf.startsWith('/') || /[\\:\x00-\x1f]/.test(leaf)) throw new NotesError('资源链接无效。');
  const relative = path.posix.normalize(path.posix.join(path.posix.dirname(from), leaf));
  relativeParts(relative);
  return relative;
}

export async function openNotesStore(dataDirectory) {
  const config = path.join(dataDirectory, 'library.json');
  const saved = await readText(config, 8_192).then(file => JSON.parse(file.text)).catch(() => null);
  let root = '';
  if (saved?.version === 1) {
    try { root = permittedRoot(saved.root); } catch { /* Rebind in the UI when the saved location is invalid. */ }
  }
  const themeIds = new Set(appearanceSpec.themes.map(theme => theme.id));
  const savedTheme = saved?.appearance?.theme;
  const theme = typeof savedTheme === 'string' && Object.hasOwn(appearanceSpec.legacyThemes, savedTheme)
    ? appearanceSpec.legacyThemes[savedTheme] : savedTheme;
  const { minimum, maximum, initial } = appearanceSpec.outline;
  const clampWidth = value => Math.round(Math.min(maximum, Math.max(minimum, value)));
  let appearance = {
    theme: themeIds.has(theme) ? theme : appearanceSpec.defaultTheme,
    outlineWidth: Number.isFinite(saved?.appearance?.outlineWidth) ? clampWidth(saved.appearance.outlineWidth) : initial,
  };
  let cache;
  let mutations = Promise.resolve();

  function change(run) {
    const next = mutations.then(run);
    mutations = next.catch(() => {});
    return next;
  }
  function state() {
    return { library: root ? { id: hash(root), name: path.basename(root) } : null };
  }
  function viewAppearance() { return { ...appearance }; }
  function persistConfig(directory, nextAppearance) {
    return replaceFile(config, JSON.stringify({ version: 1, root: directory || null, appearance: nextAppearance }) + '\n', 0o600);
  }
  function setAppearance(patch) {
    return change(async () => {
      const { theme, outlineWidth } = patch;
      if (theme !== undefined && !themeIds.has(theme)) throw new NotesError('知识库主题无效。');
      if (outlineWidth !== undefined && !Number.isFinite(outlineWidth)) throw new NotesError('大纲宽度无效。');
      const next = { theme: theme ?? appearance.theme, outlineWidth: outlineWidth === undefined
        ? appearance.outlineWidth : clampWidth(outlineWidth) };
      if (next.theme !== appearance.theme || next.outlineWidth !== appearance.outlineWidth) {
        await persistConfig(root, next);
        appearance = next;
      }
      return viewAppearance();
    });
  }
  function selected(library) {
    if (!root) throw new NotesError('请先在知识库面板选择本地目录。');
    if (library && library !== hash(root)) throw new NotesError('笔记目录已切换，请刷新后再试。');
    return root;
  }
  function invalidate() { cache = undefined; }
  function watchLibrary(onChange) {
    if (!root) return undefined;
    const watcher = watch(root, { recursive: true, persistent: false }, (_event, filename) => {
      if (filename && String(filename).split(/[\\/]/).some(part => part.startsWith('.'))) return;
      onChange();
    });
    return watcher;
  }
  async function bind(directory) {
    return change(async () => {
      const next = await secureRoot(directory);
      await persistConfig(next, appearance);
      root = next;
      invalidate();
      return state();
    });
  }

  async function scan(directory) {
    await resolveEntry(directory, '', { allowRoot: true });
    const entries = [];
    const sections = {};
    let partial = false;
    async function visit(folder, parent = '', depth = 0) {
      if (depth >= 24) { partial = true; return; }
      const rows = (await fs.readdir(folder, { withFileTypes: true })).sort((a, b) => nameSort(a.name, b.name));
      for (const row of rows) {
        if (entries.length >= MAX_ENTRIES) { partial = true; return; }
        const relative = parent ? parent + '/' + row.name : row.name;
        try { relativeParts(relative); } catch { continue; }
        if (row.isDirectory()) {
          const section = !parent && sectionFor(row.name);
          if (section && !sections[section.id]) sections[section.id] = relative;
          entries.push({ path: relative, parent, name: row.name, kind: 'folder', ...(section && { section: section.id }) });
          try { await visit(path.join(folder, row.name), relative, depth + 1); }
          catch (error) {
            if (!['ENOENT', 'EACCES', 'EPERM', 'ENOTDIR'].includes(error.code)) throw error;
            partial = true;
          }
        } else if (row.isFile()) {
          const format = classify(row.name);
          if (format) entries.push({ path: relative, parent, name: row.name, kind: format });
        }
      }
    }
    await visit(directory);
    return { entries, sections, partial };
  }
  function tree(library) {
    const directory = selected(library);
    if (cache?.root === directory && Date.now() - cache.at < 2_000) return cache.value;
    const value = scan(directory);
    cache = { root: directory, value, at: Date.now() };
    value.catch(() => { if (cache?.value === value) invalidate(); });
    return value;
  }
  async function read(relative, library) {
    const directory = selected(library);
    const format = documentFormat(relative);
    const { absolute, stat } = await resolveEntry(directory, relative);
    if (!stat?.isFile()) throw new NotesError('请选择普通文件。');
    return { path: relative, format, ...await readText(absolute) };
  }
  async function search(query, { library, section, signal } = {}) {
    if (typeof query !== 'string' || !query.trim() || query.length > 160) throw new NotesError('请输入 1 到 160 字的搜索词。');
    const directory = selected(library);
    const listing = await tree(library);
    const needle = query.trim().toLocaleLowerCase();
    const parent = section ? listing.sections[section] : '';
    if (section && !parent) return { matches: [], partial: false };
    const candidates = listing.entries.filter(entry => entry.kind !== 'folder' && (!parent || entry.path.startsWith(parent + '/')));
    const winners = [];
    let budget = MAX_SEARCH_BYTES;
    let partial = listing.partial;
    const files = [
      ...candidates.filter(entry => entry.path.toLocaleLowerCase().includes(needle)),
      ...candidates.filter(entry => !entry.path.toLocaleLowerCase().includes(needle)),
    ];
    for (const entry of files) {
      signal?.throwIfAborted();
      if (winners.length >= 80) { partial = true; break; }
      const filenameHit = entry.path.toLocaleLowerCase().includes(needle);
      let excerpt = '';
      if (budget > 0 && (entry.kind === 'markdown' || entry.kind === 'html')) {
        try {
          const file = await resolveEntry(directory, entry.path);
          if (file.stat.size > budget || file.stat.size > MAX_NOTE) partial = true;
          else {
            const { text, size } = await readText(file.absolute);
            budget -= size;
            const index = text.toLocaleLowerCase().indexOf(needle);
            if (index >= 0) excerpt = text.slice(Math.max(0, index - 34), index + 114).replace(/\s+/g, ' ').trim();
          }
        } catch { partial = true; }
      } else if (budget <= 0) partial = true;
      if (filenameHit || excerpt) winners.push({ ...entry, excerpt });
    }
    return { matches: winners, partial };
  }
  async function backlinks(relative, { library, signal } = {}) {
    relativeParts(relative);
    const directory = selected(library);
    const { entries } = await tree(library);
    const documents = entries.filter(entry => entry.kind === 'markdown' || entry.kind === 'html');
    const stem = name => name.replace(/\.(?:md|markdown|html?)$/i, '');
    const byPath = new Map(documents.flatMap(entry => [[entry.path, entry.path], [stem(entry.path), entry.path]]));
    const siblings = documents.filter(entry => stem(entry.name) === stem(path.posix.basename(relative)));
    const links = [];
    let budget = MAX_SEARCH_BYTES;
    for (const entry of documents) {
      signal?.throwIfAborted();
      if (links.length >= 80 || budget <= 0) break;
      if (entry.path === relative) continue;
      try {
        const file = await resolveEntry(directory, entry.path);
        if (file.stat.size > budget || file.stat.size > MAX_NOTE) continue;
        const { text, size } = await readText(file.absolute);
        budget -= size;
        const references = text.matchAll(/\[\[([^|\]#\r\n]+)[^\]\r\n]*\]\]|\]\(\s*(?:<([^>\r\n]+)>|([^\s)\r\n]+))/g);
        for (const ref of references) {
          const link = (ref[1] ?? ref[2] ?? ref[3]).trim();
          let linked;
          try { linked = byPath.get(entryPath(entry.path, link)); } catch { continue; }
          if (!linked && ref[1]) linked = byPath.get(link) ?? (siblings.length === 1 && stem(siblings[0].name) === link ? siblings[0].path : '');
          if (linked === relative) { links.push(entry); break; }
        }
      } catch { /* Files can disappear or be replaced while scanning. */ }
    }
    return links;
  }
  async function save({ path: relative, text, revision, library }) {
    return change(async () => {
      const directory = selected(library);
      documentFormat(relative);
      const bytes = textBytes(text);
      const { absolute, stat } = await resolveEntry(directory, relative, { missing: true });
      if (revision === null) {
        if (stat) return { status: 'conflict', current: await read(relative, library) };
        await createFile(absolute, bytes, 0o644);
      } else {
        if (typeof revision !== 'string' || !/^[a-f0-9]{64}$/.test(revision)) throw new NotesError('请先读取当前笔记版本。');
        if (!stat) return { status: 'conflict', current: null };
        const current = await read(relative, library);
        if (current.revision !== revision) return { status: 'conflict', current };
        if (!await replaceFile(absolute, bytes, stat.mode & 0o777, async () => {
          try { return (await read(relative, library)).revision === revision; }
          catch (error) { if (error.code === 'ENOENT') return false; throw error; }
        })) {
          const latest = await read(relative, library).catch(error => {
            if (error.code === 'ENOENT') return null;
            throw error;
          });
          return { status: 'conflict', current: latest };
        }
      }
      invalidate();
      return { status: 'saved', note: await read(relative, library) };
    });
  }
  function create({ parent = '', name, kind, library }) {
    const filename = newName(name);
    const relative = parent ? parent + '/' + filename : filename;
    if (kind === 'folder') return change(async () => {
      const { absolute, stat } = await resolveEntry(selected(library), relative, { missing: true });
      if (stat) throw new NotesError('目标位置已有同名文件或文件夹。');
      await fs.mkdir(absolute);
      invalidate();
      return { path: relative };
    });
    if (kind !== documentFormat(relative)) throw new NotesError('文件名扩展与笔记类型不一致。');
    return save({ path: relative, text: noteTemplate(filename, kind, parent), revision: null, library });
  }
  function draftFile(relative, library) {
    relativeParts(relative);
    documentFormat(relative);
    const directory = path.join(dataDirectory, 'drafts');
    return { directory, file: path.join(directory, hash(selected(library) + '\n' + relative) + '.json') };
  }
  async function readDraft({ path: relative, library }) {
    const { file } = draftFile(relative, library);
    return readText(file, MAX_NOTE * 6 + 512).then(({ text }) => JSON.parse(text)).catch(() => null);
  }
  function writeDraft({ path: relative, library, text, revision }) {
    return change(async () => {
      const { directory, file } = draftFile(relative, library);
      if (text === null) {
        await fs.rm(file, { force: true });
      } else {
        if (typeof revision !== 'string' || !/^[a-f0-9]{64}$/.test(revision)) throw new NotesError('草稿版本无效。');
        await fs.mkdir(directory, { recursive: true, mode: 0o700 });
        await replaceFile(file, JSON.stringify({ text: textBytes(text), revision }), 0o600);
      }
      return true;
    });
  }
  function movable(relative) {
    const [first, second] = relativeParts(relative);
    if (!second && sectionFor(first)) throw new NotesError('PARA 顶层目录作为分类入口保留。');
  }
  function move({ path: source, parent = '', name, library }) {
    return change(async () => {
      const directory = selected(library);
      movable(source);
      const destination = parent ? parent + '/' + newName(name) : newName(name);
      if (destination === source) return { path: source };
      if (destination.startsWith(source + '/')) throw new NotesError('不能移入自己的子目录。');
      const from = await resolveEntry(directory, source);
      if (from.stat.isFile() && classify(source) !== classify(destination)) {
        throw new NotesError('请保留文件原来的格式扩展名。');
      }
      const to = await resolveEntry(directory, destination, { missing: true });
      const caseOnly = to.stat && from.stat.dev === to.stat.dev && from.stat.ino === to.stat.ino
        && source.toLowerCase() === destination.toLowerCase();
      if (to.stat && !caseOnly) throw new NotesError('目标位置已有同名文件或文件夹。');
      await fs.rename(from.absolute, to.absolute);
      invalidate();
      return { path: destination };
    });
  }
  function trash({ path: relative, library }, trashItem) {
    return change(async () => {
      movable(relative);
      const { absolute, stat } = await resolveEntry(selected(library), relative);
      if (!stat.isDirectory() && !classify(relative)) throw new NotesError('请选择库内的笔记、文件夹或可见附件。');
      await trashItem(absolute);
      invalidate();
      return { path: relative };
    });
  }
  function initialize({ library }, spec) {
    return change(async () => {
      const directory = selected(library);
      const listing = await scan(directory);
      let system = listing.sections.system;
      let added = 0;
      for (const section of SECTIONS) {
        if (listing.sections[section.id]) continue;
        const { absolute, stat } = await resolveEntry(directory, section.name, { missing: true });
        if (!stat) { await fs.mkdir(absolute); added++; }
        if (section.id === 'system') system = section.name;
      }
      const relative = system + '/notes-spec.md';
      const file = await resolveEntry(directory, relative, { missing: true });
      if (!file.stat) await createFile(file.absolute, spec, 0o644);
      invalidate();
      return { added, path: relative };
    });
  }
  async function asset({ from, href, library }) {
    const root = selected(library);
    relativeParts(from);
    const relative = entryPath(from, href);
    const extension = path.extname(relative).toLowerCase();
    const imageType = Object.hasOwn(IMAGES, extension) ? IMAGES[extension] : '';
    if (!imageType && extension !== '.css') throw new NotesError('此资源格式无法预览。');
    const { absolute } = await resolveEntry(root, relative);
    if (!imageType) return { path: relative, css: (await readText(absolute, 196_608)).text };
    const { bytes } = await readBytes(absolute, MAX_IMAGE);
    return { path: relative, dataUrl: 'data:' + imageType + ';base64,' + bytes.toString('base64') };
  }
  async function openFile({ path: relative, library }, openPath) {
    if (!classify(relative)) throw new NotesError('请选择笔记或附件。');
    const { absolute, stat } = await resolveEntry(selected(library), relative);
    if (!stat.isFile()) throw new NotesError('请选择普通文件。');
    if (await openPath(absolute)) throw new NotesError('系统无法打开这个文件。');
    return true;
  }
  return { state, viewAppearance, setAppearance, invalidate, watchLibrary, bind, tree, read, search, backlinks, save, create, move, trash, initialize,
    asset, openFile, readDraft, writeDraft };
}
