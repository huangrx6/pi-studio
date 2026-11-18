const { randomUUID } = require('node:crypto');

function startProduction(doc, { planId, reuse = [] }) {
  if (!planId || planId !== doc.approvedPlanId) throw new Error('请先确认要制作的方案');
  if (doc.shots.some(shot => shot.planId === planId)) return false;
  const plan = doc.plans.find(item => item.id === planId);
  const step = doc.nodes.find(node => node.id === plan.nodeId)?.step;
  const beats = step?.direction?.beats;
  const purposes = beats?.length ? beats : [step?.direction?.title || plan.summary];
  if (!Array.isArray(reuse) || reuse.length > purposes.length) throw new Error('沿用镜头无效');
  const borrowed = new Map();
  const sources = new Set();
  for (const item of reuse) {
    const shot = doc.shots.find(row => row.id === item?.shotId);
    if (!shot || !Number.isInteger(item.index) || item.index < 0 || item.index >= purposes.length ||
        borrowed.has(item.index) || sources.has(shot.id)) throw new Error('请选择已有的镜头');
    borrowed.set(item.index, shot);
    sources.add(shot.id);
  }
  const direction = step?.direction?.id;
  for (const [index, purpose] of purposes.entries()) {
    const id = randomUUID();
    const previous = borrowed.get(index);
    if (previous) {
      doc.shots.push({ ...structuredClone(previous), id, planId });
      for (const track of doc.tracks) {
        const clips = track.clips.filter(clip => clip.shotId === previous.id);
        track.clips.push(...clips.map(clip => ({ ...clip, shotId: id })));
      }
      continue;
    }
    // A comparison uses both views together. A photo-led cut returns to its opening image.
    const usesSelection = direction === 'compare' ? index === 1 : index === 0 || (direction === 'photo' && index === purposes.length - 1);
    doc.shots.push({ id, planId, purpose, durationMs: 4000, framing: '', subjects: '', setting: '', motion: '', sound: '',
      assetIds: usesSelection && step?.direction?.need ? [...plan.assetIds] : [], captions: [] });
  }
}

const notes = new Set(['purpose', 'framing', 'subjects', 'setting', 'motion', 'sound']);
function editShot(doc, shotId, patch) {
  const shot = doc.shots.find(row => row.id === shotId);
  if (!shot) throw new Error('找不到这个镜头');
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('镜头修改无效');
  for (const [key, value] of Object.entries(patch)) {
    if (notes.has(key)) {
      if (typeof value !== 'string' || value.length > 16000) throw new Error('镜头说明过长或格式无效');
    } else if (key === 'assetIds') {
      if (!Array.isArray(value) || new Set(value).size !== value.length || value.some(id => !doc.assets.some(asset => asset.id === id))) {
        throw new Error('请选择本作品中的素材');
      }
    } else if (key === 'captions') {
      if (!Array.isArray(value) || value.length > 1000 || value.some(c => !c || typeof c.text !== 'string' || c.text.length > 2000)) throw new Error('字幕格式无效');
    } else if (key === 'composition') {
      const point = value?.pointer;
      if (value?.mutedAudioIds !== undefined) {
        const timed = new Set(doc.tracks.flatMap(track => track.clips.filter(clip => clip.shotId === shotId).map(clip => clip.assetId)));
        if (!Array.isArray(value.mutedAudioIds) || value.mutedAudioIds.some(id => !timed.has(id))) throw new Error('请选择本镜的音轨');
      }
      if (!value || typeof value !== 'object' || Array.isArray(value) ||
          Object.keys(value).some(k => !['camera', 'transition', 'heading', 'pointer', 'callout', 'volume', 'mutedAudioIds'].includes(k)) ||
          ![undefined, 'still', 'push', 'pull'].includes(value.camera) || ![undefined, 'cut', 'dissolve'].includes(value.transition) ||
          (value.heading !== undefined && (typeof value.heading !== 'string' || value.heading.length > 200)) ||
          (value.volume !== undefined && (!Number.isFinite(value.volume) || value.volume < 0 || value.volume > 1)) ||
          (point !== undefined && (!point || ![point.x, point.y].every(v => Number.isFinite(v) && v >= 0 && v <= 1) ||
            !Number.isSafeInteger(point.atMs) || point.atMs < 0 || point.atMs >= (patch.durationMs ?? shot.durationMs)))) throw new Error('合成设置无效');
    } else if (key === 'durationMs') {
      if (!Number.isSafeInteger(value) || value <= 0 || value > 3600000) throw new Error('镜头时长须在一小时以内');
      if ((patch.captions ?? shot.captions).some(caption => caption.endMs > value) || doc.tracks.some(track =>
        track.clips.some(clip => clip.shotId === shotId && clip.offsetMs + clip.durationMs > value))) {
        throw new Error('请保留足够的时长容纳已有字幕和音轨');
      }
    } else throw new Error('未知镜头字段');
    shot[key] = value;
  }
}

module.exports = { startProduction, editShot };
