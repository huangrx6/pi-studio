import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ALL_FORMATS, BufferSource, Input } from 'mediabunny';
import { launchTestDesktop } from './fixtures/isolated-desktop.mjs';

const profile = await mkdtemp(path.join(tmpdir(), 'studio-director-qa-'));
const workspace = path.join(profile, 'workspace');
const output = path.join(profile, '网页来源.mp4');
await mkdir(workspace);
const requests = [];
const failures = [];
const server = createServer(async (req, res) => {
  try {
    assert.equal(req.url, '/v1/chat/completions');
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks));
    assert.equal(body.model, 'director');
    const system = body.messages.find(m => m.role === 'system' || m.role === 'developer');
    assert(JSON.stringify(system.content).includes('# 分镜导演'));
    const content = body.messages.findLast(m => m.role === 'user').content;
    const brief = JSON.parse(content.find(b => b.type === 'text').text);
    assert.equal(content.filter(b => b.type === 'image_url' && b.image_url.url.startsWith('data:image/jpeg;base64,')).length, 4);
    assert(brief.discussion.length && brief.plan.summary.includes('查看原文'));
    requests.push({ scope: brief.scope, target: brief.selectedShotId, instruction: brief.instruction });
    // Keep the fixture independent of generated UUIDs. New captions and camera moves must reach the exporter.
    const shots = brief.scope === 'plan'
      ? brief.shots.map((s, i) => ({ sourceShotId: s.id, purpose: ['从一份回答开始', '找到旧版来源条', '打开地球按钮', '读到原文'][i],
        motion: i === 2 ? '光标停在地球按钮后点击' : '保持画面可读',
        composition: { camera: i === 3 ? 'pull' : 'push' }, assetIds: s.assetIds,
        captions: s.captions.map(c => ({ ...c, text: ['从回答开始。', '来源曾排在末尾。', '点击地球按钮。', '打开来源，阅读原文。'][i] })) }))
      : [{ sourceShotId: brief.selectedShotId, durationMs: 4500, composition: { camera: 'still' } }];
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const event = (delta, finish_reason = null) => res.write('data: ' + JSON.stringify({
      id: 'qa-director', model: body.model, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000),
      choices: [{ index: 0, delta, finish_reason }],
    }) + '\n\n');
    event({ role: 'assistant', content: JSON.stringify({ shots }) });
    event({}, 'stop');
    res.end('data: [DONE]\n\n');
  } catch (error) {
    failures.push(error);
    res.writeHead(400, { 'Content-Type': 'application/json' }).end('{"error":{"message":"Invalid QA request"}}');
  }
});
let app;
try {
  await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
  const desktop = await launchTestDesktop(workspace, profile, 1380, 900);
  app = desktop.app;
  const page = desktop.page;
  await app.evaluate(({ dialog }, { workspace, output }) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [workspace] });
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: output });
  }, { workspace, output });
  await page.evaluate(async ({ cwd, baseUrl }) => {
    const api = window.piApi, providerId = 'qa-storyboard';
    await api.addProvider({ cwd, providerId, name: '分镜验收', api: 'openai-completions', baseUrl, apiKey: 'loopback-test-only' });
    await api.addCustomModel({ cwd, providerId, modelId: 'director', name: '分镜测试模型', supportsImages: true, contextWindow: 64000, maxTokens: 8192 });
    await api.setEnabledModels({ cwd, models: [providerId + '/director'] });
    await api.setDefaultModel(providerId + '/director', cwd);
  }, { cwd: workspace, baseUrl: 'http://127.0.0.1:' + server.address().port + '/v1' });
  const button = (name, container = page) => container.getByRole('button', { name, exact: true });
  page.on('pageerror', error => failures.push(error));
  await button('打开右侧面板').click();
  await button('视频分镜').click();
  const panel = page.getByRole('region', { name: '视频分镜工作台' });
  const choose = button('选择工作区', panel);
  await choose.or(button('网页来源示例')).first().waitFor();
  if (await choose.isVisible()) await choose.click();
  await button('网页来源示例').click();
  await button('全屏').click();
  const read = () => page.evaluate(async cwd => {
    const [work] = await window.piApi.storyboardList(cwd);
    return (await window.piApi.storyboardRead(cwd, work.id)).document;
  }, workspace);
  const original = await read();
  const dialog = page.getByRole('dialog');
  async function waitForPreview(label) {
    await Promise.race([button(label, dialog).waitFor(),
      dialog.getByRole('alert').waitFor().then(async () => { throw failures[0] ?? Error(await dialog.getByRole('alert').innerText()); })]);
  }
  await button('AI 生成整套分镜').click();
  await dialog.getByLabel('补充分镜要求（选填）').fill('用代码动效把从旧来源条到新弹框的变化讲清楚');
  await button('分镜文本模型', dialog).click();
  await page.getByRole('option', { name: /分镜测试模型/ }).click();
  await button('生成分镜建议', dialog).click();
  await waitForPreview('应用整套分镜');
  assert.deepEqual(await read(), original);
  await button('预览建议镜头 3', dialog).click();
  await button('应用整套分镜', dialog).click();
  await dialog.waitFor({ state: 'hidden' });
  const whole = await read();
  assert.deepEqual(whole.shots.map(s => s.purpose), ['从一份回答开始', '找到旧版来源条', '打开地球按钮', '读到原文']);
  assert.deepEqual(whole.tracks, original.tracks);
  await button('选择镜头 3').click();
  const change = '只让本镜停稳，时长改为 4.5 秒';
  for (const adopt of [false, true]) {
    await button('AI 改这一镜').click();
    await dialog.getByLabel('修改要求').fill(change);
    await button('生成修改建议', dialog).click();
    await waitForPreview('应用这一镜');
    assert.deepEqual(await read(), whole);
    await button(adopt ? '应用这一镜' : '放弃建议', dialog).click();
    await dialog.waitFor({ state: 'hidden' });
  }
  const final = await read();
  const expected = structuredClone(whole.shots);
  expected[2].durationMs = 4500;
  expected[2].composition.camera = 'still';
  assert.deepEqual(final.shots, expected);
  assert.deepEqual(final.tracks, original.tracks);
  assert.deepEqual(requests.map(r => r.scope), ['plan', 'shot', 'shot']);
  assert(requests.slice(1).every(r => r.target === expected[2].id && r.instruction === change));
  await button('导出 MP4').click();
  const film = panel.getByRole('region', { name: '整片预览' });
  await Promise.race([film.getByRole('status').filter({ hasText: '已导出' }).waitFor({ timeout: 180000 }),
    film.getByRole('alert').waitFor({ timeout: 180000 }).then(async () => { throw Error(await film.getByRole('alert').innerText()); })]);
  const bytes = await readFile(output);
  const mp4 = new Input({ formats: ALL_FORMATS, source: new BufferSource(bytes) });
  try {
    const video = await mp4.getPrimaryVideoTrack(), audio = await mp4.getPrimaryAudioTrack();
    assert.equal(await video.getCodec(), 'avc');
    assert.equal(await audio.getCodec(), 'aac');
    assert(Math.abs(await video.computeDuration() - 15.5) < .001);
  } finally { mp4.dispose(); }
  assert.deepEqual(failures, []);
  console.log(`Verified approval, discard, scoped revision, intact audio tracks and 15.5 s H.264/AAC MP4 (${bytes.length} bytes), with three local text-model requests and no image-generation calls.`);
} finally {
  await app?.close();
  await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
  await rm(profile, { recursive: true, force: true });
}
