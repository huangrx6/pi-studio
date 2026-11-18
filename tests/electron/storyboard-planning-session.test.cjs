const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createStudioDatabase } = require('../../electron/main/core/studio-db.cjs');
const { storyboardStore } = require('../../electron/main/services/video-storyboard/store.cjs');
const { createPlanningSession } = require('../../electron/main/services/video-storyboard/planning-session.cjs');

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-plan-'));
  const database = createStudioDatabase(':memory:');
  database.upsertWorkspace({ cwd: dir });
  const store = storyboardStore(database, dir);
  const work = store.create();
  t.after(() => { database.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { store, work, dir, database, root: work.document.activeNodeId };
}

const direction = { id: 'planned', title: '讲清原理', beats: ['从现象开始', '停在结论'] };
const idea = { kind: 'question', question: '希望谁看懂这个现象？', reason: '观众影响举例的深度' };
const need = { label: '实验录音', count: 1, kinds: ['audio'] };
const missing = { kind: 'materials', question: '有实验原声吗？', reason: '你想保留原声', direction: { ...direction, need } };
const review = { kind: 'review', question: '按这个顺序制作吗？', reason: '现有素材可以支撑说明', direction, assetIds: [] };
const generated = suggestion => ({ modelRef: 'local/director', suggestion });
const reply = (parentId, action, extra) => ({ parentId, action, requestId: crypto.randomUUID(), ...extra });
const active = work => work.document.nodes.find(n => n.id === work.document.activeNodeId);

test('collects only user decisions and waits for explicit confirmation before creating an editable film', async t => {
  const { store, work, root } = fixture(t);
  store.editBrief(work.id, { idea: '小实验', genre: 'education' });
  const queue = [idea, missing, { ...review, deferred: '实验录音' }, review];
  const { advance } = createPlanningSession(async () => generated(queue.shift()));
  await assert.rejects(advance(store, work.id, reply(root, 'approve')), /当前讨论/);
  const q = active(await advance(store, work.id, reply(root, 'start')));
  assert.equal(q.step.modelRef, 'local/director');
  const m = active(await advance(store, work.id, reply(q.id, 'answer', { text: '给四年级学生看，希望听原声' })));
  const offered = await advance(store, work.id, reply(m.id, 'defer'));
  const deferred = active(offered);
  assert.equal(deferred.step.deferred, need.label);
  assert.deepEqual(offered.document.plans, []);
  assert.deepEqual(offered.document.shots, []);
  const change = await advance(store, work.id, reply(deferred.id, 'answer', { text: '片长改为 15 秒' }));
  assert.match(active(change).step.brief.focus, /四年级学生.*\n片长改为 15 秒/);
  assert.equal(active(change).step.deferred, need.label);
  const confirm = reply(active(change).id, 'approve');
  const done = await advance(store, work.id, confirm);
  assert.equal(done.document.plans.length, 1);
  assert.equal(active(done).chosenPlanId, done.document.approvedPlanId);
  assert.deepEqual(done.document.shots.map(s => s.purpose), direction.beats);
  assert.equal(done.productionCreated, true);
  const repeated = await advance(store, work.id, confirm);
  assert.equal(repeated.productionCreated, undefined);
  assert.deepEqual(repeated.document, done.document);
  const reopened = await advance(store, work.id, reply(active(done).id, 'approve'));
  assert.deepEqual(reopened.document.shots, done.document.shots);
  assert.equal(reopened.productionCreated, undefined);
});

test('coalesces duplicate in-flight replies and persists retry identity, but allows a later branch from the same question', async t => {
  const { store, work, root } = fixture(t);
  const deferred = Promise.withResolvers();
  let calls = 0;
  const { advance } = createPlanningSession(async () => ++calls === 1 ? deferred.promise : generated(review));
  const firstRequest = reply(root, 'start'), duplicate = reply(root, 'start');
  const one = advance(store, work.id, firstRequest), two = advance(store, work.id, duplicate);
  assert.equal(calls, 1);
  await assert.rejects(advance(store, work.id, reply(root, 'explore')), /正在生成/);
  deferred.resolve(generated(idea));
  const writes = await Promise.all([one, two]);
  assert.deepEqual(writes[0], writes[1]);
  const restarted = createPlanningSession(() => { throw Error('unexpected model call'); });
  assert.deepEqual(await restarted.advance(store, work.id, firstRequest), writes[0]);
  assert.deepEqual(await restarted.advance(store, work.id, duplicate), writes[0]);
  const branch = await advance(store, work.id, reply(root, 'explore'));
  assert.deepEqual(branch.document.nodes.slice(1).map(n => n.parentId), [root, root]);
  assert.equal(branch.document.activeNodeId, branch.document.nodes.at(-1).id);
});

test('awaits the model outside the write lock, rejects a changed brief or relinked input and permits a retry', async t => {
  const { store, work, dir, root } = fixture(t);
  const target = name => { const folder = path.join(dir, name); fs.mkdirSync(folder); const f = path.join(folder, '讲稿.txt'); fs.writeFileSync(f, name); return f; };
  const material = (await store.addFiles(work.id, [target('old')])).document.assets[0];
  let pending;
  const { advance } = createPlanningSession(() => (pending = Promise.withResolvers()).promise);
  const req = reply(root, 'start');
  const first = advance(store, work.id, req);
  store.editBrief(work.id, { idea: '换一个开头' });
  pending.resolve(generated(review));
  await assert.rejects(first, /已更新/);
  const second = advance(store, work.id, req);
  await store.relink(work.id, material.id, target('new'));
  pending.resolve(generated(review));
  await assert.rejects(second, /已更新/);
  assert.equal(store.read(work.id).document.nodes.length, 1);
  const retry = advance(store, work.id, req);
  pending.resolve(generated(review));
  assert.equal(active(await retry).step.brief.idea, '换一个开头');
});

test('validates material replies before calling the model and retains chosen assets in the confirmed plan', async t => {
  const { store, work, dir, root } = fixture(t);
  const queue = [missing, idea, review];
  const { advance } = createPlanningSession(async () => generated(queue.shift()));
  const node = active(await advance(store, work.id, reply(root, 'start')));
  const image = path.join(dir, '一张图.jpg'), audio = path.join(dir, '实验.wav');
  fs.writeFileSync(image, 'image'); fs.writeFileSync(audio, 'audio');
  const imported = await store.addFiles(work.id, [image, audio]);
  const [picture, voice] = imported.document.assets;
  for (const ids of [[], ['missing'], [picture.id], [voice.id, voice.id]]) {
    await assert.rejects(advance(store, work.id, reply(node.id, 'materials', { assetIds: ids })), /素材/);
  }
  assert.equal(queue.length, 2);
  const followup = active(await advance(store, work.id, reply(node.id, 'materials', { assetIds: [voice.id] })));
  assert.match(followup.step.reply, /实验.wav/);
  const candidate = active(await advance(store, work.id, reply(followup.id, 'answer', { text: '片长 30 秒' })));
  assert.deepEqual(candidate.assetIds, [voice.id]);
  const approved = await advance(store, work.id, reply(candidate.id, 'approve'));
  assert.deepEqual(approved.document.plans[0].assetIds, [voice.id]);
  queue.push({ ...review, releasedAssetIds: [voice.id], assetIds: [picture.id] });
  const alternate = active(await advance(store, work.id, reply(candidate.id, 'answer', { text: '改用图和字幕，原声不再使用' })));
  assert.deepEqual(alternate.assetIds, [picture.id]);
  const updated = await advance(store, work.id, reply(alternate.id, 'approve'));
  assert.deepEqual(updated.document.plans.map(plan => plan.assetIds), [[voice.id], [picture.id]]);
});

test('an agreed alternative clears its material gap when the user postpones it', async t => {
  const { store, work, root } = fixture(t);
  const { advance } = createPlanningSession((_doc, input) => generated(input.action === 'start'
    ? missing : { ...review, direction: { ...direction, title: '字幕解说版' }, deferred: '' }));
  const node = active(await advance(store, work.id, reply(root, 'start')));
  const alternative = active(await advance(store, work.id, reply(node.id, 'defer')));
  assert.equal(alternative.step.deferred, undefined);
  assert.match(alternative.step.reply, /实验录音/);
  const approved = await advance(store, work.id, reply(alternative.id, 'approve'));
  assert.match(approved.document.plans[0].summary, /字幕解说版/);
  assert.doesNotMatch(approved.document.plans[0].summary, /待补/);
});

test('a late branch answer cannot displace a newer confirmed branch; manual planning never contacts a model', async t => {
  const { store, work, root } = fixture(t);
  const pending = Promise.withResolvers();
  const { advance } = createPlanningSession((_d, i) => i.action === 'start' ? generated(review) : pending.promise);
  const candidate = active(await advance(store, work.id, reply(root, 'start')));
  const exploring = advance(store, work.id, reply(root, 'explore'));
  const confirmed = await advance(store, work.id, reply(candidate.id, 'approve'));
  pending.resolve(generated(idea));
  const result = await exploring;
  assert.equal(result.document.activeNodeId, confirmed.document.activeNodeId);
  assert.equal(result.document.approvedPlanId, confirmed.document.approvedPlanId);
  assert.equal(result.document.nodes.at(-1).parentId, root);
  const basicWork = store.create(true);
  const { advance: basic } = createPlanningSession(() => { throw Error('unexpected call'); });
  store.editBrief(basicWork.id, { genre: 'education', idea: '基本制作' });
  const first = active(await basic(store, basicWork.id, reply(basicWork.document.nodes[0].id, 'start', { mode: 'basic' })));
  const manual = active(await basic(store, basicWork.id, reply(first.id, 'answer', { mode: 'basic', text: '讲一件事' })));
  const ready = await basic(store, basicWork.id, reply(manual.id, 'approve', { mode: 'basic' }));
  assert(!ready.document.shots.some(s => s.planId === ready.document.approvedPlanId));
});

test('approving an alternate cut and reopening an edited historical cut preserves both sets of shots and tracks', async t => {
  const { store, dir } = fixture(t);
  const work = store.create(true);
  const original = active(work);
  const edited = store.editShot(work.id, work.document.shots[0].id, { purpose: '已手工细调的开头' });
  const model = Promise.withResolvers();
  const { advance } = createPlanningSession(() => model.promise);
  const generating = advance(store, work.id, reply(original.id, 'answer', { text: '另剪讲解版' }));
  store.addGenerated(work.id, { id: crypto.randomUUID(), kind: 'image', name: '旧镜草图.png', size: 1,
    generated: { shotId: edited.document.shots[0].id } }, path.join(dir, '旧镜草图.png'));
  model.resolve(generated(review));
  const alternate = active(await generating);
  const cut = await advance(store, work.id, reply(alternate.id, 'approve'));
  const restored = await advance(store, work.id, reply(original.id, 'approve'));
  assert.equal(restored.document.approvedPlanId, original.chosenPlanId);
  assert.deepEqual(restored.document.shots, cut.document.shots);
  assert.deepEqual(restored.document.shots.filter(s => s.planId === original.chosenPlanId), edited.document.shots);
  assert.deepEqual(restored.document.tracks, edited.document.tracks);
});
