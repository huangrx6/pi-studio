/**
 * Background appearance QA.
 *
 * Run `pnpm web` in one terminal and `node scripts/qa-background.mjs` in another.
 * The script mocks the Pi IPC API, serves fixture media through the same
 * pi-media:// URL shape used by Electron, and verifies static/video backgrounds,
 * opacity changes, persistence, removal, and responsive settings layout.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { chromium } from 'playwright-core';

const output = new URL('../screenshots/background/', import.meta.url).pathname;
await fs.mkdir(output, { recursive: true });

const browser = await chromium.launch({
  executablePath: process.env.CHROME_BIN || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
});

// Generate a tiny animated WebM fixture with the browser itself so this check has
// no binary fixture dependency.
const mediaPage = await browser.newPage();
const motionWebm = await mediaPage.evaluate(async () => {
  const canvas = document.createElement('canvas');
  canvas.width = 320;
  canvas.height = 180;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Canvas 2D unavailable');
  let frame = 0;
  const draw = () => {
    const gradient = context.createLinearGradient(0, 0, canvas.width, canvas.height);
    gradient.addColorStop(0, '#b7ef5b');
    gradient.addColorStop(0.5, '#f5faee');
    gradient.addColorStop(1, '#42e73c');
    context.fillStyle = gradient;
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = '#202020';
    context.beginPath();
    context.arc(60 + (frame % 200), 90, 28, 0, Math.PI * 2);
    context.fill();
    frame += 4;
  };
  draw();
  const timer = setInterval(draw, 50);
  const stream = canvas.captureStream(20);
  const recorder = new MediaRecorder(stream, { mimeType: 'video/webm;codecs=vp8' });
  const chunks = [];
  recorder.ondataavailable = (event) => { if (event.data.size) chunks.push(event.data); };
  const stopped = new Promise((resolve) => { recorder.onstop = resolve; });
  recorder.start();
  await new Promise((resolve) => setTimeout(resolve, 450));
  recorder.stop();
  clearInterval(timer);
  await stopped;
  stream.getTracks().forEach((track) => track.stop());
  const bytes = new Uint8Array(await new Blob(chunks, { type: 'video/webm' }).arrayBuffer());
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
});
await mediaPage.close();

const page = await browser.newPage({ viewport: { width: 1440, height: 920 }, deviceScaleFactor: 2 });
page.setDefaultTimeout(12000);
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));

await page.route('pi-media://background/preview.webp', (route) => route.fulfill({
  status: 200,
  contentType: 'image/svg+xml',
  body: '<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="1000"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#dff3bd"/><stop offset=".48" stop-color="#f8faf4"/><stop offset="1" stop-color="#a3e635"/></linearGradient></defs><rect width="1600" height="1000" fill="url(#g)"/><circle cx="1240" cy="210" r="240" fill="#ffffff" opacity=".5"/><path d="M0 760 Q420 590 830 760 T1600 720 V1000 H0Z" fill="#1b2112" opacity=".14"/></svg>',
}));
await page.route('pi-media://background/motion.webm', (route) => route.fulfill({
  status: 200,
  contentType: 'video/webm',
  body: Buffer.from(motionWebm, 'base64'),
}));

await page.addInitScript(() => {
  const cwd = '/workspace/pi-studio';
  const model = {
    modelRef: 'opencode-go/deepseek-v4.1-flash',
    label: 'DeepSeek V4.1 Flash',
    thinkingLevel: 'high',
    thinkingLevels: ['default', 'low', 'high', 'max'],
    effectiveThinkingLevel: 'high',
    defaultThinkingLevel: 'high',
  };
  const workspaces = [{ cwd, name: 'pi-studio', sessions: [] }];
  const settings = {
    model,
    providers: [],
    customModels: [],
    enabledModels: [model.modelRef],
    mcp: [],
    skills: [],
    extensions: [],
    packages: [],
    authPath: '/demo/auth.json',
    mcpPath: '/demo/mcp.json',
    modelsPath: '/demo/models.json',
  };
  window.__removedBackgrounds = [];
  window.__nextBackground = null;
  const api = {
    setTheme: async (theme) => { window.__nativeTheme = theme; },
    modeGet: async () => ({ available: false, mode: 'smart' }),
    state: async () => ({ workspaces, cwd, model }),
    settings: async () => settings,
    models: async () => ({ models: [{ ...model, id: model.modelRef, provider: 'opencode-go', providerName: 'OpenCode Go', model: 'deepseek-v4.1-flash', name: model.label }], current: model.modelRef, enabled: [model.modelRef], selection: model, defaultSelection: model }),
    chooseBackgroundMedia: async () => window.__nextBackground,
    removeBackgroundMedia: async (url) => {
      window.__removedBackgrounds.push(url);
      return { removed: true };
    },
    composerResources: async () => ({ commands: [] }),
    extensionState: async () => ({ statuses: [], footer: '' }),
    files: async () => ({ path: '', entries: [] }),
  };
  window.piApi = new Proxy(api, {
    get(target, key) {
      if (key in target) return target[key];
      if (String(key).startsWith('on')) return () => () => {};
      return async () => undefined;
    },
  });
});

async function openGeneralSettings() {
  if (!await page.locator('.settings-overlay').count()) await page.locator('.bottom-row').click();
  await page.getByRole('button', { name: '通用', exact: true }).click();
  await page.getByRole('heading', { name: '背景与动态氛围', exact: true }).waitFor();
}

async function assertNoHorizontalOverflow() {
  const overflow = await page.locator('.settings-content, .background-settings-card, .background-settings-layout')
    .evaluateAll((elements) => elements
      .filter((element) => element.clientWidth && element.scrollWidth > element.clientWidth + 2)
      .map((element) => element.className));
  assert.deepEqual(overflow, []);
}

try {
  await page.goto(process.env.PREVIEW_URL || 'http://127.0.0.1:5180/');
  await page.locator('.bottom-row').waitFor();
  await openGeneralSettings();
  await page.getByRole('heading', { name: '背景与动态氛围', exact: true }).scrollIntoViewIfNeeded();
  assert.equal(await page.locator('#background-opacity').isDisabled(), true);
  await page.screenshot({ path: `${output}light-empty.png`, animations: 'disabled' });

  await page.evaluate(() => {
    window.__nextBackground = {
      kind: 'image',
      url: 'pi-media://background/preview.webp',
      name: 'Soft meadow.webp',
      mime: 'image/webp',
      bytes: 824_000,
    };
  });
  await page.getByRole('button', { name: '选择媒体', exact: true }).click();
  await page.locator('.app.has-custom-background .background-layer img').waitFor();
  await page.waitForFunction(() => {
    const image = document.querySelector('.background-layer img');
    return image instanceof HTMLImageElement && image.complete && image.naturalWidth > 0;
  });

  await page.locator('#background-opacity').fill('32');
  await page.waitForFunction(() => {
    const media = document.querySelector('.background-layer-media');
    return media && Math.abs(Number(getComputedStyle(media).opacity) - 0.32) < 0.01;
  });
  await assertNoHorizontalOverflow();
  await page.screenshot({ path: `${output}light-image.png`, animations: 'disabled' });

  await page.getByRole('button', { name: '返回对话' }).click();
  await page.locator('.settings-overlay').waitFor({ state: 'detached' });
  await page.locator('.app.has-custom-background .background-layer img').waitFor();
  await page.screenshot({ path: `${output}light-workspace.png`, animations: 'disabled' });

  await openGeneralSettings();
  await page.getByRole('button', { name: '深色', exact: true }).click();
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark');
  await page.screenshot({ path: `${output}dark-image.png`, animations: 'disabled' });

  await page.setViewportSize({ width: 900, height: 700 });
  await assertNoHorizontalOverflow();
  await page.screenshot({ path: `${output}dark-compact.png`, animations: 'disabled' });
  await page.setViewportSize({ width: 1440, height: 920 });

  await page.evaluate(() => {
    window.__nextBackground = {
      kind: 'video',
      url: 'pi-media://background/motion.webm',
      name: 'Motion loop.webm',
      mime: 'video/webm',
      bytes: 42_800,
    };
  });
  await page.getByRole('button', { name: '更换媒体', exact: true }).click();
  const video = page.locator('.background-layer video');
  await video.waitFor();
  await page.waitForFunction(() => {
    const element = document.querySelector('.background-layer video');
    return element instanceof HTMLVideoElement && element.readyState >= 1;
  });
  assert.deepEqual(await video.evaluate((element) => ({
    autoplay: element.autoplay,
    loop: element.loop,
    muted: element.muted,
    paused: element.paused,
  })), { autoplay: true, loop: true, muted: true, paused: false });
  await page.screenshot({ path: `${output}dark-video.png`, animations: 'disabled' });

  await page.reload();
  await page.locator('.app.has-custom-background .background-layer video').waitFor();
  await page.waitForFunction(() => {
    const element = document.querySelector('.background-layer video');
    return element instanceof HTMLVideoElement && element.readyState >= 1;
  });

  await openGeneralSettings();
  await page.getByRole('button', { name: '移除', exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('.app.has-custom-background, .background-layer'));
  assert.deepEqual(await page.evaluate(() => window.__removedBackgrounds), ['pi-media://background/motion.webm']);
  assert.deepEqual(errors, []);
  console.log(`Background QA passed; screenshots saved to ${output}`);
} finally {
  await browser.close();
}
