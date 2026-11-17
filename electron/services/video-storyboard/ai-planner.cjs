const fs = require('node:fs');
const path = require('node:path');
const { requestCreativeJson } = require('./creative-model.cjs');
const { currentBrief } = require('./planning.cjs');

const skill = path.join(__dirname, '../../../assets/storyboard/skills/storyboard-planner/SKILL.md');
const actions = new Set(['start', 'explore', 'choose', 'answer', 'materials', 'defer']);
const kinds = new Set(['audio', 'video', 'document', 'image']);
const invalid = '模型没有给出有效的创作建议，请重试或换一个文本模型';

function planningBrief(doc, input) {
  const nodes = new Map(doc.nodes.map(node => [node.id, node]));
  const parent = nodes.get(input?.parentId);
  if (!parent || !actions.has(input.action)) throw new Error('请选择当前创作节点并回答');
  const chain = [];
  let node = parent;
  while (node.parentId) {
    const previous = nodes.get(node.parentId);
    if (!previous || chain.length >= nodes.size) throw new Error('此条创作分支记录不完整');
    const reply = node.step?.reply || '';
    const direction = previous.step?.options?.find(option =>
      node.step?.choiceId ? option.id === node.step.choiceId : option.title === reply) ?? previous.step?.direction;
    chain.push({ question: previous.question, reply, direction, assetIds: node.assetIds, deferred: node.step?.deferred });
    node = previous;
  }
  const brief = parent.step?.brief ?? currentBrief(doc);
  const reply = { action: input.action };
  if (input.action === 'answer') {
    if (typeof input.text !== 'string' || !input.text.trim() || input.text.length > 4000) throw new Error('请填写 1 至 4000 字的创作想法');
    reply.text = input.text.trim();
  }
  if (input.action === 'choose') {
    reply.choice = parent.step?.options?.find(row => row.id === input.choiceId);
    if (!reply.choice) throw new Error('请选择当前节点的叙事方向');
  }
  if (input.action === 'materials') {
    if (!Array.isArray(input.assetIds) || !input.assetIds.length || input.assetIds.some(id => !doc.assets.some(a => a.id === id))) {
      throw new Error('请选择本作品的素材');
    }
    reply.assetIds = input.assetIds;
  }
  // Preview the just-selected assets first. Generated media belonging to another cut stays there.
  const chosen = new Set(reply.assetIds);
  const selectedAssetIds = (parent.step?.selectedAssetIds ?? []).filter(id => doc.assets.some(a => a.id === id));
  const branchIds = new Set([...chosen, ...selectedAssetIds, ...chain.flatMap(turn => turn.assetIds)]);
  const available = doc.assets.filter(asset => !asset.generated || branchIds.has(asset.id));
  const assets = [...available.filter(a => chosen.has(a.id)),
    ...available.filter(a => !chosen.has(a.id) && branchIds.has(a.id)),
    ...available.filter(a => !branchIds.has(a.id))]
    .map(({ id, name, kind }) => ({ id, name, kind }));
  return { task: 'plan-next', title: doc.title, brief, discussion: chain.reverse(),
    current: { kind: parent.kind, question: parent.question, direction: parent.step?.direction, options: parent.step?.options,
      reason: parent.step?.reason, deferred: parent.step?.deferred, selectedAssetIds },
    reply, assets };
}

function text(value, max) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error(invalid);
  return value.trim();
}

function list(value, min, max) {
  if (!Array.isArray(value) || value.length < min || value.length > max) throw new Error(invalid);
  return value;
}

function direction(value, id) {
  return { id, title: text(value?.title, 200), beats: list(value.beats, 1, 24).map(beat => text(beat, 600)) };
}

function planningSuggestion(value, { assets, reply, current }) {
  const kind = value?.kind;
  if (!['question', 'direction', 'materials', 'review'].includes(kind)) throw new Error(invalid);
  const suggestion = { kind, question: text(value.question, 400), reason: text(value.reason, 2000) };
  if (kind === 'direction') {
    suggestion.options = list(value.options, 2, 3).map((option, i) => direction(option, 'option-' + (i + 1)));
    if (new Set(suggestion.options.map(option => option.title)).size !== suggestion.options.length) throw new Error(invalid);
  }
  if (kind === 'materials' || kind === 'review') suggestion.direction = direction(value.direction, 'planned');
  if (kind === 'materials') {
    const need = value.direction.need;
    const types = list(need?.kinds, 1, 4);
    if (types.some(type => !kinds.has(type)) || !Number.isSafeInteger(need.count) || need.count < 1 || need.count > 24) throw new Error(invalid);
    suggestion.direction.need = { label: text(need.label, 180), kinds: [...new Set(types)], count: need.count };
  }
  if (kind === 'review') {
    if (value.aspect !== undefined) {
      if (!['16:9', '9:16', '1:1'].includes(value.aspect)) throw new Error(invalid);
      suggestion.aspect = value.aspect;
    }
    const known = new Set(assets.map(asset => asset.id));
    const ids = list(value.assetIds, 0, known.size);
    if (ids.some(id => !known.has(id)) || new Set(ids).size !== ids.length) throw new Error('模型引用了清单以外或重复的素材，请重新生成建议');
    suggestion.assetIds = ids;
    if (value.deferred !== undefined) suggestion.deferred = value.deferred === '' ? '' : text(value.deferred, 1000);
  }
  if (value.releasedAssetIds !== undefined) {
    const ids = list(value.releasedAssetIds, 0, current.selectedAssetIds.length);
    if (ids.length) {
      const kept = new Set([...(reply.assetIds ?? []), ...(suggestion.assetIds ?? [])]);
      if (!['answer', 'materials'].includes(reply.action) || new Set(ids).size !== ids.length ||
          ids.some(id => !current.selectedAssetIds.includes(id) || kept.has(id))) {
        throw new Error('模型给出的素材取舍与当前选择不一致，请重新生成建议');
      }
      suggestion.releasedAssetIds = ids;
    }
  }
  return suggestion;
}

async function generatePlanningStep(doc, input, options = {}) {
  const brief = planningBrief(doc, input);
  const systemPrompt = [
    fs.readFileSync(skill, 'utf8'),
    '回复一个 JSON 对象。基础字段 kind、question、reason 均必填；question 是下一节点给作者看的标题或问题，reason 简述这一步的具体依据。不要生成数据库标识、确认、分镜或工具调用。',
    'kind 为 question 时只用基础字段；direction 另含 options（2 至 3 项，每项 {title,beats}）；materials 另含 direction:{title,beats,need:{label,kinds,count}}，kinds 仅 image、video、audio、document；review 另含 direction:{title,beats} 和 assetIds（本次拟用素材的真实 ID 数组，纯文字方案可为空），可选 deferred 记录待补内容。',
    'beats 是 1 至 24 项的字符串数组。根据 current 和 reply 决定下一步。若 reply.action=explore 请回应继续头脑风暴的意愿。defer 表示作者选择先按现有材料推进。choose 选定了一种讲法，materials 表示作者新选的素材，answer.text 是作者的创作意见。',
    '用户已补齐或已暂缓的缺口不再重复索要。用替代剪法解决了原有待补项时，在 review 中明确给出 deferred:""；尚未解决时只写真实剩余的待补用途。',
    'current.selectedAssetIds 是作者亲自选定且仍在使用的素材。默认沿用。仅当本轮 answer 或 materials 清楚表明作者要求弃用或替换其中某项时，额外返回 releasedAssetIds，仅列被替换的旧 ID，不能与本轮选定素材或本方案 assetIds 重复。',
    'assets 中 imageNumber 是随附缩略图的 1 起始序号，excerpt 是有界文稿摘录，其余素材仅提供名称、类型和已有讨论。输出所用素材 ID 必须来自 assets。',
    'review 中把作者已明确约定的画幅单独写到 aspect（16:9、9:16 或 1:1），以便预览与输出采用同一画幅。优先沿用已选画幅，若作者在讨论中明确改了画幅则用新约定。未约定可省略。',
  ].join('\n\n');
  const { result, modelRef } = await requestCreativeJson({
    brief, modelRef: input.modelRef, systemPrompt, tokenLimit: 4096, invalidResponse: invalid,
  }, options);
  return { modelRef, suggestion: planningSuggestion(result, brief) };
}

module.exports = { generatePlanningStep, planningBrief };
