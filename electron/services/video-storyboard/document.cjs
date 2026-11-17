const { randomUUID } = require('node:crypto');

const genres = new Set(['free', 'education', 'wedding', 'product']);
const aspects = new Set(['auto', '16:9', '9:16', '1:1']);

function newDocument() {
  const id = randomUUID();
  return {
    schemaVersion: 1, title: '', genre: 'free', aspect: 'auto',
    activeNodeId: id, approvedPlanId: null,
    nodes: [{ id, parentId: null, kind: 'idea', question: '你想拍一支怎样的视频？', answer: '', assetIds: [], chosenPlanId: null }],
    assets: [], plans: [], shots: [], tracks: [],
  };
}

function applyBrief(document, patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('创作起点无效');
  for (const [key, value] of Object.entries(patch)) {
    if (typeof value !== 'string') throw new Error('创作起点格式无效');
    switch (key) {
      case 'title':
        if (value.length > 120) throw new Error('片名最多 120 个字符');
        document.title = value;
        break;
      case 'idea':
        if (value.length > 16000) throw new Error('创作想法最多 16000 个字符');
        document.nodes[0].answer = value;
        break;
      case 'genre':
        if (!genres.has(value)) throw new Error('未知题材');
        document.genre = value;
        break;
      case 'aspect':
        if (!aspects.has(value)) throw new Error('未知画幅');
        document.aspect = value;
        break;
      default:
        throw new Error('未知创作字段');
    }
  }
}

function applyMediaPreferences(document, patch, catalog) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('作品模型配置无效');
  const preferences = { ...document.mediaPreferences };
  let changed = false;
  for (const [kind, value] of Object.entries(patch)) {
    if (kind !== 'speech' && kind !== 'image') throw new Error('未知的媒体生成能力');
    if (!value || !catalog[kind].some(model => model.providerId === value.providerId && model.modelId === value.modelId)) {
      throw new Error('此模型未启用，请在模型设置中检查来源和用途');
    }
    const choice = { providerId: value.providerId, modelId: value.modelId };
    if (kind === 'speech' && value.voice !== undefined) {
      if (typeof value.voice !== 'string' || value.voice.length > 256) throw new Error('音色标识最多 256 个字符');
      if (value.voice.trim()) choice.voice = value.voice.trim();
    }
    const current = preferences[kind];
    if (current?.providerId === choice.providerId && current.modelId === choice.modelId && current.voice === choice.voice) continue;
    preferences[kind] = choice;
    changed = true;
  }
  if (changed) document.mediaPreferences = preferences;
  return changed;
}

function validateCallout(box, durationMs) {
  if (!box || typeof box !== 'object' || Array.isArray(box) ||
      Object.keys(box).some(key => !['x', 'y', 'width', 'height', 'startMs', 'endMs', 'label'].includes(key)) ||
      ![box.x, box.y, box.width, box.height].every(Number.isFinite) ||
      box.x < 0 || box.y < 0 || box.width <= 0 || box.height <= 0 || box.x + box.width > 1 || box.y + box.height > 1 ||
      (box.label !== undefined && (typeof box.label !== 'string' || box.label.length > 80))) throw new Error('画面标注的位置、大小或文字无效');
  if (!Number.isSafeInteger(box.startMs) || !Number.isSafeInteger(box.endMs) ||
      box.startMs < 0 || box.startMs >= box.endMs || box.endMs > durationMs) throw new Error('画面标注时间超出镜头范围');
}

// Nodes are stored in creation order. A parent must already exist, which also excludes cycles.
function validateDocument(doc) {
  if (doc.schemaVersion !== 1) throw new Error('分镜作品版本不受支持');
  function ids(rows) {
    const set = new Set(rows.map(row => row.id));
    if (set.size !== rows.length || [...set].some(id => typeof id !== 'string' || !id)) throw new Error('作品条目标识无效');
    return set;
  }
  function requireId(set, id) {
    if (!set.has(id)) throw new Error('作品包含无效引用');
  }
  const nodes = new Set();
  const assets = ids(doc.assets);
  const plans = ids(doc.plans);
  const shots = ids(doc.shots);
  ids(doc.nodes);
  ids(doc.tracks);
  if (!doc.nodes.length || doc.nodes[0].kind !== 'idea' || doc.nodes[0].parentId !== null) throw new Error('缺少创作起点');
  for (const [i, node] of doc.nodes.entries()) {
    if (i) requireId(nodes, node.parentId);
    nodes.add(node.id);
    node.assetIds.forEach(id => requireId(assets, id));
    if (node.chosenPlanId !== null) requireId(plans, node.chosenPlanId);
  }
  requireId(nodes, doc.activeNodeId);
  if (doc.approvedPlanId !== null) requireId(plans, doc.approvedPlanId);
  for (const plan of doc.plans) {
    if (!Number.isSafeInteger(plan.version) || plan.version < 1) throw new Error('方案版本无效');
    requireId(nodes, plan.nodeId);
    plan.assetIds.forEach(id => requireId(assets, id));
  }
  for (const shot of doc.shots) {
    if (!Number.isSafeInteger(shot.durationMs) || shot.durationMs <= 0) throw new Error('镜头时长无效');
    if (shot.composition?.callout !== undefined) validateCallout(shot.composition.callout, shot.durationMs);
    for (const caption of shot.captions) {
      if (!Number.isSafeInteger(caption.startMs) || !Number.isSafeInteger(caption.endMs) ||
          caption.startMs < 0 || caption.endMs <= caption.startMs || caption.endMs > shot.durationMs) {
        throw new Error('字幕时间超出镜头范围');
      }
    }
    requireId(plans, shot.planId);
    shot.assetIds.forEach(id => requireId(assets, id));
  }
  for (const track of doc.tracks) {
    for (const clip of track.clips) {
      if (!Number.isSafeInteger(clip.offsetMs) || clip.offsetMs < 0 ||
          !Number.isSafeInteger(clip.durationMs) || clip.durationMs <= 0 || !Number.isFinite(clip.gainDb)) {
        throw new Error('音轨片段参数无效');
      }
      requireId(shots, clip.shotId);
      requireId(assets, clip.assetId);
    }
  }
}

module.exports = { newDocument, applyBrief, applyMediaPreferences, validateDocument };
