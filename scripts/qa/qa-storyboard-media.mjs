import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ALL_FORMATS, BufferSource, Input } from 'mediabunny';
import { _electron } from 'playwright-core';

const root = fileURLToPath(new URL('../..', import.meta.url));
const profile = await mkdtemp(path.join(tmpdir(), 'studio-media-models-'));
const workspace = path.join(profile, 'workspace');
await mkdir(workspace);
const output = path.join(profile, 'export.mp4');
const example = path.join(root, 'assets/storyboard/web-sources');
const narration = await readFile(path.join(example, 'voice-4.m4a'));
const picture = await readFile(path.join(example, 'dialog.png'));
const requests = [];
const server = createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  requests.push({ route: req.url, body });
  if (req.url === '/v1/audio/speech') {
    res.writeHead(200, { 'Content-Type': 'audio/mp4' });
    res.end(narration);
  } else if (req.url === '/v1/images/generations') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ data: [{ b64_json: picture.toString('base64') }] }));
  } else { res.writeHead(404); res.end(); }
});
let app;
try {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const env = { ...process.env, PI_WORKSPACE: workspace, PI_STUDIO_USER_DATA: profile, PI_STUDIO_DB: path.join(profile, 'qa.sqlite') };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.PI_STUDIO_DEV;
  app = await _electron.launch({ args: [root, '--disable-background-networking'], env });
  const page = await app.firstWindow();
  await app.evaluate(({ BrowserWindow, dialog }, { workspace, output }) => {
    BrowserWindow.getAllWindows()[0].setSize(1440, 940);
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [workspace] });
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: output });
  }, { workspace, output });
  const errors = [];
  page.on('pageerror', error => errors.push(String(error)));
  const button = (name, scope = page) => scope.getByRole('button', { name, exact: true });
  await button('打开右侧面板').click();
  await button('视频分镜').click();
  const panel = page.getByRole('region', { name: '视频分镜工作台' });
  const choose = button('选择工作区', panel);
  await choose.or(button('网页来源示例')).first().waitFor();
  if (await choose.isVisible()) await choose.click();
  await button('网页来源示例').click();
  await button('全屏').click();
  await button('模型配音').click();
  await button('配置模型').click();
  await button('添加模型来源').first().click();
  const dialog = page.getByRole('dialog', { name: '添加模型来源' });
  await dialog.getByLabel('来源 ID', { exact: true }).fill('qa-video');
  await dialog.getByLabel('显示名称', { exact: true }).fill('制作模型测试');
  await dialog.getByLabel('服务地址', { exact: true }).fill('http://127.0.0.1:' + server.address().port + '/v1');
  await dialog.getByLabel('语音合成模型 ID').fill('studio-voice');
  await dialog.getByLabel('图像生成模型 ID').fill('studio-image');
  await button('添加', dialog).click();
  await dialog.waitFor({ state: 'hidden' });
  await page.locator('.settings-back-button').click();
  const select = async (label, option) => {
    await button(label).click();
    await page.getByRole('option', { name: option }).click();
  };
  await select('本作品语音模型', /studio-voice/);
  await page.getByLabel('本作品旁白音色').fill('warm');
  await page.getByLabel('旁白文稿').fill('查看本镜采用的旁白。');
  const readWork = () => page.evaluate(async workspace => {
    const [first] = await window.piApi.storyboardList(workspace);
    return window.piApi.storyboardRead(workspace, first.id);
  }, workspace);
  const original = await readWork();
  const before = original.document.tracks.find(track => track.role === 'narration').clips[0];
  await button('生成旁白').click();
  const sound = panel.getByRole('region', { name: '候选旁白' });
  await sound.locator('audio').evaluate(async el => { await el.play(); el.pause(); });
  assert((await readWork()).document.tracks.some(track => track.clips.some(c => c.assetId === before.assetId)));
  await button('采用到本镜', sound).click();
  await button('本镜已采用', sound).waitFor();
  const sounded = await readWork();
  const generatedAudio = sounded.document.assets.find(asset => asset.generated?.kind === 'speech');
  assert.equal(sounded.document.tracks.find(track => track.role === 'narration').clips.find(c => c.shotId === before.shotId).assetId, generatedAudio.id);
  assert.equal(sounded.document.shots[0].durationMs, Math.max(original.document.shots[0].durationMs, before.offsetMs + generatedAudio.generated.durationMs));
  await button('模型生图').click();
  await select('本作品图像模型', /studio-image/);
  await page.getByLabel('画面描述').fill('一张展开的来源卡片');
  await button('生成画面').click();
  const image = panel.getByRole('region', { name: '候选画面' });
  await image.locator('img').evaluate(el => el.decode());
  const candidate = await readWork();
  assert.equal(candidate.document.renderRevision, sounded.document.renderRevision);
  assert.deepEqual(candidate.document.shots[0].assetIds, original.document.shots[0].assetIds);
  await button('采用到本镜', image).click();
  await button('本镜已采用', image).waitFor();
  const adopted = await readWork();
  assert.equal(adopted.document.shots[0].assetIds[0], adopted.document.assets.find(asset => asset.generated?.kind === 'image').id);
  assert.equal(adopted.document.mediaPreferences.speech.voice, 'warm');
  assert.equal(adopted.document.mediaPreferences.image.modelId, 'studio-image');
  assert.deepEqual(requests.map(r => [r.route, r.body.model]), [['/v1/audio/speech', 'studio-voice'], ['/v1/images/generations', 'studio-image']]);
  assert.equal(requests[0].body.voice, 'warm');
  await button('导出 MP4').click();
  const film = panel.getByRole('region', { name: '整片预览' });
  await film.getByRole('status').filter({ hasText: '已导出' }).waitFor({ timeout: 180000 });
  assert.equal(requests.length, 2);
  const mp4 = new Input({ formats: ALL_FORMATS, source: new BufferSource(await readFile(output)) });
  try {
    assert.equal(await (await mp4.getPrimaryAudioTrack()).getCodec(), 'aac');
    assert.equal(await (await mp4.getPrimaryVideoTrack()).getCodec(), 'avc');
  } finally { mp4.dispose(); }
  assert.deepEqual(errors, []);
  console.log('Verified model setup, candidate audition and image preview, per-shot adoption, and MP4 export with two local generation calls.');
} finally {
  await app?.close();
  await new Promise(resolve => server.close(resolve));
  await rm(profile, { recursive: true, force: true });
}
