const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { newDocument } = require('../../electron/services/video-storyboard/document.cjs');
const { seedExample, sourcePath } = require('../../electron/services/video-storyboard/example.cjs');
const { generateStoryboardDraft } = require('../../electron/services/video-storyboard/ai-director.cjs');

function sample() {
  const doc = newDocument();
  const sources = new Map();
  seedExample(doc, (id, stored) => sources.set(id, { filename: sourcePath(stored) }));
  return { doc, sources, planId: doc.approvedPlanId };
}

function writer(handler, supportsImages = false) {
  return async modelRef => ({
    modelRef: modelRef || 'test/model',
    model: { input: supportsImages ? ['text', 'image'] : ['text'], maxTokens: 8000 },
    complete: handler,
  });
}

function answer(data) {
  return { stopReason: 'stop', content: [{ type: 'text', text: JSON.stringify(data) }] };
}

test('the director loads the production skill and grounds a whole film in the approved branch and selected files', async t => {
  const { doc, sources, planId } = sample();
  const before = structuredClone(doc.shots);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'storyboard-director-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const filename = path.join(tmp, '解说稿.md');
  fs.writeFileSync(filename, '从地球按钮打开来源列表。' + '字幕参考'.repeat(900));
  doc.assets.push({ id: 'script', name: '解说稿.md', kind: 'document', size: fs.statSync(filename).size },
    { id: 'other', name: '未采用的婚礼素材.png', kind: 'image', size: 1 });
  doc.plans[0].assetIds.push('script');
  sources.set('script', { filename });
  doc.nodes.push({ id: 'sibling', parentId: doc.nodes[0].id, assetIds: ['other'], step: { reply: '未采用的讨论路径' } });
  doc.nodes[0].answer = '另一条方案后来改过的起点';
  const expected = { shots: before.map(shot => ({ sourceShotId: shot.id, purpose: '画面 · ' + shot.purpose })) };
  let captured;
  const result = await generateStoryboardDraft(doc, { scope: 'plan', planId, modelRef: 'demo/director' }, {
    resolveWriter: writer((context, settings) => {
      assert.equal(settings.maxTokens, 8000);
      assert(settings.signal instanceof AbortSignal);
      captured = context;
      return answer(expected);
    }, true),
    sourceFor: id => sources.get(id),
    thumbnail: async filename => ({ type: 'image', data: Buffer.from(path.basename(filename)).toString('base64'), mimeType: 'image/jpeg' }),
  });
  const blocks = captured.messages[0].content;
  const input = JSON.parse(blocks[0].text);
  assert.equal(blocks.length, 5);
  assert.equal(input.assets.find(a => a.id === 'script').excerpt.length, 2400);
  assert.match(input.assets.find(a => a.id === 'script').excerpt, /^从地球按钮/);
  assert.deepEqual(input.assets.filter(a => a.kind === 'image').map(a => a.imageNumber), [1, 2, 3, 4]);
  assert.equal(input.shots[2].clips.find(c => c.role === 'effect').offsetMs, before[2].composition.pointer.atMs);
  assert.doesNotMatch(blocks[0].text, /未采用的|另一条方案后来改过的起点/);
  assert(!blocks[0].text.includes(tmp));
  assert.equal(input.plan.id, planId);
  assert.equal(result.modelRef, 'demo/director');
  assert(result.skillNames.includes('storyboard-director'));
  assert(captured.systemPrompt.includes('# 分镜导演'));
  assert.deepEqual(result.shots, expected.shots);
  assert.deepEqual(doc.shots, before);
});

test('a single-shot text request reads no images, keeps adjacent shot summaries and demands one change', async () => {
  const { doc, planId } = sample();
  const target = doc.shots[2];
  const input = { planId, scope: 'shot', shotId: target.id, instruction: '把点击前的停顿拉长' };
  const patch = { sourceShotId: target.id, durationMs: 4400 };
  let calls = 0;
  let sourceReads = 0;
  const options = { sourceFor: () => { sourceReads++; throw Error('unexpected file read'); },
    resolveWriter: writer(ctx => {
      calls++;
      assert.equal(ctx.messages[0].content.length, 1);
      const material = JSON.parse(ctx.messages[0].content[0].text);
      assert.equal(material.selectedShotId, target.id);
      assert.equal(material.shots.length, 3);
      assert.equal(material.shots[0].nearby, true);
      assert.deepEqual(material.shots[1].composition, target.composition);
      return { stopReason: 'stop', content: [{ type: 'text', text: '```json\n' + JSON.stringify({ shots: [patch] }) + '\n```' }] };
    }) };
  const result = await generateStoryboardDraft(doc, input, options);
  assert.deepEqual(result.shots, [patch]);
  for (const invalid of [{ shotId: 'unknown' }, { instruction: ' ' }, { scope: 'plan' }, { modelRef: 'unknown' }]) {
    await assert.rejects(generateStoryboardDraft(doc, { ...input, ...invalid }, options));
  }
  assert.equal(calls, 1);
  assert.equal(sourceReads, 0);
  await assert.rejects(generateStoryboardDraft(doc, input, { resolveWriter: writer(() => answer({ shots: [patch, patch] })) }), /只接受一个镜头/);
});

test('malformed, incomplete and failed model replies are recoverable and exclude provider secrets', async () => {
  const { doc, planId } = sample();
  const input = { scope: 'plan', planId };
  for (const [response, pattern] of [
    [{ stopReason: 'length' }, /长度上限/],
    [{ stopReason: 'stop', content: [{ type: 'text', text: '{"shots":[]}' }] }, /可用的分镜/],
    [{ stopReason: 'error', errorMessage: '401 request with private credentials foo-bar' }, /认证或权限/],
    [new Error('private text foo-bar'), /模型调用失败/],
  ]) {
    await assert.rejects(generateStoryboardDraft(doc, input, { resolveWriter: writer(() => {
      if (response instanceof Error) throw response;
      return response;
    }) }), error => pattern.test(error.message) && !error.message.includes('foo-bar'));
  }
});
