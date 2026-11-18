const { randomUUID, createHash } = require('node:crypto');
const { inferGenre, directionOptions } = require('./directions.cjs');

function currentBrief(doc) {
  return { idea: doc.nodes[0].answer.trim() || doc.title.trim(), genre: doc.genre, aspect: doc.aspect, focus: '' };
}

function directionStep(brief, reply, exploring) {
  const genre = inferGenre(brief.genre, brief.idea + ' ' + brief.focus);
  return {
    kind: 'direction', question: '你想怎样讲这个故事？',
    step: { brief: { ...brief, genre }, reply, reason: brief.focus ? '根据刚才补充的想法，选一种叙事顺序。' : '先确定开场和收尾，再挑需要的素材。',
      options: directionOptions(genre, reply, exploring) },
  };
}

function reviewStep(brief, reply, direction, assetIds, deferred = '') {
  return {
    kind: 'review', question: '用这份方案筹备分镜吗？', assetIds,
    step: { brief, reply, direction, deferred, reason: '核对叙事顺序、画幅和素材后，可以确认这一版。' },
  };
}

function nextStep(doc, parent, input) {
  const initial = parent.kind === 'idea';
  const brief = initial ? currentBrief(doc) : parent.step?.brief;
  if (!brief) throw new Error('这条历史记录可以回看，请从创作起点继续讨论');
  const text = input.text?.trim() || '';
  const act = input.action;
  if (act === 'explore' && ['idea', 'direction', 'review'].includes(parent.kind)) {
    return { kind: 'question', question: initial ? '你想为谁拍这支视频，或者想留下什么感受？' : '换一种讲法，你最想改变开场、节奏还是情绪？',
      step: { brief, reply: '继续头脑风暴', exploring: !initial, reason: initial ? '一个观众或一种感受，就能作为创作起点。' : '原来的方向会保留，可以在这里试另一种剪法。' } };
  }
  if (initial && act === 'start') {
    if (!doc.assets.length && brief.genre === 'free' && brief.idea.length < 8) {
      return { kind: 'question', question: '看完以后，你希望观众记住什么？',
        step: { brief, reply: brief.idea || '一起找方向', reason: '先确定想传达的一件事，再决定从哪里开场。' } };
    }
    return directionStep(brief, brief.idea || (doc.assets.length ? '从现有素材出发' : '从题材出发'), false);
  }
  if (parent.kind === 'question' && act === 'answer' && text) {
    const focus = [brief.focus, text].filter(Boolean).join('\n');
    return directionStep({ ...brief, focus }, text, parent.step.exploring);
  }
  if (parent.kind === 'direction' && (act === 'choose' || (act === 'answer' && text))) {
    const direction = act === 'choose' ? parent.step.options.find(option => option.id === input.choiceId)
      : { id: 'custom', title: text, beats: [] };
    if (!direction) throw new Error('请选择当前节点提供的叙事方向');
    const need = direction.need;
    if (!need) return reviewStep(brief, direction.title, direction, doc.assets.map(asset => asset.id));
    const matches = doc.assets.filter(asset => need.kinds.includes(asset.kind));
    if (!need.select && matches.length === need.count) {
      return reviewStep(brief, direction.title, direction, matches.map(asset => asset.id));
    }
    return { kind: 'materials', question: `哪份素材用作${need.label}？`,
      step: { brief, reply: direction.title, direction, reason: `这个方向需要${need.label}，可以选已有素材、添加文件，或记为待补。` } };
  }
  if (parent.kind === 'materials') {
    const direction = parent.step.direction;
    const need = direction.need;
    if (act === 'defer') return reviewStep(brief, '稍后补素材', direction, [], need.label);
    if (act === 'materials') {
      const ids = [...new Set(input.assetIds || [])];
      if (ids.length !== need.count || ids.some(id => !doc.assets.some(asset => asset.id === id && need.kinds.includes(asset.kind)))) {
        throw new Error(`请选择 ${need.count} 份可用于${need.label}的素材`);
      }
      return reviewStep(brief, `已选择${need.label}`, direction, ids);
    }
  }
  throw new Error('请先回答当前节点的问题');
}

function approve(doc, node) {
  if (node.kind !== 'review' || !node.step?.direction) throw new Error('请先核对制作方案');
  if (!node.chosenPlanId) {
    const { brief, direction, deferred } = node.step;
    const summary = [brief.idea, brief.focus, direction.title, ...direction.beats, deferred && `待补：${deferred}`].filter(Boolean).join('\n');
    const plan = { id: randomUUID(), version: doc.plans.reduce((max, p) => Math.max(max, p.version), 0) + 1,
      nodeId: node.id, summary, assetIds: [...node.assetIds] };
    doc.plans.push(plan);
    node.chosenPlanId = plan.id;
  }
  doc.approvedPlanId = node.chosenPlanId;
  doc.activeNodeId = node.id;
}

// Replies belong to the edge leading to a new node. Revisiting a question never overwrites its other answers.
function advancePlanning(doc, input) {
  if (!input || typeof input.requestId !== 'string' || !/^[\w-]{1,80}$/.test(input.requestId) ||
    (input.text !== undefined && (typeof input.text !== 'string' || input.text.length > 4000)) ||
    (input.assetIds !== undefined && !Array.isArray(input.assetIds))) throw new Error('讨论请求无效');
  const parent = doc.nodes.find(node => node.id === input.parentId);
  if (!parent) throw new Error('找不到讨论节点');
  if (doc.nodes.some(node => node.requestIds?.includes(input.requestId))) return false;
  if (input.action === 'approve') {
    approve(doc, parent);
    (parent.requestIds ??= []).push(input.requestId);
    return;
  }
  const next = nextStep(doc, parent, input);
  const key = createHash('sha256').update(JSON.stringify(next)).digest('hex');
  const previous = doc.nodes.find(node => node.parentId === parent.id && node.step?.key === key);
  if (previous) {
    (previous.requestIds ??= []).push(input.requestId);
    doc.activeNodeId = previous.id;
    return;
  }
  const node = { id: randomUUID(), parentId: parent.id, answer: '', chosenPlanId: null, assetIds: [], ...next };
  node.requestIds = [input.requestId];
  node.step.key = key;
  doc.nodes.push(node);
  doc.activeNodeId = node.id;
}

module.exports = { advancePlanning, approve, currentBrief };
