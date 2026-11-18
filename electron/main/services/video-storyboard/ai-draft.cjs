const { createHash, randomUUID } = require('node:crypto');
const { isDeepStrictEqual } = require('node:util');
const { validateDocument } = require('./document.cjs');
const { editShot } = require('./production.cjs');

const maxFilmMs = 3600000;
const shotFields = ['sourceShotId', 'durationMs', 'purpose', 'framing', 'subjects', 'setting', 'motion', 'sound', 'assetIds', 'captions', 'composition'];

function onlyFields(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).some(key => !keys.includes(key))) throw new Error(label + '格式无效或包含未知字段');
}

function selectScope(doc, { planId, shotId }) {
  const plan = doc.plans.find(item => item.id === planId);
  const planShots = doc.shots.filter(shot => shot.planId === planId);
  if (!plan || !doc.nodes.some(node => node.id === plan.nodeId && node.chosenPlanId === planId) ||
      (!planShots.length && doc.approvedPlanId !== planId)) throw new Error('请选择已确认的制作方案');
  const shots = shotId === undefined ? planShots : planShots.filter(shot => shot.id === shotId);
  if (shotId !== undefined && !shots.length) throw new Error('所选镜头不属于此方案');
  const shotIds = new Set(shots.map(shot => shot.id));
  const tracks = doc.tracks.map(track => ({
    id: track.id, role: track.role, clips: track.clips.filter(clip => shotIds.has(clip.shotId)),
  })).filter(track => track.clips.length);
  const assetIds = new Set([...plan.assetIds, ...shots.flatMap(shot => shot.assetIds),
    ...tracks.flatMap(track => track.clips.map(clip => clip.assetId))]);
  const assets = doc.assets.filter(asset => assetIds.has(asset.id));
  return { plan, shots, tracks, assets };
}

// Only protect material the pending edit depends on. Changes to a different shot or the
// audition settings can still be saved while the model is working on a single shot.
function fingerprint(doc, { plan, shots, tracks, assets }) {
  const input = [doc.title, plan, doc.nodes.find(node => node.id === plan.nodeId)?.step, shots, tracks, assets];
  return createHash('sha256').update(JSON.stringify(input)).digest('hex');
}

function completeShot(scope, planId, source, changes) {
  if (!source && (typeof changes.purpose !== 'string' || !changes.purpose.trim() || changes.durationMs === undefined)) {
    throw new Error('新镜头需要填写镜头目的和时长');
  }
  const shot = source ? structuredClone(source) : {
    id: randomUUID(), planId, purpose: '', durationMs: 4000, framing: '', subjects: '', setting: '', motion: '', sound: '', assetIds: [], captions: [],
  };
  const patch = { ...changes };
  if (Object.hasOwn(patch, 'composition')) {
    onlyFields(patch.composition, ['camera', 'transition', 'heading', 'pointer', 'callout', 'volume', 'mutedAudioIds'], '合成设置');
    const composition = { ...shot.composition, ...patch.composition };
    if (composition.pointer === null) delete composition.pointer;
    if (composition.callout === null) delete composition.callout;
    if (composition.pointer !== undefined) onlyFields(composition.pointer, ['x', 'y', 'atMs'], '指针');
    patch.composition = composition;
  } else if (patch.durationMs !== undefined && shot.composition) {
    // Manual edits validate a supplied pointer against the new duration.
    patch.composition = shot.composition;
  }
  if (Object.hasOwn(patch, 'captions')) {
    if (!Array.isArray(patch.captions) || patch.captions.length > 1000) throw new Error('字幕格式无效');
    for (const caption of patch.captions) onlyFields(caption, ['startMs', 'endMs', 'text'], '字幕');
  }
  editShot({ assets: scope.assets, tracks: scope.tracks, shots: [shot] }, shot.id, patch);
  if (!shot.purpose.trim()) throw new Error('镜头目的不能为空');
  return shot;
}

function projectDraft(doc, draft) {
  if (draft.shotId !== undefined) {
    return { ...doc, shots: doc.shots.map(shot => shot.id === draft.shotId ? draft.shots[0] : shot) };
  }
  const index = doc.shots.findIndex(shot => shot.planId === draft.planId);
  const shots = doc.shots.filter(shot => shot.planId !== draft.planId);
  shots.splice(index < 0 ? shots.length : index, 0, ...draft.shots);
  const keep = new Set(shots.map(shot => shot.id));
  const tracks = doc.tracks.map(track => ({ ...track, clips: track.clips.filter(clip => keep.has(clip.shotId)) }));
  return { ...doc, shots, tracks };
}

function checkDuration(doc, next, planId) {
  const duration = work => work.shots.reduce((sum, shot) => shot.planId === planId ? sum + shot.durationMs : sum, 0);
  if (duration(next) > Math.max(maxFilmMs, duration(doc))) throw new Error('AI 分镜总时长超过一小时，请缩短成片或分段生成');
}

function prepareDraft(doc, { planId, shotId }, result) {
  const scope = selectScope(doc, { planId, shotId });
  onlyFields(result, ['shots'], 'AI 分镜');
  if (!Array.isArray(result.shots) || !result.shots.length || result.shots.length > 64 ||
      (shotId !== undefined && result.shots.length !== 1)) throw new Error('AI 返回的镜头数量无效');
  const reused = new Set();
  const shots = result.shots.map(row => {
    onlyFields(row, shotFields, 'AI 镜头');
    const { sourceShotId, ...changes } = row;
    const id = sourceShotId === undefined ? shotId : sourceShotId;
    const source = scope.shots.find(item => item.id === id);
    if (id !== undefined && (!source || reused.has(id))) throw new Error('AI 引用了范围以外或重复的镜头');
    if (source) reused.add(source.id);
    const shot = completeShot(scope, planId, source, changes);
    if (shotId !== undefined && isDeepStrictEqual(source, shot)) throw new Error('AI 没有修改这个镜头，请说明想调整的地方');
    return shot;
  });
  const draft = { planId, ...(shotId !== undefined && { shotId }), shots, baseFingerprint: fingerprint(doc, scope) };
  const next = projectDraft(doc, draft);
  checkDuration(doc, next, planId);
  validateDocument(next);
  return draft;
}

// draft comes from the main process's reviewed proposal cache, never from the renderer.
function applyDraft(doc, draft) {
  const scope = selectScope(doc, draft);
  if (fingerprint(doc, scope) !== draft.baseFingerprint) throw new Error('方案、镜头或素材已更新，请重新生成草稿');
  const next = projectDraft(doc, draft);
  checkDuration(doc, next, draft.planId);
  if (isDeepStrictEqual(doc.shots, next.shots) && isDeepStrictEqual(doc.tracks, next.tracks)) return false;
  doc.shots = next.shots;
  doc.tracks = next.tracks;
}

module.exports = { prepareDraft, applyDraft };
