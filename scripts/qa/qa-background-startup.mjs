import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { launchTestDesktop } from './fixtures/isolated-desktop.mjs';

const root = await mkdtemp(path.join(os.tmpdir(), 'pi-wallpaper-startup-'));
let app;
try {
  const desktop = await launchTestDesktop(root, path.join(root, 'profile'), 1080, 720);
  app = desktop.app;
  const { page } = desktop;
  const launch = page.getByRole('status', { name: '正在启动', exact: true });
  const readyComposer = page.locator('#root:not([inert]) .new-conversation-welcome');
  await readyComposer.waitFor();
  await mkdir('.qa/launch', { recursive: true });
  const jpeg = await page.evaluate(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 2048;
    canvas.height = 1536;
    const ctx = canvas.getContext('2d');
    const gradient = ctx.createLinearGradient(0, 0, canvas.width, canvas.height);
    gradient.addColorStop(0, 'red');
    gradient.addColorStop(1, 'blue');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/jpeg').split(',')[1];
  });
  // Hold the response after its first quarter, when Chromium knows the image size.
  await app.evaluate(({ protocol }, jpeg) => {
    const bytes = Buffer.from(jpeg, 'base64');
    const cut = Math.floor(bytes.length / 4);
    let finish, finishLate;
    const held = new Promise(resolve => { finish = resolve; });
    const late = new Promise(resolve => { finishLate = resolve; });
    globalThis.finishWallpaper = finish;
    globalThis.finishLateWallpaper = finishLate;
    protocol.unhandle('pi-media');
    protocol.handle('pi-media', request => new Response(new ReadableStream({
      async start(controller) {
        controller.enqueue(bytes.subarray(0, cut));
        await (request.url.endsWith('/slow.jpg') ? late : held);
        controller.enqueue(bytes.subarray(cut));
        controller.close();
      },
    }), { headers: { 'Content-Type': 'image/jpeg', 'Content-Length': String(bytes.length) } }));
  }, jpeg);
  await page.evaluate(() => {
    const prefs = JSON.parse(localStorage.getItem('pi-studio:preferences') || '{}');
    localStorage.setItem('pi-studio:preferences', JSON.stringify({ ...prefs, theme: 'dark', backgroundInsideVisibility: 50,
      backgroundMedia: { kind: 'image', url: 'pi-media://background/startup.jpg', name: 'startup.jpg', mime: 'image/jpeg', bytes: 65536 } }));
  });
  await page.reload({ waitUntil: 'domcontentloaded' });
  const layers = page.locator('.background-layer img, .window-wallpaper img');
  await page.waitForFunction(() => document.querySelector('.background-layer img')?.naturalWidth === 2048);
  assert.deepEqual(await layers.evaluateAll(images => images.map(img => [img.complete, getComputedStyle(img).visibility])), [[false, 'hidden'], [false, 'hidden']]);
  assert.equal(await launch.isVisible(), true);
  assert.equal((await launch.innerText()).trim(), '');
  assert.equal(await page.locator('#root').evaluate(root => root.inert), true);
  await launch.screenshot({ path: '.qa/launch/wallpaper-dark.png' });
  await app.evaluate(() => globalThis.finishWallpaper());
  await readyComposer.waitFor();
  await page.waitForFunction(() => {
    const images = [...document.querySelectorAll('.background-layer img, .window-wallpaper img')];
    return images.length === 2 && images.every(img => img.complete && img.naturalHeight === 1536 && getComputedStyle(img).visibility === 'visible');
  });
  const dragRegions = await page.evaluate(() => {
    const frame = document.querySelector('.app').getBoundingClientRect();
    const x = innerWidth / 2, y = innerHeight / 2;
    const points = [
      [x, frame.top - 1], [frame.left - 1, y], [frame.right + 1, y], [x, frame.bottom + 1],
    ];
    const edges = [...document.querySelectorAll('.wallpaper-drag-edge')];
    return {
      margins: points.map(([x, y]) => getComputedStyle(document.elementFromPoint(x, y)).getPropertyValue('app-region')),
      overlapsFrame: edges.some(edge => {
        const r = edge.getBoundingClientRect();
        return r.left < frame.right && r.right > frame.left && r.top < frame.bottom && r.bottom > frame.top;
      }),
    };
  });
  assert.deepEqual(dragRegions, { margins: ['drag', 'drag', 'drag', 'drag'], overlapsFrame: false });
  await page.locator('.sidebar-bottom button[title="设置"]').click();
  await page.locator('.settings-overlay').waitFor();
  assert.equal(await launch.count(), 0);

  await page.evaluate(() => {
    const prefs = JSON.parse(localStorage.getItem('pi-studio:preferences'));
    prefs.backgroundMedia.url = 'pi-media://background/slow.jpg';
    localStorage.setItem('pi-studio:preferences', JSON.stringify(prefs));
  });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.querySelector('.background-layer img')?.naturalWidth === 2048);
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(win => win.webContents.getURL().endsWith('/index.html'))
    .webContents.send('pi:open-settings'));
  assert.equal(await page.locator('.settings-overlay').count(), 0);
  assert.equal(await launch.getByRole('button').count(), 0);
  await page.locator('.settings-overlay').waitFor();
  assert.equal(await launch.count(), 0);
  await app.evaluate(() => globalThis.finishLateWallpaper());
  await page.waitForFunction(() => document.querySelector('.background-layer img')?.complete);

  // If the saved image is missing, its failure must release the launch screen.
  await app.evaluate(({ protocol }) => {
    protocol.unhandle('pi-media');
    protocol.handle('pi-media', () => new Response(null, { status: 404 }));
  });
  await page.evaluate(() => {
    const prefs = JSON.parse(localStorage.getItem('pi-studio:preferences'));
    prefs.backgroundMedia.url = 'pi-media://background/missing.jpg';
    localStorage.setItem('pi-studio:preferences', JSON.stringify(prefs));
  });
  await page.reload();
  await readyComposer.waitFor();
  assert.equal(await layers.count(), 0);
  console.log('Electron startup passed with no wallpaper, a partially delivered JPEG in both layers, and missing media. All four wallpaper margins accept window dragging.');
} finally {
  await app?.close();
  await rm(root, { recursive: true, force: true });
}
