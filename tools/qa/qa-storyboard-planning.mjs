import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ALL_FORMATS, BufferSource, Input } from 'mediabunny';
import { configureTestModel, launchTestDesktop } from './fixtures/isolated-desktop.mjs';

const profile = await mkdtemp(path.join(tmpdir(), 'studio-planning-qa-'));
const workspace = path.join(profile, 'workspace');
const videoFile = path.join(profile, '网页来源竖版.mp4');
await mkdir(workspace);
const manuscript = path.join(workspace, '网页来源操作稿.md');
await writeFile(manuscript, '回答底部的地球按钮可以展开网页来源列表，点击网站名称打开原文。');
const direction = { title: '跟着光标看来源', beats: ['在回答底部找到地球', '打开来源列表', '点开网站原文'] };
const alternative = { title: '先看打开的原文', beats: ['展示原文', '倒回入口'] };
const requests = [], errors = [];
function suggest(brief) {
  const { reply, current } = brief;
  assert(brief.assets.some(asset => asset.excerpt?.includes('点击网站名称打开原文')));
  if (reply.action === 'start') return { kind: 'question', question: '这条演示主要给谁看？', reason: '文稿里已有操作顺序，还需要确定观众。' };
  if (reply.action === 'answer' && current.kind === 'question') {
    assert.equal(reply.text, '第一次用 Studio 的人，配一句真人开场。');
    return { kind: 'direction', question: '想怎样带新用户找到来源？', reason: '第一次使用时可以正向演示，也可以从结果倒推。', options: [direction, alternative] };
  }
  if (reply.action === 'choose') {
    assert.equal(reply.choice.title, direction.title);
    return { kind: 'materials', question: '有开场的人声录音吗？', reason: '你希望真人开场，现有素材只有操作稿。',
      direction: { ...direction, need: { label: '真人开场录音', kinds: ['audio'], count: 1 } } };
  }
  const revised = reply.action === 'answer' && current.kind === 'review';
  assert(revised || reply.action === 'defer');
  const beats = revised ? [...direction.beats, '停留在来源标题'] : direction.beats;
  return { kind: 'review', question: revised ? '可以按这四个镜头制作吗？' : '这样带新用户看来源可以吗？',
    reason: '用已有文稿设计画面，原声可以后补。', direction: { ...direction, beats },
    aspect: '9:16', assetIds: brief.assets.map(asset => asset.id), deferred: '真人开场录音' };
}

const model = createServer(async (req, res) => {
  try {
    assert.equal(req.url, '/v1/chat/completions');
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const { messages, model } = JSON.parse(Buffer.concat(chunks));
    assert.equal(model, 'check');
    const content = messages.findLast(message => message.role === 'user').content;
    const brief = JSON.parse(typeof content === 'string' ? content : content.find(part => part.type === 'text').text);
    requests.push(brief);
    let result;
    if (brief.task === 'plan-next') result = suggest(brief);
    else {
      assert.equal(brief.scope, 'plan');
      assert.equal(brief.plan.brief.aspect, '9:16');
      assert(brief.discussion.some(turn => turn.reply.includes('结尾多停一镜')));
      assert.equal(brief.plan.deferred, '真人开场录音');
      result = { shots: brief.shots.map((shot, i) => ({ sourceShotId: shot.id, purpose: '演示镜头 ' + (i + 1),
        captions: [{ startMs: 0, endMs: 3000, text: brief.plan.direction.beats[i] }] })) };
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const send = (delta, finish_reason) => res.write('data: ' + JSON.stringify({
      id: 'story-planning', model, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000),
      choices: [{ index: 0, delta, finish_reason }],
    }) + '\n\n');
    send({ role: 'assistant', content: JSON.stringify(result) }, null);
    send({}, 'stop');
    res.end('data: [DONE]\n\n');
  } catch (error) {
    errors.push(error);
    res.writeHead(400).end('Invalid test request');
  }
});
let app;
try {
  await new Promise((resolve, reject) => model.once('error', reject).listen(0, '127.0.0.1', resolve));
  const desktop = await launchTestDesktop(workspace, profile, 1440, 960);
  app = desktop.app;
  const page = desktop.page;
  page.on('pageerror', error => errors.push(error));
  await app.evaluate(({ dialog }, { workspace, manuscript, videoFile }) => {
    dialog.showOpenDialog = async (...args) => ({ canceled: false,
      filePaths: [args.at(-1).properties.includes('openDirectory') ? workspace : manuscript] });
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: videoFile });
  }, { workspace, manuscript, videoFile });
  await configureTestModel(page, workspace, 'http://127.0.0.1:' + model.address().port + '/v1');
  const button = name => page.getByRole('button', { name, exact: true });
  const read = () => page.evaluate(async cwd => {
    const [work] = await window.piApi.storyboardList(cwd);
    return (await window.piApi.storyboardRead(cwd, work.id)).document;
  }, workspace);
  await button('打开右侧面板').click();
  await button('视频分镜').click();
  await button('选择工作区').or(button('新建作品')).first().waitFor();
  if (await button('选择工作区').isVisible()) await button('选择工作区').click();
  await button('新建作品').click();
  await button('全屏').click();
  await page.getByLabel('片名', { exact: true }).fill('网页来源 · 入门演示');
  await page.getByLabel('你想拍一支怎样的视频？', { exact: true }).fill('录一支竖屏 9:16 演示，教人怎么打开网页来源');
  await button('选择或拖入素材 图片、视频、音频或文稿').click();
  await page.getByText('网页来源操作稿.md', { exact: true }).first().waitFor();
  await button('和 AI 讨论').click();
  await page.getByLabel('你的想法', { exact: true }).fill('第一次用 Studio 的人，配一句真人开场。');
  await button('发送回答').click();
  await page.getByRole('button', { name: /^跟着光标看来源/ }).click();
  await button('记为待补').click();
  await button('确认方案并生成分镜').waitFor();
  assert.equal((await read()).plans.length, 0);
  await page.getByText('我想调整方案', { exact: true }).click();
  await page.getByLabel('修改方案的要求').fill('结尾多停一镜，让大家看清来源标题。');
  await button('请 AI 调整方案').click();
  await page.getByRole('heading', { name: '可以按这四个镜头制作吗？' }).waitFor();
  await page.locator('.story-review dd').filter({ hasText: /^9:16$/ }).waitFor();
  assert.equal((await read()).shots.length, 0);
  assert(requests.every(brief => brief.task === 'plan-next'));
  await button('确认方案并生成分镜').click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: '应用整套分镜' }).waitFor();
  const before = await read();
  assert.equal(before.plans.length, 1);
  assert.equal(before.shots.length, 4);
  assert(before.shots.every(shot => !shot.purpose.startsWith('演示镜头 ')));
  await button('应用整套分镜').click();
  await dialog.waitFor({ state: 'hidden' });
  assert.deepEqual((await read()).shots.map(shot => shot.purpose), ['演示镜头 1', '演示镜头 2', '演示镜头 3', '演示镜头 4']);
  assert.deepEqual(requests.map(brief => brief.reply?.action ?? brief.scope), ['start', 'answer', 'choose', 'defer', 'answer', 'plan']);
  await button('导出 MP4').click();
  const film = page.getByRole('region', { name: '整片预览' });
  const alert = film.getByRole('alert');
  await film.getByRole('status').filter({ hasText: '已导出' }).or(alert).first().waitFor({ timeout: 180000 });
  if (await alert.isVisible()) throw Error(await alert.innerText());
  const mp4 = new Input({ formats: ALL_FORMATS, source: new BufferSource(await readFile(videoFile)) });
  try {
    const video = await mp4.getPrimaryVideoTrack();
    assert.equal(await video.getCodedWidth(), 720);
    assert.equal(await video.getCodedHeight(), 1280);
  } finally { mp4.dispose(); }
  assert.deepEqual(errors, []);
  console.log('Verified questions, directions, missing audio, revised review, one confirmation-triggered full storyboard and a 720×1280 MP4 in Electron.');
} catch (error) {
  throw errors[0] ?? error;
} finally {
  await app?.close();
  await new Promise(resolve => { model.close(resolve); model.closeAllConnections(); });
  await rm(profile, { recursive: true, force: true });
}
