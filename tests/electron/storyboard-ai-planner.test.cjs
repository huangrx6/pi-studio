const assert = require('node:assert/strict');
const test = require('node:test');
const { mkdtemp, rm, writeFile } = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { newDocument } = require('../../electron/main/services/video-storyboard/document.cjs');
const { generatePlanningStep } = require('../../electron/main/services/video-storyboard/ai-planner.cjs');

function writer(respond, vision = false) {
  return async modelRef => ({ modelRef: modelRef ?? 'test/planner',
    model: { input: vision ? ['text', 'image'] : ['text'], maxTokens: 16384 },
    async complete(context, options) {
      assert.equal(options.maxTokens, 4096);
      assert(options.signal instanceof AbortSignal);
      assert.match(context.systemPrompt, /# 创作策划/);
      const blocks = context.messages[0].content;
      const data = respond(JSON.parse(blocks[0].text), blocks);
      return { stopReason: 'stop', content: [{ type: 'text', text: JSON.stringify(data) }] };
    } });
}

const review = { kind: 'review', question: '按这个顺序进入制作？', reason: '已有照片和讲稿。',
  direction: { title: '从现场讲起', beats: ['片头', '现场'] }, assetIds: [] };

test('a complete brief can go directly to review using existing screenshots and a bounded script excerpt', async t => {
  const doc = newDocument();
  const folder = await mkdtemp(path.join(os.tmpdir(), 'pi-planner-'));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const script = path.join(folder, '稿子.md');
  await writeFile(script, '只演示找到来源的入口。'.repeat(400));
  doc.nodes[0].answer = '给新用户做 15 秒的网页来源演示';
  doc.assets.push({ id: 'footer', kind: 'image', name: '回答底部.png' }, { id: 'script', kind: 'document', name: '稿子.md' });
  const before = structuredClone(doc);
  const result = await generatePlanningStep(doc, { parentId: doc.nodes[0].id, modelRef: 'demo/vision', action: 'start' }, {
    sourceFor: id => ({ filename: id === 'script' ? script : path.join(folder, 'image.png') }),
    thumbnail: async () => ({ type: 'image', mimeType: 'image/jpeg', data: 'aW1n' }),
    resolveWriter: writer((context, blocks) => {
      assert.equal(context.task, 'plan-next');
      assert.equal(context.brief.idea, before.nodes[0].answer);
      assert.equal(context.assets[1].excerpt.length, 2400);
      assert.equal(context.assets[0].imageNumber, 1);
      assert.equal(blocks.length, 2);
      assert(!JSON.stringify(context).includes(folder));
      return { ...review, assetIds: ['footer', 'script'] };
    }, true),
  });
  assert.equal(result.modelRef, 'demo/vision');
  assert.deepEqual(result.suggestion.assetIds, ['footer', 'script']);
  assert.equal(result.suggestion.direction.id, 'planned');
  assert.deepEqual(doc, before);
});

test('a branch carries the historical idea, answers and selected direction, never sibling discussions or unrelated generated material', async () => {
  const doc = newDocument();
  const root = doc.nodes[0];
  root.answer = '最近修改过的起点';
  const brief = { idea: '婚礼照片视频', genre: 'wedding', aspect: '16:9', focus: '给父母看' };
  const choice = { id: 'vows', title: '听誓词，看照片', beats: ['誓词', '合影'] };
  doc.nodes.push({ id: 'q', parentId: root.id, kind: 'question', question: '想给谁看？', assetIds: [], step: { reply: brief.idea, brief } },
    { id: 'dir', parentId: 'q', kind: 'direction', question: '更喜欢哪种？', assetIds: [], step: { brief, reply: '给父母看', options: [choice] } },
    { id: 'other', parentId: root.id, kind: 'question', question: '妹妹的惊喜', assetIds: ['secret'] });
  doc.assets.push({ id: 'secret', name: '另一版本的生成图片', kind: 'image', generated: { shotId: 'other-shot' } });
  const result = await generatePlanningStep(doc, { action: 'choose', parentId: 'dir', choiceId: 'vows' }, {
    resolveWriter: writer(context => {
      assert.equal(context.brief.idea, brief.idea);
      assert.deepEqual(context.reply.choice, choice);
      assert.deepEqual(context.discussion.map(d => d.reply), [brief.idea, '给父母看']);
      assert.doesNotMatch(JSON.stringify(context), /最近修改|妹妹的惊喜|另一版本|secret/);
      return { kind: 'materials', question: '可以提供仪式上的原声吗？', reason: '想听到两人的原话。',
        direction: { ...choice, need: { label: '誓词原声', kinds: ['audio', 'video'], count: 1 } } };
    }),
  });
  assert.equal(result.suggestion.direction.need.label, '誓词原声');
  doc.nodes.push({ id: 'later', parentId: 'dir', kind: 'question', question: '哪里要慢下来？', assetIds: [],
    step: { brief, reply: choice.title } });
  await generatePlanningStep(doc, { action: 'answer', parentId: 'later', text: '合影多留两秒' }, {
    resolveWriter: writer(context => {
      assert.deepEqual(context.discussion.at(-1).direction, choice);
      return review;
    }),
  });
});

test('brainstorming returns actionable choices and a deferred material can lead to a text-only review', async () => {
  const doc = newDocument();
  const root = doc.nodes[0];
  root.answer = '如何产生静电';
  const opts = [ {title: '先提问', beats: ['观察']}, {title: '先回答', beats: ['解释']} ];
  const next = await generatePlanningStep(doc, { parentId: root.id, action: 'explore' }, {
    resolveWriter: writer(() => ({ kind: 'direction', question: '想从哪里开场？', reason: '有哪些常见现象？', options: opts })),
  });
  assert.deepEqual(next.suggestion.options.map(o => o.id), ['option-1', 'option-2']);
  doc.nodes.push({ id: 'need', parentId: root.id, kind: 'materials', question: '可以放一段实验吗？', assetIds: [],
    step: { brief: { idea: root.answer, focus: '', genre: 'education', aspect: 'auto' }, reply: '先看实验' } });
  const deferred = await generatePlanningStep(doc, { parentId: 'need', action: 'defer' }, {
    resolveWriter: writer(data => {
      assert.equal(data.reply.action, 'defer');
      return { ...review, direction: { title: '用文字卡模拟现象', beats: ['示意', '解释'] }, deferred: '实验视频' };
    }),
  });
  assert.deepEqual(deferred.suggestion.assetIds, []);
  assert.equal(deferred.suggestion.deferred, '实验视频');
});

test('rejects invalid model nodes, invented asset IDs and client-side confirmation before changing a document', async () => {
  const doc = newDocument();
  const input = { parentId: doc.nodes[0].id, action: 'start' };
  const initial = structuredClone(doc);
  for (const data of [{ ...review, kind: 'approve' }, { ...review, assetIds: ['invented'] },
    { ...review, kind: 'materials', direction: { ...review.direction, need: { label: '图', count: 0, kinds: ['unknown'] } } },
    { ...review, kind: 'direction', options: [] }]) {
    await assert.rejects(generatePlanningStep(doc, input, { resolveWriter: writer(() => data) }));
  }
  let requests = 0;
  await assert.rejects(generatePlanningStep(doc, { ...input, action: 'approve' }, { resolveWriter: writer(() => { requests++; }) }));
  assert.equal(requests, 0);
  assert.deepEqual(doc, initial);
});

test('only a changed user selection can release previously chosen material', async () => {
  const doc = newDocument();
  const brief = { idea: '婚礼祝福', genre: 'wedding', aspect: 'auto', focus: '' };
  doc.assets = ['vows', 'photo', 'extra'].map(id => ({ id, kind: 'image', name: id + '.jpg' }));
  doc.nodes.push({ id: 'review', kind: 'review', parentId: doc.nodes[0].id, assetIds: ['vows'],
    question: '按这版开始？', step: { brief, reply: '选择誓词照片', selectedAssetIds: ['vows'] } });
  const answer = { parentId: 'review', action: 'answer', text: '不要原来誓词的照片了，换成合影' };
  const suggest = (input, release, keep) => generatePlanningStep(doc, input, {
    resolveWriter: writer(data => {
      assert.deepEqual(data.current.selectedAssetIds, ['vows']);
      return { ...review, releasedAssetIds: release, assetIds: keep };
    }),
  });
  assert.deepEqual((await suggest(answer, ['vows'], ['photo'])).suggestion.releasedAssetIds, ['vows']);
  await assert.rejects(suggest(answer, ['extra'], []));
  await assert.rejects(suggest(answer, ['vows'], ['vows']));
  await assert.rejects(suggest({ parentId: 'review', action: 'defer' }, ['vows'], []));
  await assert.rejects(suggest({ parentId: 'review', action: 'materials', assetIds: ['vows'] }, ['vows'], []));
});
