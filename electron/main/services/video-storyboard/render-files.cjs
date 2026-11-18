const fs = require('node:fs/promises');
const { rmSync } = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { randomUUID } = require('node:crypto');
const { mediaResponse } = require('../media-response.cjs');

const jobs = new Map();
const block = 1024 * 1024;

function getJob(id, workId) {
  const job = jobs.get(id);
  if (!job || job.workId !== workId) throw new Error('预览已结束，请重新生成');
  return job;
}

async function begin(store, workId, planId, revision) {
  const work = store.read(workId);
  if (work.revision !== revision) throw new Error('作品已更新，请重新生成预览');
  const shots = work.document.shots.filter(s => s.planId === planId);
  if (!shots.length) throw new Error('请先建立分镜');
  const sources = new Map();
  const sizes = {};
  const clips = work.document.tracks.flatMap(track => track.clips);
  for (const [index, shot] of shots.entries()) {
    const muted = new Set(shot.composition?.mutedAudioIds);
    const used = [...shot.assetIds, ...clips.filter(clip => clip.shotId === shot.id && !muted.has(clip.assetId)).map(clip => clip.assetId)];
    for (const id of new Set(used)) {
      if (sources.has(id)) continue;
      const source = store.source(workId, id);
      if (source.asset.kind === 'document' || (source.asset.kind === 'audio' && (shot.composition?.volume === 0 || muted.has(id)))) continue;
      const stat = await fs.stat(source.filename).catch(() => null);
      if (!stat?.isFile()) throw new Error(`镜头 ${index + 1} 的「${source.asset.name}」找不到原文件，请重新定位`);
      sources.set(id, { filename: source.filename, size: stat.size, mtime: stat.mtimeMs, name: source.asset.name });
      sizes[id] = stat.size;
    }
  }
  if (store.read(workId).revision !== revision) throw new Error('作品已更新，请重新生成预览');
  const id = randomUUID();
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-studio-film-'));
  const filename = path.join(dir, 'preview.mp4');
  try {
    const file = await fs.open(filename, 'wx', 0o600);
    jobs.set(id, { workId, dir, filename, file, sources, size: 0, ready: false,
      title: (work.document.title || '分镜作品').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(0, 100) });
  } catch (error) { await fs.rm(dir, { recursive: true, force: true }); throw error; }
  return { id, sizes };
}

async function read(id, workId, assetId, start, length) {
  const source = getJob(id, workId).sources.get(assetId);
  if (!source || !Number.isSafeInteger(start) || start < 0 || !Number.isSafeInteger(length) || length <= 0 ||
    length > block || start + length > source.size) throw new Error('素材读取范围无效');
  const file = await fs.open(source.filename, 'r').catch(() => { throw new Error(`无法读取「${source.name}」`); });
  try {
    const stat = await file.stat();
    if (stat.size !== source.size || stat.mtimeMs !== source.mtime) throw new Error(`「${source.name}」已变更，请重新生成`);
    const buf = Buffer.allocUnsafe(length);
    let offset = 0;
    while (offset < length) {
      const { bytesRead } = await file.read(buf, offset, length - offset, start + offset);
      if (!bytesRead) throw new Error('素材读取中断');
      offset += bytesRead;
    }
    return buf.toString('base64');
  } finally { await file.close(); }
}

async function write(id, workId, position, encoded) {
  const job = getJob(id, workId);
  if (!job.file || job.ready || typeof encoded !== 'string' || encoded.length > Math.ceil(block / 3) * 4 ||
    !Number.isSafeInteger(position) || position < 0 || position > job.size) throw new Error('无效的编码数据');
  const data = Buffer.from(encoded, 'base64');
  let offset = 0;
  while (offset < data.length) {
    const { bytesWritten } = await job.file.write(data, offset, data.length - offset, position + offset);
    if (!bytesWritten) throw new Error('预览写入中断');
    offset += bytesWritten;
  }
  job.size = Math.max(job.size, position + data.length);
}

async function finish(id, workId) {
  const job = getJob(id, workId);
  if (!job.size || !job.file) throw new Error('没有可播放的编码结果');
  await job.file.close();
  job.file = null;
  job.ready = true;
  return `pi-media://storyboard/render/${id}`;
}

async function stream(request, id) {
  const job = jobs.get(id);
  if (!job?.ready) return new Response(null, { status: 404 });
  return mediaResponse(request, job.filename, 'video/mp4', 'private, no-store');
}

async function save(id, workId, choose) {
  const job = getJob(id, workId);
  if (!job.ready) throw new Error('请先生成预览');
  const result = await choose(job.title + '.mp4');
  if (result.canceled || !result.filePath) return null;
  const destination = result.filePath;
  if (path.extname(destination).toLowerCase() !== '.mp4') throw new Error('请选择 MP4 文件名');
  const existing = await fs.stat(destination).catch(() => null);
  if (existing) {
    for (const source of job.sources.values()) {
      const stat = await fs.stat(source.filename).catch(() => null);
      if (stat && stat.dev === existing.dev && stat.ino === existing.ino) throw new Error('此文件是作品素材，请为成片选择其他文件名');
    }
  }
  const staged = path.join(path.dirname(destination), '.pi-film-' + randomUUID() + '.tmp');
  try {
    await fs.copyFile(job.filename, staged, fs.constants.COPYFILE_EXCL);
    await fs.rename(staged, destination);
  } finally { await fs.rm(staged, { force: true }); }
  return path.basename(destination);
}

async function discard(id, workId) {
  const job = jobs.get(id);
  if (!job || job.workId !== workId) return;
  jobs.delete(id);
  await job.file?.close();
  await fs.rm(job.dir, { recursive: true, force: true, maxRetries: 3 });
}

function discardAll() {
  for (const [id, job] of jobs) void discard(id, job.workId).catch(() => {});
}
process.once('exit', () => {
  for (const job of jobs.values()) { try { rmSync(job.dir, { recursive: true, force: true }); } catch { /* OS temporary directory */ } }
});

module.exports = { begin, read, write, finish, stream, save, discard, discardAll };
