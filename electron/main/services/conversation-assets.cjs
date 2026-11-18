// Materialize files from the Durable conversation journal without writing a second transcript.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createHash, randomUUID } = require('node:crypto');
const { chatAttachments } = require('../core/attachment-markers.cjs');
const { studioDataDirectory } = require('../core/studio-paths.cjs');
const { assertNotProtected, expandUserPath } = require('./file-target.cjs');

const MAX_FILE_BYTES = 20_000_000;
const IMAGE_EXTENSIONS = {
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif',
  'image/avif': 'avif', 'image/svg+xml': 'svg', 'image/bmp': 'bmp', 'image/tiff': 'tiff',
};
const hash = value => createHash('sha256').update(value).digest('hex');
const ownedId = value => /^[a-zA-Z0-9-]{1,80}$/.test(String(value || ''));

function filename(value) {
  const name = path.basename(String(value || '').replaceAll('\\', '/')).normalize('NFC')
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/^[. ]+|[. ]+$/g, '');
  // Bound bytes as well as characters for filesystems with a 255-byte component limit.
  return [...(name || 'file')].reduce((tail, ch) => Buffer.byteLength(tail + ch) <= 180 ? tail + ch : tail, '');
}

function archiveFolder(root, parts, create = true) {
  if (create) fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  let current = root;
  for (const part of parts) {
    if (part === '.' || part === '..' || !part || /[/\\]/.test(part)) throw new Error('无效的附件目录');
    current = path.join(current, part);
    if (create) {
      try { fs.mkdirSync(current, { mode: 0o700 }); }
      catch (error) { if (error.code !== 'EEXIST') throw error; }
    }
    if (!fs.lstatSync(current, { throwIfNoEntry: false })?.isDirectory()) {
      if (!create) return undefined;
      throw new Error('附件位置不是受管理的普通目录');
    }
  }
  return current;
}

function sessionParts({ workspace, publicId, childId }) {
  if (!ownedId(publicId) || (childId && !ownedId(childId))) throw new Error('附件会话标识无效');
  const project = workspace ? filename(path.basename(workspace)) + '-' + hash(workspace).slice(0, 12) : 'no-workspace';
  return ['attachments', 'projects', project, 'sessions', String(publicId),
    ...(childId ? ['agents', String(childId)] : [])];
}

function inside(directory, target) {
  const relative = path.relative(directory, target);
  return relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
}

function uploadDirectory(owner, root = studioDataDirectory()) {
  return fs.realpathSync(archiveFolder(root, [...sessionParts(owner), 'inputs', 'uploads']));
}

function archiveUpload(root, owner, attachment) {
  const managed = archiveFolder(root, ['attachments'], false);
  const unavailable = () => Object.assign(new Error('上传文件已不可用'), { code: 'ATTACHMENT_UNAVAILABLE' });
  if (!managed || !path.isAbsolute(attachment.path)) throw unavailable();
  const canonicalRoot = fs.realpathSync(managed);
  if (!inside(managed, attachment.path) && !inside(canonicalRoot, attachment.path)) throw unavailable();
  const source = fs.realpathSync(attachment.path);
  if (!inside(canonicalRoot, source) || !fs.lstatSync(source).isFile()) throw unavailable();
  const destination = uploadDirectory(owner, root);
  const name = path.basename(source);
  // Old uploads already have a UUID. Keep the same user-visible name for older unprefixed files too.
  const uuid = hash(source).slice(0, 32).replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, '$1-$2-$3-$4-$5');
  const storedName = /^[0-9a-f-]{36}-/i.test(name) ? name : uuid + '-' + filename(attachment.name);
  const target = path.join(destination, storedName);
  if (source !== target) {
    try { fs.linkSync(source, target); }
    catch (error) {
      if (['EXDEV', 'EPERM', 'ENOTSUP', 'EOPNOTSUPP'].includes(error.code)) {
        try { fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL); }
        catch (copyError) { if (copyError.code !== 'EEXIST') throw copyError; }
      } else if (error.code !== 'EEXIST') throw error;
    }
  }
  if (!fs.lstatSync(target).isFile()) throw new Error('无效的附件副本');
  return fs.realpathSync(target);
}

function bindConversationUploads(row, paths, root = studioDataDirectory()) {
  return chatAttachments(paths).map(attachment => archiveUpload(root, row, attachment));
}

function removeConversationAssets(owner, root = studioDataDirectory()) {
  const target = archiveFolder(root, sessionParts(owner), false);
  if (!target) return false;
  fs.rmSync(target, { recursive: true });
  // Remove only empty Studio-created grouping directories.
  const projects = path.join(root, 'attachments', 'projects');
  for (let parent = path.dirname(target); inside(projects, parent); parent = path.dirname(parent)) {
    try { fs.rmdirSync(parent); } catch { break; }
  }
  return true;
}

function assetOwner(db, conversationId) {
  const lineage = `WITH RECURSIVE owners(id, depth) AS (
    SELECT CAST(? AS INTEGER), 0
    UNION ALL SELECT c.owner_conversation_id, owners.depth + 1 FROM durable_conversations c JOIN owners ON c.id = owners.id
          WHERE c.owner_conversation_id IS NOT NULL
  )`;
  const row = db.prepare(lineage + `
    SELECT c.id, c.workspace, c.title, c.public_id AS publicId FROM owners JOIN conversations c ON c.id = CAST(owners.id AS TEXT)
    ORDER BY owners.depth LIMIT 1
  `).get(conversationId);
  if (!row) return undefined;
  const childId = String(conversationId) === String(row.id) ? '' : String(conversationId);
  const tree = db.prepare(lineage + `
    SELECT w.path, w.name FROM owners
    LEFT JOIN conversations c ON c.id = CAST(owners.id AS TEXT)
    JOIN managed_worktrees w ON w.child_conversation_id IN (CAST(owners.id AS TEXT), c.public_id)
    ORDER BY owners.depth, w.created_at DESC LIMIT 1
  `).get(conversationId);
  return { ...row, childId, agentName: tree?.name, cwd: tree?.path || row.workspace };
}

function outputPath(value, cwd) {
  if (typeof value !== 'string' || !value.trim() || /^(?!file:)[a-z][a-z0-9+.-]*:\/\//i.test(value)) return undefined;
  let target;
  try {
    const expanded = expandUserPath(value);
    if (!path.isAbsolute(expanded) && (!cwd || !path.isAbsolute(cwd))) return undefined;
    target = path.resolve(cwd || '', expanded);
    if (inside(path.join(os.homedir(), '.pi'), target)) return undefined;
    // A managed Git checkout often lives below ~/.pi-studio/worktrees, itself a hidden ancestor.
    const parts = cwd && inside(cwd, target) ? path.relative(cwd, target).split(path.sep) : target.split(path.sep);
    if (parts.some(part => part.startsWith('.') || /^(?:node_modules|settings\.json|.*\.(?:pem|key|p12|pfx))$/i.test(part))) return undefined;
    assertNotProtected(target);
  } catch { return undefined; }
  return target;
}

async function readLinkedFile(target, cwd) {
  let handle;
  try {
    const real = await fs.promises.realpath(target);
    if (!inside(await fs.promises.realpath(cwd), real) || !outputPath(real, cwd)) return { availability: 'outside-workspace' };
    handle = await fs.promises.open(real, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0));
    const stat = await handle.stat();
    if (!stat.isFile()) return { availability: 'unavailable' };
    if (stat.size > MAX_FILE_BYTES) return { availability: 'size-limit', bytes: stat.size };
    const buffer = Buffer.alloc(stat.size);
    let read = 0;
    while (read < buffer.length) {
      const part = await handle.read(buffer, read, buffer.length - read, read);
      if (!part.bytesRead) break;
      read += part.bytesRead;
    }
    return { buffer: buffer.subarray(0, read) };
  } catch (error) {
    if (!['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM', 'ELOOP'].includes(error.code)) throw error;
    return { availability: 'unavailable' };
  } finally { await handle?.close(); }
}

function linkedFiles(text) {
  const targets = new Set();
  const prose = text.replace(/\x60\x60\x60[\s\S]*?\x60\x60\x60/g, '');
  for (const match of prose.matchAll(/\]\(\s*(?:<([^>\n]+)>|((?:[^()\n]|\([^()\n]*\))+?))\s*\)/g)) {
    let name = (match[1] || match[2]).trim();
    try { name = decodeURIComponent(name); } catch { /* retain the literal filename */ }
    if (name) targets.add(name);
  }
  for (const match of prose.matchAll(/\x60([^\x60\n]+\.[\w]{1,12})\x60/g)) targets.add(match[1]);
  return [...targets];
}

function writtenFile(db, row, callId) {
  if (!callId) return undefined;
  // Match the successful result to its exact call, including concurrent tool calls.
  const found = db.prepare(`
    SELECT json_extract(block.value, '$.arguments.path') AS path, json_extract(block.value, '$.arguments.content') AS content
    FROM durable_entries e, json_each(e.record, '$.model') AS m, json_each(m.value, '$.content') AS block
    WHERE e.conversation_id = ? AND e.id < ? AND json_extract(m.value, '$.role') = 'assistant'
      AND block.type = 'object' AND json_extract(block.value, '$.type') = 'toolCall'
      AND json_extract(block.value, '$.name') = 'write' AND json_extract(block.value, '$.id') = ?
    ORDER BY e.id DESC LIMIT 1
  `).get(row.conversation_id, row.id, callId);
  return typeof found?.content === 'string' ? found : undefined;
}

// A delegated task can reference an upload from its parent in text, instead of a second upload DTO.
function entryUploads(root, owner, entry) {
  const attachments = new Map(chatAttachments(entry.data?.attachments).map(item => [item.path, item]));
  if (!owner.childId) return [...attachments.values()];
  const parent = archiveFolder(root, sessionParts({ ...owner, childId: '' }), false);
  const roots = [parent, ...[owner.id, owner.publicId].filter(ownedId)
    .map(id => archiveFolder(root, ['attachments', String(id)], false))]
    .filter(Boolean).flatMap(dir => [dir, fs.realpathSync(dir)]);
  if (!roots.length) return [...attachments.values()];
  for (const message of entry.model) {
    if (message.role !== 'user') continue;
    const blocks = Array.isArray(message.content) ? message.content : [{ type: 'text', text: message.content }];
    for (const block of blocks) {
      if (block.type !== 'text' || typeof block.text !== 'string') continue;
      const paths = linkedFiles(block.text);
      for (const match of block.text.matchAll(/<attachment path="([^"]+)">/g)) paths.push(match[1]);
      for (const target of paths) {
        if (path.isAbsolute(target) && roots.some(dir => inside(dir, target))) {
          const [item] = chatAttachments([target]);
          attachments.set(item.path, item);
        }
      }
    }
  }
  return [...attachments.values()];
}

async function materializeEntry(db, row, owner, root) {
  const entry = JSON.parse(row.record);
  if (!Array.isArray(entry.model) || !entry.model.length) return;
  const parts = sessionParts(owner);
  const session = path.join(root, ...parts);
  const files = { inputs: [], outputs: [] };
  const sideComplete = side => {
    const dir = archiveFolder(root, [...parts, side, String(row.id)], false);
    return dir && fs.lstatSync(path.join(dir, 'manifest.json'), { throwIfNoEntry: false })?.isFile();
  };
  const imageNames = Array.isArray(entry.data?.imageNames) ? entry.data.imageNames : [];
  const folder = side => archiveFolder(root, [...parts, side, String(row.id)]);
  async function save(side, name, bytes, info) {
    const list = files[side];
    const normalized = filename(name);
    const item = { name: normalized, ...info, bytes: bytes.length };
    if (bytes.length > MAX_FILE_BYTES) { list.push({ ...item, availability: 'size-limit' }); return; }
    const target = path.join(folder(side), String(list.length + 1).padStart(2, '0') + '-' + normalized);
    await publishFile(target, bytes);
    list.push({ ...item, file: path.relative(session, target), availability: 'saved' });
  }
  const uploads = entry.data?.attachments?.length || (owner.childId && entry.model.some(message => message.role === 'user'))
    ? entryUploads(root, owner, entry)
    : [];
  for (const attachment of uploads.length && !sideComplete('inputs') ? uploads : []) {
    try {
      const target = archiveUpload(root, owner, attachment);
      files.inputs.push({ name: attachment.name, bytes: fs.statSync(target).size, file: path.relative(fs.realpathSync(session), target), availability: 'saved' });
    } catch (error) {
      if (!['ENOENT', 'ENOTDIR', 'ATTACHMENT_UNAVAILABLE'].includes(error.code)) throw error;
      files.inputs.push({ name: attachment.name, availability: 'missing' });
    }
  }
  for (const message of entry.model) {
    if (!['user', 'assistant', 'toolResult'].includes(message?.role)) continue;
    const side = message.role === 'user' ? 'inputs' : 'outputs';
    const content = Array.isArray(message.content) ? message.content : [{ type: 'text', text: message.content }];
    const images = content.filter(block => block?.type === 'image' && typeof block.data === 'string');
    for (const [index, image] of images.entries()) {
      const nameIndex = index - (images.length - imageNames.length);
      const name = (side === 'inputs' && imageNames[nameIndex]) || 'image-' + (index + 1) + '.' + (IMAGE_EXTENSIONS[image.mimeType] || 'bin');
      if (sideComplete(side)) continue;
      await save(side, name, Buffer.from(image.data, 'base64'), { mime: image.mimeType, source: message.toolName || message.role });
    }
    if (message.role === 'toolResult' && !message.isError && message.toolName === 'write' && !sideComplete('outputs')) {
      const write = writtenFile(db, row, message.toolCallId);
      if (write && outputPath(write.path, owner.cwd)) {
        await save('outputs', path.basename(write.path), Buffer.from(write.content), { source: 'write', sourcePath: write.path });
      }
    }
    const links = new Set();
    if (message.role === 'assistant') {
      const text = content.filter(block => block?.type === 'text').map(block => block.text || '').join('\n');
      for (const link of linkedFiles(text)) links.add(link);
    } else if (message.role === 'toolResult' && !message.isError) {
      // Declarative artifacts from tools may be returned before the assistant writes a final answer.
      for (const key of ['artifacts', 'outputFiles']) {
        const artifacts = message.details?.[key];
        if (Array.isArray(artifacts)) for (const artifact of artifacts) {
          const file = typeof artifact === 'string' ? artifact : artifact?.path;
          if (typeof file === 'string') links.add(file);
        }
      }
    }
    if (!links.size || sideComplete('outputs')) continue;
    for (const link of links) {
      const target = outputPath(link, owner.cwd);
      if (!target) continue;
      const name = path.basename(target);
      const info = { source: message.toolName || 'link', sourcePath: link };
      if (!owner.cwd || !inside(owner.cwd, target)) {
        files.outputs.push({ name, ...info, availability: 'outside-workspace' });
        continue;
      }
      if (row.historical) { files.outputs.push({ name, ...info, availability: 'historical-reference' }); continue; }
      const { buffer, ...metadata } = await readLinkedFile(target, owner.cwd);
      if (buffer) await save('outputs', name, buffer, { ...info, capturedAt: Date.now() });
      else files.outputs.push({ name, ...info, ...metadata });
    }
  }
  for (const [side, list] of Object.entries(files)) {
    if (!list.length) continue;
    const manifest = { version: 1, workspace: owner.workspace, session: owner.publicId, title: owner.title, agent: owner.childId || undefined, agentName: owner.agentName,
      entry: row.id, direction: side, files: list };
    await publishFile(path.join(folder(side), 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  }
}

async function publishFile(target, bytes) {
  const temporary = path.join(path.dirname(target), '.' + randomUUID() + '.tmp');
  try {
    await fs.promises.writeFile(temporary, bytes, { flag: 'wx', mode: 0o600 });
    await fs.promises.rename(temporary, target);
  } finally { await fs.promises.rm(temporary, { force: true }); }
}

module.exports = { assetOwner, bindConversationUploads, materializeEntry, removeConversationAssets, uploadDirectory };
