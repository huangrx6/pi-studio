const test = require('node:test');
const assert = require('node:assert/strict');
const { newDocument, validateDocument } = require('../../electron/services/video-storyboard/document.cjs');
const { seedExample } = require('../../electron/services/video-storyboard/example.cjs');
const { prepareDraft, applyDraft } = require('../../electron/services/video-storyboard/ai-draft.cjs');
const { editShot } = require('../../electron/services/video-storyboard/production.cjs');

function example() {
  const doc = newDocument();
  seedExample(doc, () => {});
  return doc;
}

test('whole-film preview is inert and adoption reorders the chosen plan with its timed sound', () => {
  const doc = example();
  const planId = doc.approvedPlanId;
  const [open, before, click, close] = doc.shots;
  const oldPlan = { ...doc.plans[0], id: 'old-plan', version: 2, nodeId: 'old-review' };
  doc.nodes.push({ ...doc.nodes[1], id: oldPlan.nodeId, chosenPlanId: oldPlan.id });
  doc.plans.push(oldPlan);
  const other = { ...open, id: 'old-shot', planId: oldPlan.id };
  doc.shots.unshift(other);
  doc.tracks[0].clips.push({ ...doc.tracks[0].clips[0], shotId: other.id });
  const initial = structuredClone(doc);
  const result = { shots: [
    { sourceShotId: before.id, purpose: '回顾原来的阅读方式' },
    { sourceShotId: click.id },
    { sourceShotId: close.id, composition: { camera: 'push' } },
    { purpose: '阅读原文', durationMs: 2000, composition: { heading: '打开网页来源' } },
  ] };
  const draft = prepareDraft(doc, { planId }, result);
  assert.deepEqual(doc, initial);
  assert.equal(draft.shots.length, 4);
  assert.equal(draft.shots[0].id, before.id);
  assert.equal(draft.shots[3].assetIds.length, 0);
  applyDraft(doc, draft);
  validateDocument(doc);
  assert.deepEqual(doc.shots[0], other);
  assert.deepEqual(doc.shots.slice(1), draft.shots);
  assert.deepEqual(doc.assets, initial.assets);
  assert.deepEqual(doc.tracks.map(t => t.clips), initial.tracks.map(t => t.clips.filter(c => c.shotId !== open.id)));
  assert.deepEqual(doc.shots[3].composition, { ...close.composition, camera: 'push' });
});

test('single-shot preview merges individual fields, can clear a pointer, and preserves simultaneous edits elsewhere', () => {
  const doc = example();
  const shot = doc.shots[2];
  const scope = { planId: doc.approvedPlanId, shotId: shot.id };
  const draft = prepareDraft(doc, scope, { shots: [{ composition: { pointer: null, camera: 'pull' }, motion: '缓慢拉远' }] });
  assert.equal(draft.shots[0].composition.pointer, undefined);
  assert.deepEqual(draft.shots[0].captions, shot.captions);
  assert.deepEqual(draft.shots[0].assetIds, shot.assetIds);
  doc.shots[0].purpose = '制作人正在修改的开场';
  doc.tracks[0].clips[0].gainDb = -12;
  doc.assets.push({ id: 'new', kind: 'image', name: '后来导入.jpg', size: 80 });
  const concurrent = structuredClone(doc);
  applyDraft(doc, draft);
  assert.deepEqual(doc.shots.filter(s => s.id !== shot.id), concurrent.shots.filter(s => s.id !== shot.id));
  assert.deepEqual(doc.tracks, concurrent.tracks);
  assert.deepEqual(doc.assets, concurrent.assets);
  validateDocument(doc);
});

test('late adoption refuses conflicting edits to the target, its audio, its assets or the plan', () => {
  for (const change of [
    (doc, shot) => { shot.setting = '手工改动'; },
    doc => { doc.tracks[0].clips[0].offsetMs++; },
    doc => { doc.assets[0].name = '重新定位.jpg'; },
    doc => { doc.plans[0].summary = '更新的目标'; },
  ]) {
    const doc = example();
    const shot = doc.shots[0];
    const draft = prepareDraft(doc, { planId: shot.planId, shotId: shot.id }, { shots: [{ purpose: '拍摄工作环境' }] });
    change(doc, shot);
    const current = structuredClone(doc);
    assert.throws(() => applyDraft(doc, draft), /已更新/);
    assert.deepEqual(doc, current);
  }
  const doc = example();
  const draft = prepareDraft(doc, { planId: doc.approvedPlanId }, { shots: [{ purpose: '新开场', durationMs: 2000 }] });
  doc.shots.at(-1).motion = '修改片尾';
  assert.throws(() => applyDraft(doc, draft), /已更新/);
});

test('model output cannot cross shot scope, introduce executable fields, or truncate existing timing', () => {
  const doc = example();
  const shot = doc.shots[2];
  const entire = { planId: doc.approvedPlanId };
  const single = { ...entire, shotId: shot.id };
  doc.assets.push({ id: 'unused', name: '其他方案的底片.jpg', kind: 'image', size: 32 });
  const initial = structuredClone(doc);
  for (const [scope, shots, error] of [
    [single, [{ sourceShotId: doc.shots[0].id, purpose: '改开场' }], /范围/],
    [single, [{ purpose: '一' }, { purpose: '二' }], /数量/],
    [entire, [{ sourceShotId: shot.id }, { sourceShotId: shot.id }], /重复/],
    [entire, [{ sourceShotId: 'unknown' }], /范围/],
    [entire, [{ purpose: '未设时长' }], /时长/],
    [single, [{ assetIds: ['another-work'] }], /素材/],
    [single, [{ assetIds: ['unused'] }], /素材/],
    [single, [{ composition: { script: 'return 1' } }], /未知字段/],
    [single, [{ captions: [{ startMs: 0, endMs: 5000, text: '越界' }] }], /字幕/],
    [single, [{ durationMs: 1000, captions: [], composition: { pointer: null } }], /音轨/],
    [single, [{ composition: { pointer: { x: 3, y: 0, atMs: 0 } } }], /合成/],
    [single, [{ purpose: shot.purpose }], /没有修改/],
    [entire, [{ purpose: '一', durationMs: 3600000 }, { purpose: '二', durationMs: 1 }], /一小时/],
  ]) assert.throws(() => prepareDraft(doc, scope, { shots }), error);
  assert.deepEqual(doc, initial);
});

test('a confirmed plan without existing shots can start with a code-rendered text scene', () => {
  const doc = example();
  doc.shots = [];
  doc.tracks = [];
  const draft = prepareDraft(doc, { planId: doc.approvedPlanId }, { shots: [
    { purpose: '先让观众看见问题', durationMs: 2200, composition: { heading: '来源在哪里？' },
      captions: [{ startMs: 100, endMs: 2000, text: '打开回答底部的地球按钮。' }] },
  ] });
  applyDraft(doc, draft);
  validateDocument(doc);
  assert.equal(doc.shots[0].composition.heading, '来源在哪里？');
  assert.deepEqual(doc.shots[0].assetIds, []);
});

test('timed callouts stay inside the frame and shot, survive manual editing, and can be removed independently', () => {
  const doc = example();
  const shot = doc.shots[2];
  const scope = { planId: shot.planId, shotId: shot.id };
  const box = { x: .12, y: .84, width: .13, height: .12, startMs: 1500, endMs: 3200, label: '网页来源' };
  const propose = callout => prepareDraft(doc, scope, { shots: [{ composition: { callout } }] });
  for (const invalid of [
    { x: -.2 }, { y: 1.1 }, { width: 0 }, { width: 1 }, { height: -1 }, { height: Infinity },
    { endMs: 5000 }, { endMs: 1400 }, { startMs: 1.5 }, { label: '字'.repeat(81) }, { label: 123 }, { css: 'red' },
  ]) assert.throws(() => propose({ ...box, ...invalid }), /画面标注/);
  const selected = propose(box);
  applyDraft(doc, selected);
  const applied = doc.shots[2];
  assert.deepEqual(applied.composition.pointer, shot.composition.pointer);
  assert.deepEqual(applied.composition.callout, box);
  editShot(doc, shot.id, { composition: { ...applied.composition, heading: '点击这里' } });
  validateDocument(doc);
  const shortened = structuredClone(doc);
  editShot(shortened, shot.id, { durationMs: 3100, captions: [] });
  assert.throws(() => validateDocument(shortened), /画面标注时间/);
  applyDraft(doc, propose(null));
  assert.equal(doc.shots[2].composition.callout, undefined);
  assert.equal(doc.shots[2].composition.heading, '点击这里');
  assert.deepEqual(doc.shots[2].composition.pointer, shot.composition.pointer);
});
