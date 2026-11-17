import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ALL_FORMATS, BufferSource, Input } from 'mediabunny';
import { _electron } from 'playwright-core';

const root = fileURLToPath(new URL('../..', import.meta.url));
const profile = await mkdtemp(path.join(tmpdir(), 'studio-storyboard-film-'));
const workspace = path.join(profile, 'workspace');
const output = path.join(root, '.qa/video-storyboard');
await mkdir(workspace); await mkdir(output, { recursive: true });
const destination = path.join(output, '网页来源演示.mp4');
const env = { ...process.env, PI_WORKSPACE: workspace, PI_STUDIO_USER_DATA: profile, PI_STUDIO_DB: path.join(profile, 'qa.sqlite') };
delete env.ELECTRON_RUN_AS_NODE; delete env.PI_STUDIO_DEV;
let app;
try {
  app = await _electron.launch({ args: [root, '--disable-background-networking'], env });
  const page = await app.firstWindow();
  await app.evaluate(({ BrowserWindow, dialog }, { workspace, destination }) => {
    BrowserWindow.getAllWindows()[0].setSize(1440, 940);
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [workspace] });
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: destination });
  }, { workspace, destination });
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  page.setDefaultTimeout(20000);
  const button = name => page.getByRole('button', { name, exact: true });
  await button('打开右侧面板').click();
  await button('视频分镜').click();
  const choose = page.getByRole('region', { name: '视频分镜工作台' }).getByRole('button', { name: '选择工作区' });
  await choose.or(button('网页来源示例')).first().waitFor();
  if (await choose.isVisible()) await choose.click();
  const panel = page.getByRole('region', { name: '视频分镜工作台' });
  await button('网页来源示例').waitFor();
  await panel.screenshot({ path: path.join(output, 'welcome.png') });
  await button('网页来源示例').click();
  const splitter = page.getByRole('separator', { name: '调整右侧面板宽度' });
  await splitter.focus();
  for (let i = 0; i < 10; i++) await splitter.press('ArrowRight');
  const checkEdges = () => panel.evaluate(el => {
    const rect = el.getBoundingClientRect();
    const bar = el.querySelector('.story-toolbar').getBoundingClientRect();
    return { width: el.clientWidth, overflow: el.scrollWidth - el.clientWidth,
      asymmetry: Math.abs(bar.left - rect.left - (rect.left + el.clientWidth - bar.right)) };
  });
  await button('选择镜头 1').waitFor();
  const narrow = await checkEdges();
  assert(narrow.width <= 340 && narrow.overflow <= 1 && narrow.asymmetry <= 1, JSON.stringify(narrow));
  await panel.locator('.story-film-stage canvas').waitFor();
  await panel.locator('.story-film-loading').waitFor({ state: 'hidden' });
  assert.equal(await panel.locator('.story-film-unavailable').count(), 0);
  await panel.screenshot({ path: path.join(output, 'example-sidebar.png') });
  await button('全屏').click();
  const film = page.getByRole('region', { name: '整片预览' });
  await page.waitForFunction(() => document.querySelector('.story-workbench')?.clientWidth >= 1100);
  const wide = await checkEdges();
  assert(wide.width >= 1100 && wide.overflow <= 1 && wide.asymmetry <= 1, JSON.stringify(wide));
  await button('编辑下一镜').click();
  assert.equal(await button('选择镜头 2').getAttribute('aria-pressed'), 'true');
  await button('编辑上一镜').click();
  assert.equal(await button('选择镜头 1').getAttribute('aria-pressed'), 'true');
  await panel.locator('.story-film-loading').waitFor({ state: 'hidden' });
  await panel.evaluate(el => el.scrollTop = 0);
  await panel.screenshot({ path: path.join(output, 'example-editing.png') });
  await button('生成整片预览').click();
  await button('取消合成').click();
  await button('生成整片预览').click();
  const vid = film.locator('video');
  await Promise.race([
    vid.waitFor({ timeout: 180000 }),
    film.getByRole('alert').waitFor({ timeout: 180000 }).then(async () => { throw new Error(await film.getByRole('alert').innerText()); }),
  ]);
  await page.waitForFunction(() => document.querySelector('.story-film video')?.readyState >= 2);
  const properties = await vid.evaluate(el => [el.videoWidth, el.videoHeight, el.duration]);
  assert.deepEqual(properties.slice(0, 2), [1280, 720]);
  assert(Math.abs(properties[2] - 15) < .001, JSON.stringify(properties));
  await button('播放成片').click();
  await button('暂停成片').click();
  await button('成片静音').click();
  await button('开启成片声音').click();

  await button('跳到第 3 镜').click();
  const cut = await vid.evaluate(el => el.currentTime);
  assert(Math.abs(cut - 6.5) < 0.04);
  assert(await page.getByRole('checkbox', { name: '此镜使用 点击声.wav' }).isChecked());
  await button('导出 MP4').click();
  await film.getByRole('status').filter({ hasText: '已导出' }).waitFor();
  const bytes = await readFile(destination);
  const previewUrl = await vid.getAttribute('src');
  const previewHash = await app.evaluate(async ({ net }, url) => {
    const response = await net.fetch(url);
    const digest = await crypto.subtle.digest('SHA-256', await response.arrayBuffer());
    return Array.from(new Uint8Array(digest));
  }, previewUrl);
  assert.equal(Buffer.from(previewHash).toString('hex'), createHash('sha256').update(bytes).digest('hex'));
  const input = new Input({ formats: ALL_FORMATS, source: new BufferSource(bytes) });
  const picture = await input.getPrimaryVideoTrack(), sound = await input.getPrimaryAudioTrack();
  assert.equal(await picture.getCodec(), 'avc');
  assert.equal(await sound.getCodec(), 'aac');
  assert(Math.abs(await picture.computeDuration() - 15) < 0.001);
  assert(Math.abs(await sound.computeDuration() - 15) < .001);
  input.dispose();

  // Independently decode the saved movie, sample all four shots and locate the click in the mix.
  await page.evaluate(() => {
    const file = document.createElement('input'); file.type = 'file'; file.id = 'qa-film-file'; file.hidden = true; document.body.append(file);
  });
  await page.locator('#qa-film-file').setInputFiles(destination);
  const clickBytes = await readFile(path.join(root, 'assets/storyboard/web-sources/click.wav'));
  const decoded = await page.evaluate(async clickBytes => {
    const file = document.querySelector('#qa-film-file').files[0];
    const url = URL.createObjectURL(file);
    const movie = document.createElement('video');
    movie.muted = true; movie.src = url;
    await new Promise((resolve, reject) => { movie.onloadeddata = resolve; movie.onerror = reject; });
    const ctx = new AudioContext({ sampleRate: 48000 });
    const audio = await ctx.decodeAudioData(await file.arrayBuffer());
    const signal = audio.getChannelData(0);
    const click = (await ctx.decodeAudioData(new Uint8Array(clickBytes).buffer)).getChannelData(0);
    let best = -Infinity, clickTime = 0;
    for (let n = Math.round(8.85 * 48000); n < 9.05 * 48000; n++) {
      let correlation = 0;
      for (let i = 0; i < 480; i++) correlation += signal[n + i] * click[i];
      if (correlation > best) { best = correlation; clickTime = n / 48000; }
    }
    const rms = [0.5, 3.8, 7.4, 11.3].map(time => {
      const block = signal.subarray(time * 48000, time * 48000 + 24000);
      return Math.sqrt(block.reduce((sum, n) => sum + n * n, 0) / block.length);
    });
    const canvas = document.createElement('canvas'); canvas.width = 40; canvas.height = 24;
    const draw = canvas.getContext('2d', { willReadFrequently: true });
    const signatures = [];
    const contact = document.createElement('canvas'); contact.width = 896; contact.height = 504;
    const frames = contact.getContext('2d');
    const seek = (player, t) => new Promise(resolve => { player.onseeked = resolve; player.currentTime = t; });
    function sample(player) {
      draw.drawImage(player, 0, 0, 40, 24);
      const pixels = draw.getImageData(0, 0, 40, 24).data;
      return pixels.reduce((sum, n, i) => sum + (i % 4 === 3 ? 0 : n * (i % 33 + 1)), 0);
    }
    for (const [index, t] of [.7, 4.8, 9.04, 12.6, 14.99].entries()) {
      await seek(movie, t);
      const signature = sample(movie);
      signatures.push(signature);
      if (index < 4) frames.drawImage(movie, (index % 2) * 448, Math.floor(index / 2) * 252, 448, 252);
    }
    await movie.play(); movie.pause();
    await ctx.close(); URL.revokeObjectURL(url); document.querySelector('#qa-film-file').remove();
    return { rms, signatures, clickTime, contact: contact.toDataURL('image/jpeg').split(',')[1] };
  }, Array.from(clickBytes));
  await writeFile(path.join(output, 'film-frames.jpg'), Buffer.from(decoded.contact, 'base64'));
  assert(decoded.rms.every(n => n > .002), JSON.stringify(decoded.rms));
  assert(Math.abs(decoded.clickTime - 8.95) < .01, 'click time ' + decoded.clickTime);
  assert.equal(new Set(decoded.signatures).size, 5);
  await vid.evaluate(async el => { el.pause(); await new Promise(resolve => { el.onseeked = resolve; el.currentTime = 8.95; }); });
  await film.screenshot({ path: path.join(output, 'film-preview.png') });
  await panel.evaluate(el => el.scrollTo(0, 0));
  await panel.screenshot({ path: path.join(output, 'example-workbench-light.png') });
  await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
  await panel.screenshot({ path: path.join(output, 'example-workbench-dark.png') });
  await page.getByLabel('字幕', { exact: true }).fill('试试新的字幕');
  await panel.getByRole('button', { name: /^全部素材/ }).click();
  await page.getByRole('checkbox', { name: '此镜使用 点击声.wav' }).uncheck();
  await button('更新预览').waitFor();
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ properties, bytes: bytes.length, rms: decoded.rms, clickTime: decoded.clickTime, frames: decoded.signatures }));
} finally {
  await app?.close();
  await rm(profile, { recursive: true, force: true });
}
