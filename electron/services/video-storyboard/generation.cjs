const fs = require('node:fs/promises');
const { randomUUID } = require('node:crypto');
const { requestGeneration } = require('./generation-request.cjs');
const { sourcePath, writeGeneratedFile } = require('./generated-files.cjs');

const running = new Set();

function field(value, max, label) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error(`${label}为空或过长`);
  return value.trim();
}

async function generateMedia(store, workId, input, options = {}) {
  const { kind, shotId } = input ?? {};
  if (!['speech', 'image'].includes(kind)) throw new Error('请选择旁白或画面');
  const { document } = store.read(workId);
  const shot = document.shots.find(s => s.id === shotId);
  if (!shot) throw new Error('找不到这个镜头');
  const speech = kind === 'speech';
  const generated = { kind, shotId, providerId: field(input.providerId, 256, '模型来源'),
    modelId: field(input.modelId, 512, '模型 ID'), prompt: field(input.prompt, speech ? 4096 : 16000, speech ? '旁白文稿' : '画面描述') };
  if (speech) generated.voice = field(input.voice, 256, '音色');
  const key = JSON.stringify([workId, shotId, kind]);
  if (running.has(key)) throw new Error('此镜头已有同类型的生成任务，请等待完成');
  running.add(key);
  try {
    const resolveModel = options.resolveModel ?? require('../media-models.cjs').resolveMediaModel;
    const model = await resolveModel(kind, generated.providerId, generated.modelId);
    const plan = document.plans.find(p => p.id === shot.planId);
    const aspect = document.nodes.find(n => n.id === plan?.nodeId)?.step?.brief.aspect ?? document.aspect;
    const { bytes, ext, durationMs } = await requestGeneration(model, { ...generated, aspect }, options.fetcher);
    if (speech) generated.durationMs = durationMs;
    const id = randomUUID();
    let stored;
    try { stored = await writeGeneratedFile(workId, id, ext, bytes); }
    catch { throw new Error('无法保存生成素材，请检查 Studio 数据目录的可用空间和写入权限'); }
    const scene = document.shots.filter(s => s.planId === shot.planId).findIndex(s => s.id === shotId) + 1;
    const asset = { id, kind: speech ? 'audio' : 'image', size: bytes.length, generated,
      name: `第 ${scene} 镜${speech ? '旁白' : '画面'} · ${id.slice(0, 6)}.${ext}` };
    try { return { work: store.addGenerated(workId, asset, stored), assetId: id }; }
    catch (error) {
      await fs.rm(sourcePath(stored), { force: true }).catch(() => {});
      throw error;
    }
  } finally { running.delete(key); }
}

function applyGeneratedMedia(store, workId, input) {
  const { shotId, assetId } = input ?? {};
  return store.update(workId, doc => {
    const shot = doc.shots.find(s => s.id === shotId);
    const asset = doc.assets.find(a => a.id === assetId);
    if (!shot || asset?.generated?.shotId !== shotId) throw new Error('请选择这个镜头生成的素材');
    if (asset.generated.kind === 'image') {
      const old = new Set(doc.assets.filter(a => a.generated?.kind === 'image').map(a => a.id));
      const images = [assetId, ...shot.assetIds.filter(id => !old.has(id))];
      if (images.length === shot.assetIds.length && images.every((id, i) => shot.assetIds[i] === id)) return false;
      shot.assetIds = images;
      return;
    }
    const tracks = doc.tracks.filter(t => t.role === 'narration');
    const prior = tracks.flatMap(t => t.clips.filter(c => c.shotId === shotId)).sort((a, b) => a.offsetMs - b.offsetMs);
    const offsetMs = prior[0]?.offsetMs ?? 0;
    const durationMs = asset.generated.durationMs;
    if (!Number.isSafeInteger(durationMs) || durationMs <= 0 || offsetMs + durationMs > 3600000) throw new Error('旁白超过镜头可容纳的时长');
    const replaced = new Set([...prior.map(c => c.assetId), ...doc.assets.filter(a => a.generated?.kind === 'speech').map(a => a.id)]);
    const muted = shot.composition?.mutedAudioIds || [];
    if (prior.length === 1 && prior[0].assetId === assetId && !muted.includes(assetId) &&
      !shot.assetIds.some(id => replaced.has(id)) && prior[0].durationMs === durationMs) return false;
    // Preserve the existing narration's entry and level while leaving music, original audio and effects in place.
    const destination = tracks.find(t => t.clips.some(c => c.shotId === shotId)) ?? tracks[0];
    for (const track of tracks) track.clips = track.clips.filter(c => c.shotId !== shotId);
    const clip = { assetId, shotId, offsetMs, durationMs, gainDb: prior[0]?.gainDb ?? 0 };
    if (destination) destination.clips.push(clip);
    else doc.tracks.push({ id: randomUUID(), role: 'narration', clips: [clip] });
    shot.durationMs = Math.max(shot.durationMs, offsetMs + durationMs);
    shot.assetIds = shot.assetIds.filter(id => !replaced.has(id));
    if (muted.length) {
      const timed = new Set(doc.tracks.flatMap(t => t.clips.filter(c => c.shotId === shotId).map(c => c.assetId)));
      shot.composition.mutedAudioIds = muted.filter(id => id !== assetId && timed.has(id));
    }
  });
}

module.exports = { generateMedia, applyGeneratedMedia };
