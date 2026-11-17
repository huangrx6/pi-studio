const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createStudioDatabase } = require('../../electron/core/studio-db.cjs');
const { storyboardStore } = require('../../electron/services/video-storyboard/store.cjs');
const { createDirectorDrafts } = require('../../electron/services/video-storyboard/director-drafts.cjs');
const { loadDirectorSkills } = require('../../electron/services/video-storyboard/director-skills.cjs');

function workspace(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-director-workflow-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function fixture(t) {
  const root = workspace(t);
  const studio = createStudioDatabase(':memory:');
  t.after(() => studio.close());
  const other = path.join(root, 'other');
  studio.upsertWorkspace({ cwd: root });
  studio.upsertWorkspace({ cwd: other });
  const store = storyboardStore(studio, root);
  const work = store.create(true);
  return { store, other: storyboardStore(studio, other), work,
    input: { planId: work.document.approvedPlanId, shotId: work.document.shots[0].id, instruction: '以特写开场' } };
}

const result = { shots: [{ framing: '特写' }], modelRef: 'test/text', skillNames: ['storyboard-director'] };

test('only the source workspace and work can apply or discard a proposal; adoption consumes it', async t => {
  const { store, other, work, input } = fixture(t);
  const second = store.create(true);
  const drafts = createDirectorDrafts(async () => result);
  const suggestion = await drafts.propose(store, work.id, input);
  assert.equal(store.read(work.id).revision, work.revision);
  for (const [target, id] of [[other, work.id], [store, second.id]]) {
    assert.throws(() => drafts.apply(target, id, suggestion.id), /找不到这份分镜建议/);
    drafts.discard(target, id, suggestion.id);
  }
  const updated = drafts.apply(store, work.id, suggestion.id);
  assert.equal(updated.document.shots[0].framing, '特写');
  assert.throws(() => drafts.apply(store, work.id, suggestion.id), /找不到这份分镜建议/);

  const next = await drafts.propose(store, work.id, { ...input, shotId: work.document.shots[1].id });
  drafts.discard(store, work.id, next.id);
  assert.throws(() => drafts.apply(store, work.id, next.id), /找不到这份分镜建议/);
  assert.deepEqual(store.read(work.id), updated);
});

test('concurrent requests for the same shot share a guard; manual edits during generation make adoption stale', async t => {
  const { store, work, input } = fixture(t);
  const pending = Promise.withResolvers();
  let calls = 0;
  const drafts = createDirectorDrafts(async () => {
    calls++;
    return calls === 1 ? pending.promise : result;
  });
  const first = drafts.propose(store, work.id, input);
  await assert.rejects(drafts.propose(store, work.id, input), /正在生成/);
  const adjacent = await drafts.propose(store, work.id, { ...input, shotId: work.document.shots[1].id });
  assert.equal(calls, 2);
  store.editShot(work.id, input.shotId, { framing: '作者已手动改为全景' });
  pending.resolve(result);
  const stale = await first;
  assert.throws(() => drafts.apply(store, work.id, stale.id), /已更新/);
  assert.equal(drafts.apply(store, work.id, adjacent.id).document.shots[0].framing, '作者已手动改为全景');
  const fresh = await drafts.propose(store, work.id, input);
  assert.equal(drafts.apply(store, work.id, fresh.id).document.shots[0].framing, '特写');
});

test('failed generation releases its slot, and old abandoned previews expire without saving', async t => {
  const { store, work, input } = fixture(t);
  let fail = true;
  const drafts = createDirectorDrafts(async () => {
    if (fail) throw new Error('model offline');
    return result;
  });
  await assert.rejects(drafts.propose(store, work.id, input), /model offline/);
  fail = false;
  const first = await drafts.propose(store, work.id, input);
  let latest;
  for (let i = 0; i < 32; i++) latest = await drafts.propose(store, work.id, input);
  assert.throws(() => drafts.apply(store, work.id, first.id), /找不到这份分镜建议/);
  assert.equal(store.read(work.id).revision, work.revision);
  assert.equal(drafts.apply(store, work.id, latest.id).revision, work.revision + 1);
});

test('director loads only callable installed video skills for the chosen aspect', t => {
  const root = workspace(t);
  const skills = ['remotion-markup', 'portrait-subtitle-layout', 'landscape-subtitle-layout', 'other'].map(name => {
    const file = path.join(root, name + '.md');
    fs.writeFileSync(file, `---\nname: ${name}\n---\nreference-${name}-body`);
    return { name, path: file, available: true, disableModelInvocation: false };
  });
  const discover = cwd => { assert.equal(cwd, root); return { skills }; };
  for (const [aspect, layout] of [['16:9', 'landscape-subtitle-layout'], ['9:16', 'portrait-subtitle-layout'], ['1:1', null]]) {
    const { names, prompt } = loadDirectorSkills(root, aspect, discover);
    assert.deepEqual(names, ['storyboard-director', 'remotion-markup', ...(layout ? [layout] : [])]);
    for (const { name } of skills) assert.equal(prompt.includes(`reference-${name}-body`), names.includes(name));
  }
  skills[0].disableModelInvocation = true;
  skills[1].available = false;
  const { names, prompt } = loadDirectorSkills(root, '9:16', discover);
  assert.deepEqual(names, ['storyboard-director']);
  assert.doesNotMatch(prompt, /reference-[a-z-]+-body/);
});
