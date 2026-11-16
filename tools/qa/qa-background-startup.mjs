import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { launchTestDesktop } from './fixtures/isolated-desktop.mjs';

const root = await mkdtemp(path.join(os.tmpdir(), 'pi-wallpaper-startup-'));
let app;
try {
  const desktop = await launchTestDesktop(root, path.join(root, 'profile'), 1080, 720);
  app = desktop.app;
  const { page } = desktop;
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
    let finish;
    const held = new Promise(resolve => { finish = resolve; });
    globalThis.finishWallpaper = finish;
    protocol.unhandle('pi-media');
    protocol.handle('pi-media', () => new Response(new ReadableStream({
      async start(controller) {
        controller.enqueue(bytes.subarray(0, cut));
        await held;
        controller.enqueue(bytes.subarray(cut));
        controller.close();
      },
    }), { headers: { 'Content-Type': 'image/jpeg', 'Content-Length': String(bytes.length) } }));
  }, jpeg);
  await page.evaluate(() => {
    const prefs = JSON.parse(localStorage.getItem('pi-studio:preferences') || '{}');
    localStorage.setItem('pi-studio:preferences', JSON.stringify({ ...prefs, backgroundInsideVisibility: 50,
      backgroundMedia: { kind: 'image', url: 'pi-media://background/startup.jpg', name: 'startup.jpg', mime: 'image/jpeg', bytes: 65536 } }));
  });
  await page.reload({ waitUntil: 'domcontentloaded' });
  const layers = page.locator('.background-layer img, .window-wallpaper img');
  await page.waitForFunction(() => document.querySelector('.background-layer img')?.naturalWidth === 2048);
  assert.deepEqual(await layers.evaluateAll(images => images.map(img => [img.complete, getComputedStyle(img).visibility])), [[false, 'hidden'], [false, 'hidden']]);
  await page.locator('.sidebar-bottom button[title="设置"]').click();
  await page.locator('.settings-overlay').waitFor();
  await app.evaluate(() => globalThis.finishWallpaper());
  await page.waitForFunction(() => {
    const images = [...document.querySelectorAll('.background-layer img, .window-wallpaper img')];
    return images.length === 2 && images.every(img => img.complete && img.naturalHeight === 1536 && getComputedStyle(img).visibility === 'visible');
  });
  console.log('Both wallpaper layers stay hidden during a partial JPEG response and appear complete. The window remains interactive.');
} finally {
  await app?.close();
  await rm(root, { recursive: true, force: true });
}
