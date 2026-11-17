const { createHash, randomUUID } = require('node:crypto');
const { generatePlanningStep, planningBrief } = require('./ai-planner.cjs');
const { approve, currentBrief } = require('./planning.cjs');
const { startProduction } = require('./production.cjs');

const actions = {
  idea: ['start', 'explore'],
  question: ['answer', 'explore'],
  direction: ['choose', 'answer', 'explore'],
  materials: ['materials', 'defer', 'answer', 'explore'],
  review: ['approve', 'answer', 'explore'],
};

function readReply(doc, input) {
  if (!input || typeof input.requestId !== 'string' || !/^[\w-]{1,80}$/.test(input.requestId) ||
      (input.mode !== undefined && !['basic', 'ai'].includes(input.mode)) ||
      (input.modelRef !== undefined && (typeof input.modelRef !== 'string' || !input.modelRef.includes('/') || input.modelRef.length > 256))) {
    throw new Error('讨论请求无效');
  }
  const parent = doc.nodes.find(node => node.id === input.parentId);
  if (!actions[parent?.kind]?.includes(input.action)) throw new Error('请先回答当前讨论节点');
  const brief = parent.kind === 'idea' ? currentBrief(doc) : parent.step?.brief;
  if (!brief) throw new Error('这条历史记录可以回看，请从创作起点继续讨论');
  switch (input.action) {
    case 'start': return { parent, brief, reply: brief.idea || '从已有素材开始' };
    case 'explore': return { parent, brief, reply: '继续头脑风暴' };
    case 'answer': {
      const reply = typeof input.text === 'string' && input.text.trim();
      if (!reply || reply.length > 4000) throw new Error('请填写不超过 4000 字的想法');
      return { parent, brief: { ...brief, focus: [brief.focus, reply].filter(Boolean).join('\n') }, reply };
    }
    case 'choose': {
      const option = parent.step.options?.find(item => item.id === input.choiceId);
      if (!option) throw new Error('请选择当前节点提供的叙事方向');
      return { parent, brief, reply: option.title };
    }
    case 'materials': {
      const need = parent.step.direction?.need;
      const ids = input.assetIds;
      if (!need || !Array.isArray(ids) || ids.length !== need.count || new Set(ids).size !== ids.length) {
        throw new Error('请选择节点所需的素材');
      }
      const selected = ids.map(id => doc.assets.find(a => a.id === id));
      if (selected.some(asset => !asset || !need.kinds.includes(asset.kind))) throw new Error('请选择本作品中符合要求的素材');
      return { parent, brief, reply: '采用素材：' + selected.map(a => a.name).join('、'), selected: ids };
    }
    case 'defer': {
      const label = parent.step.direction?.need?.label;
      if (!label) throw new Error('该节点没有待补的素材');
      return { parent, brief, reply: '暂不补充：' + label };
    }
    default: return { parent, brief, reply: '确认方案' };
  }
}

function hash(data) {
  return createHash('sha256').update(JSON.stringify(data)).digest('hex');
}

function planningInputs(doc, input) {
  // Stored parents and their replies are immutable. The root brief can change independently
  // of an earlier branch, whose first child already contains its own brief snapshot.
  const { title, brief, assets } = planningBrief(doc, input);
  const sources = new Map(doc.assets.map(asset => [asset.id, asset]));
  return hash([title, input.parentId, brief, assets.map(({ id, kind, name }) => {
    const { size, sourceRevision } = sources.get(id);
    return [id, kind, name, size, sourceRevision];
  })]);
}

function nextNode({ parent, brief, reply, selected = [] }, input, { modelRef, suggestion }) {
  const { kind, question, reason, options, direction, assetIds = [] } = suggestion;
  const step = { brief, reply, reason, modelRef };
  if (kind === 'review' && suggestion.aspect) step.brief = { ...brief, aspect: suggestion.aspect };
  if (input.action === 'choose') step.choiceId = input.choiceId;
  if (options) step.options = options;
  if (direction) step.direction = direction;
  // Only an author's explicit picks carry forward. Other assets proposed by a model
  // belong to its particular cut and can change between reviews.
  const released = new Set(suggestion.releasedAssetIds);
  const picks = new Set(parent.step?.selectedAssetIds);
  for (const id of released) picks.delete(id);
  for (const id of selected) picks.add(id);
  if (picks.size) step.selectedAssetIds = [...picks];
  // Persist the user's decision to proceed without an asset across additional questions.
  // The planner may resolve a gap by proposing an alternative cut.
  const priorGap = parent.step?.deferred;
  const need = parent.step?.direction?.need?.label;
  let deferred = priorGap;
  if (input.action === 'defer') deferred = [...new Set([priorGap, need].filter(Boolean))].join('、');
  if (input.action === 'materials' && need === priorGap) deferred = '';
  deferred = suggestion.deferred ?? deferred;
  if (deferred) step.deferred = deferred;
  return { id: randomUUID(), parentId: parent.id, kind, question, answer: '', chosenPlanId: null, step,
    assetIds: [...new Set([...picks, ...assetIds])] };
}

function knownRequest(doc, requestId) {
  return doc.nodes.find(node => node.requestIds?.includes(requestId));
}

function createPlanningSession(generate = generatePlanningStep) {
  const pending = new Map();
  async function advance(store, workId, input) {
    if (input?.mode === 'basic') return store.advance(workId, input);
    const work = store.read(workId);
    const answer = readReply(work.document, input);
    const { parent } = answer;
    const replay = knownRequest(work.document, input.requestId);
    if (replay) {
      if (input.action === 'approve' ? replay.id !== parent.id : replay.parentId !== parent.id) throw new Error('讨论请求已用于另一个节点');
      return work;
    }
    if (input.action === 'approve') {
      const hasShots = work.document.shots.some(shot => shot.planId === parent.chosenPlanId);
      let created = false;
      const updated = store.update(workId, doc => {
        const review = doc.nodes.find(node => node.id === input.parentId);
        if (knownRequest(doc, input.requestId)) return false;
        approve(doc, review);
        created = startProduction(doc, { planId: review.chosenPlanId }) !== false;
        (review.requestIds ??= []).push(input.requestId);
      }, { affectsFilm: !hasShots });
      return created ? { ...updated, productionCreated: true } : updated;
    }
    const basis = planningInputs(work.document, input);
    const intent = hash([basis, input.action, answer.reply, input.choiceId, answer.selected, input.modelRef]);
    const key = JSON.stringify([store.workspace, workId, parent.id]);
    const active = pending.get(key);
    if (active) {
      if (active.intent !== intent) throw new Error('这个节点正在生成下一步，请稍后重试');
      active.ids.add(input.requestId);
      return active.promise;
    }
    const ids = new Set([input.requestId]);
    const promise = (async () => {
      const result = await generate(work.document, input, { sourceFor: id => store.source(workId, id) });
      const node = nextNode(answer, input, result);
      return store.update(workId, doc => {
        if ([...ids].some(id => knownRequest(doc, id))) return false;
        const current = doc.nodes.find(candidate => candidate.id === parent.id);
        if (!current || planningInputs(doc, input) !== basis) throw new Error('创作想法或素材已更新，请按最新内容重新生成');
        node.requestIds = [...ids];
        doc.nodes.push(node);
        // A late answer remains attached to its original branch without taking focus from
        // another reply or a plan the user approved while the model was working.
        if (doc.activeNodeId === work.document.activeNodeId && doc.approvedPlanId === work.document.approvedPlanId) {
          doc.activeNodeId = node.id;
        }
      }, { affectsFilm: false });
    })();
    pending.set(key, { ids, intent, promise });
    try { return await promise; }
    finally { pending.delete(key); }
  }
  return { advance };
}

module.exports = { createPlanningSession };
