const { randomUUID } = require('node:crypto');
const fs = require('node:fs/promises');
const { rmSync } = require('node:fs');
const path = require('node:path');
const { newDocument, applyBrief, validateDocument } = require('./document.cjs');

const { advancePlanning } = require('./planning.cjs');
const { startProduction, editShot } = require('./production.cjs');
const { seedExample } = require('./example.cjs');
const { sourcePath, isGeneratedFile } = require('./generated-files.cjs');

const mediaTypes = {
  image: ['png', 'jpg', 'jpeg', 'webp', 'heic', 'heif', 'avif', 'gif', 'tif', 'tiff', 'bmp', 'svg'],
  video: ['mp4', 'mov', 'm4v', 'webm', 'mkv', 'avi', 'mts', 'm2ts'],
  audio: ['mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg', 'opus', 'aiff'],
  document: ['txt', 'md', 'pdf', 'doc', 'docx', 'srt', 'vtt', 'ppt', 'pptx'],
};
const extensions = Object.values(mediaTypes).flat();

async function inspectFile(filename) {
  const name = path.basename(filename);
  const ext = path.extname(name).slice(1).toLowerCase();
  const kind = Object.keys(mediaTypes).find(type => mediaTypes[type].includes(ext));
  if (!kind) throw new Error(`暂不支持此文件格式：${name}`);
  const stat = await fs.stat(filename).catch(() => null);
  if (!stat?.isFile()) throw new Error(`无法读取素材：${name}`);
  return { name, kind, size: stat.size };
}

function storyboardStore(studio, workspace) {
  if (typeof workspace !== 'string' || !studio.getWorkspace(workspace)) throw new Error('请先选择工作区');
  const db = studio.db;
  function releaseGenerated(stored) {
    if (!isGeneratedFile(stored)) return;
    const filename = sourcePath(stored);
    const shared = db.prepare('SELECT 1 FROM video_storyboard_sources WHERE source_path IN (?, ?) LIMIT 1').get(filename, stored);
    if (!shared) rmSync(filename, { force: true });
  }
  function read(id) {
    const row = db.prepare('SELECT revision, updated_at, document FROM video_storyboards WHERE workspace = ? AND id = ?').get(workspace, id);
    if (!row) throw new Error('在此工作区找不到作品');
    const document = JSON.parse(row.document);
    if (document.schemaVersion !== 1) throw new Error('此作品需要更新版本的 Pi Studio');
    return { id, revision: row.revision, updatedAt: row.updated_at, document };
  }

  // Load the latest graph under the write lock. A brief edit cannot revert an import or a branch.
  function update(id, edit, { affectsFilm = true } = {}) {
    return studio.transaction(() => {
      const work = read(id);
      if (edit(work.document) === false) return work;
      validateDocument(work.document);
      // Auditioning models and collecting candidates do not change an already rendered movie.
      work.document.renderRevision = affectsFilm ? work.revision + 1 : work.document.renderRevision ?? work.revision;
      work.revision += 1;
      work.updatedAt = Date.now();
      db.prepare('UPDATE video_storyboards SET revision = ?, updated_at = ?, document = ? WHERE id = ?')
        .run(work.revision, work.updatedAt, JSON.stringify(work.document), id);
      return work;
    });
  }

  return {
    workspace,
    list() {
      return db.prepare(`SELECT id, json_extract(document, '$.title') AS title, updated_at AS updatedAt
        FROM video_storyboards WHERE workspace = ? ORDER BY updated_at DESC, rowid DESC`).all(workspace);
    },
    create(example = false) {
      const id = randomUUID();
      return studio.transaction(() => {
        const doc = newDocument();
        const links = [];
        if (example) seedExample(doc, (assetId, filename) => links.push([assetId, filename]));
        validateDocument(doc);
        db.prepare('INSERT INTO video_storyboards(id, workspace, revision, updated_at, document) VALUES (?, ?, 1, ?, ?)')
          .run(id, workspace, Date.now(), JSON.stringify(doc));
        const link = db.prepare('INSERT INTO video_storyboard_sources(work_id, asset_id, source_path) VALUES (?, ?, ?)');
        for (const [assetId, filename] of links) link.run(id, assetId, filename);
        return read(id);
      });
    },
    owns(id) { return Boolean(db.prepare('SELECT 1 FROM video_storyboards WHERE workspace = ? AND id = ?').get(workspace, id)); },
    read,
    update,
    addGenerated(id, asset, storedSource) {
      return update(id, doc => {
        if (!doc.shots.some(shot => shot.id === asset.generated.shotId)) throw new Error('找不到生成素材所属的镜头');
        db.prepare('INSERT INTO video_storyboard_sources(work_id, asset_id, source_path) VALUES (?, ?, ?)')
          .run(id, asset.id, storedSource);
        doc.assets.push(asset);
        doc.nodes[0].assetIds.push(asset.id);
      }, { affectsFilm: false });
    },
    advance(id, input) {
      return update(id, doc => advancePlanning(doc, input), { affectsFilm: false });
    },
    startProduction(id, input) {
      return update(id, doc => startProduction(doc, input));
    },
    editShot(id, shotId, patch) {
      return update(id, doc => editShot(doc, shotId, patch));
    },
    source(id, assetId) {
      const asset = read(id).document.assets.find(item => item.id === assetId);
      const row = db.prepare('SELECT source_path FROM video_storyboard_sources WHERE work_id = ? AND asset_id = ?').get(id, assetId);
      if (!asset || !row) throw new Error('找不到作品中的素材');
      return { asset, filename: sourcePath(row.source_path) };
    },
    async relink(id, assetId, filename) {
      const replacement = await inspectFile(filename);
      let previous;
      const work = update(id, doc => {
        const asset = doc.assets.find(item => item.id === assetId);
        if (asset?.kind !== replacement.kind) throw new Error('请选择同类型的素材文件');
        const duplicate = db.prepare('SELECT asset_id FROM video_storyboard_sources WHERE work_id = ? AND source_path = ?').get(id, filename);
        if (duplicate && duplicate.asset_id !== assetId) throw new Error('此文件已经是作品中的另一份素材');
        previous = db.prepare('SELECT source_path FROM video_storyboard_sources WHERE work_id = ? AND asset_id = ?').get(id, assetId)?.source_path;
        if (previous && isGeneratedFile(previous) && sourcePath(previous) === filename) return false;
        db.prepare('UPDATE video_storyboard_sources SET source_path = ? WHERE work_id = ? AND asset_id = ?').run(filename, id, assetId);
        // A replacement chosen from disk no longer has the originating model's duration or provenance.
        delete asset.generated;
        Object.assign(asset, replacement, { sourceRevision: randomUUID() });
      });
      releaseGenerated(previous);
      return work;
    },
    editBrief(id, patch) {
      const { updatedAt, revision } = update(id, doc => applyBrief(doc, patch));
      return { updatedAt, revision };
    },
    async addFiles(id, files) {
      if (!files.length) return read(id);
      const picked = [];
      for (const filename of new Set(files)) {
        picked.push({ filename, asset: { id: randomUUID(), ...await inspectFile(filename) } });
      }
      return update(id, doc => {
        let changed = false;
        for (const { filename, asset } of picked) {
          const inserted = db.prepare('INSERT INTO video_storyboard_sources(work_id, asset_id, source_path) VALUES (?, ?, ?) ON CONFLICT(work_id, source_path) DO NOTHING')
            .run(id, asset.id, filename);
          if (!inserted.changes) continue;
          doc.assets.push(asset);
          doc.nodes[0].assetIds.push(asset.id);
          changed = true;
        }
        return changed;
      });
    },
    removeFile(id, assetId) {
      let removed;
      const work = update(id, doc => {
        if (!doc.assets.some(asset => asset.id === assetId)) return false;
        const referenced = [...doc.nodes.slice(1), ...doc.plans, ...doc.shots].some(row => row.assetIds.includes(assetId))
          || doc.tracks.some(track => track.clips.some(clip => clip.assetId === assetId));
        if (referenced) throw new Error('已有讨论、方案或分镜引用了这份素材，请保留它以便回看');
        doc.assets = doc.assets.filter(asset => asset.id !== assetId);
        doc.nodes[0].assetIds = doc.nodes[0].assetIds.filter(value => value !== assetId);
        removed = db.prepare('DELETE FROM video_storyboard_sources WHERE work_id = ? AND asset_id = ? RETURNING source_path').get(id, assetId);
      }, { affectsFilm: false });
      releaseGenerated(removed?.source_path);
      return work;
    },
  };
}

module.exports = { extensions, mediaTypes, storyboardStore };
