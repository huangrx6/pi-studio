const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createStudioDatabase } = require('../../electron/main/core/studio-db.cjs');
const { storyboardStore } = require('../../electron/main/services/video-storyboard/store.cjs');
const { applyMediaPreferences } = require('../../electron/main/services/video-storyboard/document.cjs');
const render = require('../../electron/main/services/video-storyboard/render-files.cjs');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-storyboard-'));
  const databasePath = path.join(root, 'studio.sqlite');
  let studio = createStudioDatabase(databasePath);
  studio.upsertWorkspace({ cwd: root });
  t.after(() => { studio.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return {
    root, studio, store: storyboardStore(studio, root),
    file(name) { const file = path.join(root, name); fs.writeFileSync(file, 'fixture'); return file; },
    reopen() {
      studio.close();
      studio = createStudioDatabase(databasePath);
      return storyboardStore(studio, root);
    },
  };
}

test('media choices survive reopening without modifying the rendered film or another work', t => {
  const data = fixture(t);
  const { store } = data;
  const first = store.create(true), other = store.create();
  const speech = { providerId: 'studio-a', modelId: 'voice' };
  const image = { providerId: 'studio-b', modelId: 'picture' };
  const catalog = { speech: [speech], image: [image] };
  const set = patch => store.update(first.id, doc => applyMediaPreferences(doc, patch, catalog), { affectsFilm: false });
  set({ speech: { ...speech, voice: '  warm  ' } });
  const both = set({ image });
  assert.equal(both.document.renderRevision, first.revision);
  assert.deepEqual(set({ image }), both);
  assert.throws(() => set({ image: speech }), /未启用/);
  assert.throws(() => set({ speech: { ...speech, voice: 7 } }), /音色/);
  assert.equal(store.read(first.id).revision, both.revision);
  assert.equal(store.read(other.id).document.mediaPreferences, undefined);
  const restored = data.reopen();
  assert.deepEqual(restored.read(first.id).document.mediaPreferences, { speech: { ...speech, voice: 'warm' }, image });
  const updated = restored.editShot(first.id, first.document.shots[0].id, { purpose: '新的开头' });
  assert.equal(updated.document.renderRevision, updated.revision);
});

test('sample export is scoped, byte-identical to preview, and cannot overwrite an input', async t => {
  const { store, root, file } = fixture(t);
  let work = store.create(true);
  const plan = work.document.approvedPlanId;
  assert.deepEqual(work.document.shots.map(s => s.durationMs), [3000, 3500, 4000, 4500]);
  assert.throws(() => store.editShot(work.id, work.document.shots[0].id, { composition: { mutedAudioIds: ['foreign'] } }), /音轨/);
  const filename = file('source.mp4');
  work = await store.addFiles(work.id, [filename]);
  const inputId = work.document.assets.at(-1).id;
  work = store.editShot(work.id, work.document.shots[0].id, { assetIds: [inputId] });
  const job = await render.begin(store, work.id, plan, work.revision);
  t.after(() => render.discard(job.id, work.id));
  await assert.rejects(render.begin(store, work.id, plan, work.revision - 1), /已更新/);
  await assert.rejects(render.read(job.id, 'foreign', inputId, 0, 1), /结束/);
  assert.equal(Buffer.from(await render.read(job.id, work.id, inputId, 2, 3), 'base64').toString(), 'xtu');
  await assert.rejects(render.read(job.id, work.id, inputId, 7, 1), /范围/);
  fs.appendFileSync(filename, ' changed');
  await assert.rejects(render.read(job.id, work.id, inputId, 0, 1), /已变更/);

  const request = new Request('https://example.invalid', { headers: { range: 'bytes=1-2' } });
  assert.equal((await render.stream(request, job.id)).status, 404);
  await render.write(job.id, work.id, 0, Buffer.from('1234').toString('base64'));
  await render.write(job.id, work.id, 1, Buffer.from('AB').toString('base64'));
  await render.finish(job.id, work.id);
  const response = await render.stream(request, job.id);
  assert.equal(response.status, 206);
  assert.equal(await response.text(), 'AB');
  assert.equal(await render.save(job.id, work.id, async () => ({ canceled: true })), null);
  await assert.rejects(render.save(job.id, work.id, async () => ({ filePath: filename })), /作品素材/);
  const dest = path.join(root, 'result.mp4');
  assert.equal(await render.save(job.id, work.id, async () => ({ filePath: dest })), 'result.mp4');
  assert.equal(fs.readFileSync(dest, 'utf8'), '1AB4');
  await render.discard(job.id, work.id);
  assert.equal((await render.stream(request, job.id)).status, 404);
  fs.unlinkSync(filename);
  await assert.rejects(render.begin(store, work.id, plan, work.revision), /镜头 1.*source.mp4/);
});

for (const [genre, title, files] of [
  ['product', '网页来源', ['旧版.png', '新版.png']],
  ['education', '冬天的静电', ['提纲.md']],
  ['wedding', '誓言', ['合影.jpg', '誓词.wav']],
]) {
  test(`restores the ${genre} work, both directions, approved plan, shots and audio by stable ID`, async t => {
    const fixtureData = fixture(t);
    const { store } = fixtureData;
    const work = store.create();
    const idea = work.document.nodes[0];
    store.editBrief(work.id, { genre, idea: title, title, aspect: '16:9' });
    const paths = files.map(name => fixtureData.file(name));
    await store.addFiles(work.id, paths);
    const saved = store.update(work.id, doc => {
      const assetIds = doc.assets.map(asset => asset.id);
      for (const [index, answer] of ['先介绍背景', '直接进入现场'].entries()) {
        const id = 'direction-' + index;
        const planId = 'plan-' + index;
        doc.nodes.push({ id, parentId: idea.id, kind: 'direction', question: '如何开场？', answer, assetIds, chosenPlanId: planId });
        doc.plans.push({ id: planId, version: index + 1, nodeId: id, summary: answer, assetIds });
        doc.activeNodeId = id;
        doc.approvedPlanId = planId;
      }
      for (const id of ['opening', 'closeup']) {
        doc.shots.push({ id, planId: doc.approvedPlanId, purpose: title, durationMs: 4000, framing: '近景',
          subjects: title, setting: '现场', motion: '缓慢推进', assetIds: [assetIds[0]],
          captions: [{ startMs: 0, endMs: 3000, text: title }], sound: '保留环境声' });
      }
      if (genre === 'wedding') doc.tracks.push({ id: 'vows', role: 'original',
        clips: [{ shotId: 'opening', assetId: assetIds[1], offsetMs: 0, durationMs: 4000, gainDb: -3 }] });
    });
    const restored = fixtureData.reopen();
    assert.throws(() => restored.update(work.id, doc => { doc.shots[0].captions[0].endMs = 8000; }), /字幕/);
    assert.throws(() => restored.update(work.id, doc => { doc.schemaVersion = 0; }), /版本/);
    assert.deepEqual(restored.read(work.id), saved);
    assert.equal(restored.list()[0].title, title);
    assert.ok(!JSON.stringify(saved).includes(fixtureData.root));
    assert.throws(() => restored.removeFile(work.id, saved.document.assets[0].id), /引用/);
    assert.deepEqual(await restored.addFiles(work.id, paths), saved);
  });
}

test('imports and concurrent brief edits preserve each other, isolate workspaces and roll back invalid batches', async t => {
  const { store, root, studio, file } = fixture(t);
  const work = store.create();
  const photo = file('wedding.jpg');
  const adding = store.addFiles(work.id, [photo, photo]);
  store.editBrief(work.id, { idea: '只有一张合影' });
  const imported = await adding;
  assert.equal(imported.document.nodes[0].answer, '只有一张合影');
  assert.equal(imported.document.assets.length, 1);
  assert.deepEqual(await store.addFiles(work.id, []), imported);
  await assert.rejects(store.addFiles(work.id, [file('a.png'), path.join(root, 'missing.mp4')]), /无法读取素材/);
  assert.throws(() => store.editBrief(work.id, { title: 'should roll back', genre: 'invalid' }), /题材/);
  assert.throws(() => store.update(work.id, doc => { doc.activeNodeId = 'missing'; }), /引用/);
  assert.deepEqual(store.read(work.id), imported);
  studio.upsertWorkspace({ cwd: root + '-other' });
  const other = storyboardStore(studio, root + '-other');
  assert.deepEqual(other.list(), []);
  assert.throws(() => other.read(work.id), /找不到作品/);
  assert.throws(() => other.editBrief(work.id, { title: 'wrong workspace' }), /找不到作品/);
  assert.throws(() => storyboardStore(studio, ''), /选择工作区/);
  const removed = store.removeFile(work.id, imported.document.assets[0].id);
  assert.deepEqual(removed.document.nodes[0].assetIds, []);
  assert.ok(fs.existsSync(photo));
  assert.equal((await store.addFiles(work.id, [photo])).document.assets.length, 1);
});

test('planning grows from one node, preserves competing wedding cuts and confirms a reusable plan', async t => {
  const data = fixture(t);
  const { store, file } = data;
  const work = store.create();
  const root = work.document.activeNodeId;
  const send = (parentId, requestId, action, fields = {}) => store.advance(work.id, { parentId, requestId, action, ...fields });
  assert.equal(work.document.nodes.length, 1);
  store.editBrief(work.id, { idea: '婚礼当天', genre: 'wedding', aspect: '16:9' });
  const photo = await store.addFiles(work.id, [file('合影.jpg')]);
  const first = send(root, 'start', 'start');
  const direction = first.document.activeNodeId;
  assert.equal(first.document.nodes.at(-1).kind, 'direction');
  const review = send(direction, 'photo', 'choose', { choiceId: 'photo' });
  const photoReview = review.document.activeNodeId;
  assert.deepEqual(review.document.nodes.at(-1).assetIds, [photo.document.assets[0].id]);
  const confirmed = send(photoReview, 'approve-photo', 'approve');
  assert.equal(confirmed.document.plans.length, 1);
  assert.equal(confirmed.document.shots.length, 0);

  const gap = send(direction, 'try-vows', 'choose', { choiceId: 'vows' });
  const missing = gap.document.activeNodeId;
  assert.equal(gap.document.nodes.at(-1).kind, 'materials');
  assert.equal(gap.document.approvedPlanId, confirmed.document.approvedPlanId);
  assert.deepEqual(send(direction, 'try-vows', 'choose', { choiceId: 'vows' }), gap);
  assert.throws(() => send(missing, 'bad', 'materials', { assetIds: [photo.document.assets[0].id] }), /誓词/);
  const deferred = send(missing, 'skip', 'defer');
  assert.equal(deferred.document.nodes.at(-1).step.deferred, '誓词原声');
  const added = await store.addFiles(work.id, [file('誓词.m4a')]);
  const audio = added.document.assets.at(-1).id;
  const selected = send(missing, 'pick-vows', 'materials', { assetIds: [audio] });
  assert.deepEqual(selected.document.nodes.at(-1).assetIds, [audio]);
  const second = send(selected.document.activeNodeId, 'approve-vows', 'approve');
  assert.deepEqual(second.document.plans.map(plan => plan.version), [1, 2]);
  assert.equal(second.document.plans.at(-1).assetIds[0], audio);
  assert.equal(second.document.nodes.filter(node => node.parentId === direction).length, 2);
  assert.equal(second.document.nodes.filter(node => node.parentId === missing).length, 2);
  const replay = send(photoReview, 'approve-photo', 'approve');
  assert.equal(replay.document.approvedPlanId, second.document.approvedPlanId);
  const back = send(direction, 'revisit', 'choose', { choiceId: 'vows' });
  assert.equal(back.document.nodes.length, second.document.nodes.length);
  assert.equal(back.document.activeNodeId, missing);
  const reapproved = send(photoReview, 'explicitly-return', 'approve');
  assert.equal(reapproved.document.plans.length, 2);
  assert.equal(reapproved.document.approvedPlanId, confirmed.document.approvedPlanId);
  // A late retry of the earlier navigation or approval cannot reactivate its old branch.
  assert.deepEqual(send(direction, 'revisit', 'choose', { choiceId: 'vows' }), reapproved);
  assert.deepEqual(send(selected.document.activeNodeId, 'approve-vows', 'approve'), reapproved);
  assert.deepEqual(data.reopen().read(work.id), reapproved);
});

test('short briefs, material-only starts, brainstorm replies and revised ideas each retain their own context', async t => {
  const { store, file } = fixture(t);
  const work = store.create();
  const root = work.document.activeNodeId;
  const send = (parentId, requestId, action, fields = {}) => store.advance(work.id, { parentId, requestId, action, ...fields });
  const ask = send(root, 'empty', 'start');
  const question = ask.document.activeNodeId;
  assert.equal(ask.document.nodes.at(-1).kind, 'question');
  assert.throws(() => send(question, 'blank', 'answer', { text: '   ' }), /回答/);
  const proposal = send(question, 'audience', 'answer', { text: '给小学生讲解静电的原理' });
  const direction = proposal.document.activeNodeId;
  assert.equal(proposal.document.nodes.at(-1).step.brief.genre, 'education');
  const custom = send(direction, 'custom', 'answer', { text: '用毛衣的声音做开场' });
  assert.equal(custom.document.nodes.at(-1).step.direction.title, '用毛衣的声音做开场');
  const again = send(direction, 'another', 'explore');
  const alternate = send(again.document.activeNodeId, 'calm', 'answer', { text: '想要安静一些' });
  assert.equal(alternate.document.nodes.at(-1).step.options[0].id, 'quiet');
  assert.equal(alternate.document.approvedPlanId, null);
  const review = send(alternate.document.activeNodeId, 'quiet-detail', 'choose', { choiceId: 'quiet' });
  const approved = send(review.document.activeNodeId, 'keep-both-ideas', 'approve');
  assert.match(approved.document.plans[0].summary, /给小学生讲解静电的原理\n想要安静一些/);
  await store.addFiles(work.id, [file('提纲.txt')]);
  assert.equal(send(root, 'file-only', 'start').document.nodes.at(-1).kind, 'direction');
  store.editBrief(work.id, { idea: '给工程师演示产品更新' });
  const revised = send(root, 'new-idea', 'start');
  assert.equal(revised.document.nodes.at(-1).step.brief.genre, 'product');
  assert.equal(revised.document.nodes.find(node => node.id === direction).step.brief.focus, '给小学生讲解静电的原理');
  assert.throws(() => send(root, 'early', 'approve'), /核对/);
});

test('production is explicit and repeatable, edits and source links survive switching plans and reopening', async t => {
  const data = fixture(t);
  const { store, file } = data;
  const work = store.create();
  const start = input => store.startProduction(work.id, input);
  const reply = (parentId, fields) => store.advance(work.id, { parentId, requestId: crypto.randomUUID(), ...fields }).document;
  const photoPath = file('合影.png');
  const photo = (await store.addFiles(work.id, [photoPath])).document.assets[0];
  store.editBrief(work.id, { genre: 'wedding' });
  const directions = reply(work.document.activeNodeId, { action: 'start' }).activeNodeId;
  const photoReview = reply(directions, { action: 'choose', choiceId: 'photo' }).activeNodeId;
  assert.throws(() => start({ planId: photoReview }), /确认/);
  const p1 = reply(photoReview, { action: 'approve' }).approvedPlanId;
  const first = start({ planId: p1 });
  const [opening, middle, ending] = first.document.shots;
  assert.deepEqual(first.document.shots.map(s => s.assetIds), [[photo.id], [], [photo.id]]);
  assert.deepEqual(start({ planId: p1 }), first);
  const updated = store.editShot(work.id, opening.id, { motion: '慢慢推近', purpose: '把光留在肩膀上', durationMs: 3200 });
  assert.throws(() => store.editShot(work.id, opening.id, { purpose: 'invalid batch', durationMs: -1 }), /时长/);
  assert.throws(() => store.editShot(work.id, middle.id, { assetIds: ['someone-elses'] }), /本作品/);
  assert.deepEqual(store.read(work.id), updated);
  const missing = reply(directions, { action: 'choose', choiceId: 'vows' }).activeNodeId;
  const vowsReview = reply(missing, { action: 'defer' }).activeNodeId;
  const p2 = reply(vowsReview, { action: 'approve' }).approvedPlanId;
  assert.equal(store.read(work.id).document.shots.length, 3);
  assert.throws(() => start({ planId: p1 }), /确认/);
  assert.throws(() => start({ planId: p2, reuse: [{ index: 1, shotId: opening.id }, { index: 1, shotId: ending.id }] }), /镜头/);
  const next = start({ planId: p2, reuse: [{ index: 1, shotId: opening.id }] });
  assert.equal(next.document.shots.length, 6);
  const borrowed = next.document.shots[4];
  assert.notEqual(borrowed.id, opening.id);
  assert.equal(borrowed.motion, '慢慢推近');
  assert.equal(borrowed.durationMs, 3200);
  store.editShot(work.id, borrowed.id, { purpose: '独立修改' });
  assert.equal(store.read(work.id).document.shots[0].purpose, '把光留在肩膀上');
  const replacement = file('新位置.jpg');
  const moved = await store.relink(work.id, photo.id, replacement);
  assert.equal(moved.document.assets[0].name, '新位置.jpg');
  assert.deepEqual(moved.document.shots[4].assetIds, [photo.id]);
  assert.equal(store.source(work.id, photo.id).filename, replacement);
  await assert.rejects(store.relink(work.id, photo.id, file('录音.mp3')), /同类型/);
  assert.ok(!JSON.stringify(moved).includes(replacement));
  assert.deepEqual(data.reopen().read(work.id), moved);
});
