const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createStudioDatabase } = require('../../electron/main/core/studio-db.cjs');
const { storyboardStore } = require('../../electron/main/services/video-storyboard/store.cjs');
const { requestGeneration } = require('../../electron/main/services/video-storyboard/generation-request.cjs');
const { generateMedia, applyGeneratedMedia } = require('../../electron/main/services/video-storyboard/generation.cjs');
const render = require('../../electron/main/services/video-storyboard/render-files.cjs');

const pixel = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO7ZKaYAAAAASUVORK5CYII=';
const model = { modelId: 'test', baseUrl: 'https://configured.invalid/v1/', apiKey: 'fixture-key' };
const png = () => Response.json({ data: [{ b64_json: pixel }] });

async function fixture(t) {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-generated-work-'));
  const filename = path.join(workspace, 'studio.sqlite');
  let db = createStudioDatabase(filename);
  db.upsertWorkspace({ cwd: workspace });
  t.after(() => { db.close(); fs.rmSync(workspace, { recursive: true, force: true }); });
  const store = storyboardStore(db, workspace);
  const work = store.create(true), shot = work.document.shots[2];
  return { store, work, shot, input: { shotId: shot.id, kind: 'image', providerId: 'source', modelId: 'draw', prompt: '海上日出' },
    reopen() { db.close(); db = createStudioDatabase(filename); return storyboardStore(db, workspace); } };
}

test('candidate generation is scoped to the chosen source, resolves once, preserves other edits and can be auditioned before use', async t => {
  const { store, work, shot, input, reopen } = await fixture(t);
  const calls = [], options = { resolveModel: async (kind, source, id) => {
    assert.deepEqual([kind, source, id], ['image', 'source', 'draw']);
    return { ...model, modelId: id };
  }, fetcher: async (url, opts) => { calls.push([url.href, opts]); return png(); } };
  const pending = generateMedia(store, work.id, input, options);
  await assert.rejects(generateMedia(store, work.id, input, options), /生成任务/);
  const editing = store.editShot(work.id, shot.id, { purpose: '刚改好的意图' });
  const first = await pending;
  assert.equal(first.work.document.renderRevision, editing.document.renderRevision);
  assert.equal(calls.length, 1);
  const [url, { body, headers, redirect }] = calls[0];
  assert.equal(url, 'https://configured.invalid/v1/images/generations');
  assert.deepEqual(JSON.parse(body), { prompt: '海上日出', model: 'draw', n: 1 });
  assert.equal(headers.Authorization, 'Bearer fixture-key');
  assert.equal(redirect, 'error');
  assert.equal(first.work.document.shots[2].purpose, '刚改好的意图');
  assert.deepEqual(first.work.document.shots[2].assetIds, shot.assetIds);
  assert(!JSON.stringify(first.work).includes(model.apiKey));
  const source = store.source(work.id, first.assetId);
  assert.equal(fs.readFileSync(source.filename).toString('base64'), pixel);
  const fromDisk = reopen();
  assert.deepEqual(source, fromDisk.source(work.id, first.assetId));
  assert.equal(source.asset.generated.prompt, input.prompt);
  assert.throws(() => applyGeneratedMedia(fromDisk, work.id, { shotId: work.document.shots[0].id, assetId: first.assetId }), /这个镜头/);
  const apply = id => applyGeneratedMedia(fromDisk, work.id, { shotId: shot.id, assetId: id });
  const now = apply(first.assetId);
  assert(now.document.renderRevision > editing.document.renderRevision);
  assert.deepEqual(now.document.shots[2].assetIds, [first.assetId, ...shot.assetIds]);
  assert.equal(apply(first.assetId).revision, now.revision);
  const next = await generateMedia(fromDisk, work.id, input, options);
  const replaced = apply(next.assetId);
  assert.deepEqual(replaced.document.shots[2].assetIds, [next.assetId, ...shot.assetIds]);
  assert.ok(replaced.document.assets.some(a => a.id === first.assetId));
  fromDisk.removeFile(work.id, first.assetId);
  assert(!fs.existsSync(source.filename));
});

test('generated narration keeps its full length, replaces the selected voice clip, preserves effects and is readable by the film renderer', async t => {
  const { store, work, shot, input } = await fixture(t);
  const bytes = fs.readFileSync(path.join(__dirname, '../../assets/storyboard/web-sources/voice-4.m4a'));
  const oldVoice = work.document.tracks[0].clips.find(c => c.shotId === shot.id);
  const priorEffects = work.document.tracks[1];
  store.update(work.id, doc => {
    doc.shots[2].durationMs = 3000; doc.shots[2].captions = [];
    doc.shots[2].composition.mutedAudioIds = [oldVoice.assetId];
  });
  const { assetId, work: candidates } = await generateMedia(store, work.id, { ...input, kind: 'speech', voice: 'voice-22' }, {
    resolveModel: async () => ({ ...model, modelId: input.modelId }),
    fetcher: async (url, options) => {
      assert.equal(url.pathname, '/v1/audio/speech');
      assert.deepEqual(JSON.parse(options.body), { model: input.modelId, input: input.prompt, voice: 'voice-22', response_format: 'wav' });
      return new Response(bytes);
    },
  });
  const speech = candidates.document.assets.find(a => a.id === assetId);
  assert.equal(speech.kind, 'audio');
  assert(speech.name.endsWith('.m4a'));
  assert(speech.generated.durationMs > 3000);
  const applied = applyGeneratedMedia(store, work.id, { shotId: shot.id, assetId });
  const clips = applied.document.tracks[0].clips.filter(c => c.shotId === shot.id);
  assert.deepEqual(clips, [{ ...oldVoice, assetId, durationMs: speech.generated.durationMs }]);
  assert.deepEqual(applied.document.tracks[1], priorEffects);
  assert.deepEqual(applied.document.shots[2].composition.mutedAudioIds, []);
  assert.equal(applied.document.shots[2].durationMs, oldVoice.offsetMs + speech.generated.durationMs);
  const job = await render.begin(store, work.id, shot.planId, applied.revision);
  t.after(() => render.discard(job.id, work.id));
  assert.equal(job.sizes[assetId], bytes.length);
  assert.equal(job.sizes[oldVoice.assetId], undefined);
  assert.equal(await render.read(job.id, work.id, assetId, 0, 20), bytes.subarray(0, 20).toString('base64'));
});

test('image adapters honor supported aspect ratios and reject redirected credentials, oversized bodies and non-media results', async () => {
  for (const [id, aspect, size, format] of [
    ['gpt-image-2', '9:16', '864x1536', undefined], ['gpt-image-1', '16:9', '1536x1024', undefined],
    ['dall-e-3', '9:16', '1024x1792', 'b64_json'], ['dall-e-2', '16:9', '1024x1024', 'b64_json'], ['custom', '9:16', undefined, undefined],
  ]) await requestGeneration({ ...model, modelId: id }, { kind: 'image', prompt: 'design', aspect }, async (_url, { body }) => {
    const input = JSON.parse(body);
    assert.equal(input.size, size); assert.equal(input.response_format, format);
    return png();
  });
  const imageInput = { kind: 'image', prompt: 'sea' };
  const download = [];
  const result = await requestGeneration(model, imageInput, async (url, opts) => {
    download.push(opts);
    if (download.length === 1) return Response.json({ data: [{ url: '/file.png' }] });
    assert.equal(url.href, 'https://configured.invalid/file.png');
    return new Response(Buffer.from(pixel, 'base64'));
  });
  assert.equal(download[1].headers.Authorization, undefined);
  assert.equal(result.ext, 'png');
  for (const [payload, re] of [
    [Response.json({ data: [{ url: 'https://other.invalid/image' }] }), /另一个来源/],
    [new Response('error', { status: 401 }), /401/],
    [new Response('{}', { headers: { 'content-length': '999999999' } }), /32 MB/],
    [Response.json({ data: [{ b64_json: Buffer.from('<html>').toString('base64') }] }), /图像/],
  ]) {
    let calls = 0;
    await assert.rejects(requestGeneration(model, imageInput, async () => { calls++; return payload; }), re);
    assert.equal(calls, 1);
  }
});
