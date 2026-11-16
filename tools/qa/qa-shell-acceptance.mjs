/**
 * Desktop pixel checks for wallpaper opacity, theme surfaces and text contrast.
 * Run after pnpm run build. Screenshots stay in .qa/screenshots/shell-acceptance/.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron } from 'playwright-core';

const root = fileURLToPath(new URL('../..', import.meta.url));
const output = path.join(root, '.qa/screenshots/shell-acceptance');
mkdirSync(output, { recursive: true });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 生成一张纯色 PNG，避免验收依赖外部图片文件。 */
function solidPng(rgb, size = 64) {
  const raw = Buffer.concat(Array.from({ length: size }, () => Buffer.concat([Buffer.from([0]), Buffer.alloc(size * 3).fill(0).map((_, index) => rgb[index % 3])])));
  const chunk = (kind, data) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(kind), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body) >>> 0);
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8;
  header[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return crc ^ 0xffffffff;
}

const profile = mkdtempSync(path.join(os.tmpdir(), 'pi-studio-accept-'));
const media = path.join(profile, 'background-media');
mkdirSync(media, { recursive: true });
writeFileSync(path.join(media, 'red.png'), solidPng([255, 0, 0]));
writeFileSync(path.join(media, 'blue.png'), solidPng([0, 64, 255]));
copyFileSync(path.join(root, 'docs/assets/screens/conversation-dark.png'), path.join(media, 'photo.png'));

const env = { ...process.env, PI_STUDIO_USER_DATA: profile, PI_STUDIO_DB: path.join(profile, 'studio.sqlite') };
delete env.ELECTRON_RUN_AS_NODE;
delete env.PI_STUDIO_DEV;

const POINTS = [
  ['sidebar', 120, 420],
  ['canvas', 1180, 700],
  ['header', 900, 52],
  ['composer', 900, 560],
];

const app = await _electron.launch({ args: ['--force-color-profile=srgb', root], env });
const page = await app.firstWindow();
page.setDefaultTimeout(20000);
await page.locator('.app').waitFor();
await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1440, 920));
await page.waitForFunction(() => innerWidth === 1440);

async function sample(points = POINTS) {
  const screenshot = await page.screenshot({ scale: 'css', animations: 'disabled' });
  return app.evaluate(({ nativeImage }, { png, points }) => {
    const image = nativeImage.createFromBuffer(Buffer.from(png, 'base64'));
    const bitmap = image.toBitmap();
    const { width, height } = image.getSize();
    return Object.fromEntries(points.map(([name, x, y]) => {
      if (x < 0 || x >= width || y < 0 || y >= height) throw new Error(`${name} is outside the screenshot at ${x}, ${y}`);
      const offset = (Math.floor(y) * width + Math.floor(x)) * 4;
      return [name, [bitmap[offset + 2], bitmap[offset + 1], bitmap[offset]]];
    }));
  }, { png: screenshot.toString('base64'), points });
}

async function loadWallpaper(file, inside = 0, outside = 100) {
  await page.evaluate(({ wallpaper, inside, outside }) => {
    const current = JSON.parse(localStorage.getItem('pi-studio:preferences') || '{}');
    localStorage.setItem('pi-studio:preferences', JSON.stringify({
      ...current,
      theme: 'dark',
      backgroundMedia: { kind: 'image', url: `pi-media://background/${wallpaper}`, name: wallpaper, mime: 'image/png', bytes: 300 },
      backgroundOpacity: outside, backgroundBlur: 0, backgroundSurfaceOpacity: 0,
      backgroundInsideVisibility: inside,
    }));
  }, { wallpaper: file, inside, outside });
  await page.reload();
  await page.locator('.new-conversation-welcome').waitFor();
  await page.locator('.background-layer-media').evaluate(image => image.decode());
}

const results = {};
for (const [name, file] of [['red', 'red.png'], ['blue', 'blue.png'], ['photo', 'photo.png']]) {
  await loadWallpaper(file);
  results[name] = await sample();
  const gutter = await page.evaluate(() => {
    const layer = document.querySelector('.background-layer');
    return layer ? getComputedStyle(layer).visibility : 'missing';
  });
  assert.equal(gutter, 'visible', `${name}: wallpaper layer is visible`);
  await page.screenshot({ path: path.join(output, `wallpaper-${name}.png`) });
}

const drift = {};
for (const [name] of POINTS) {
  const values = Object.values(results).map((entry) => entry[name]);
  const spread = Math.max(...[0, 1, 2].map((channel) => Math.max(...values.map((value) => value[channel])) - Math.min(...values.map((value) => value[channel]))));
  drift[name] = spread;
  assert.ok(spread <= 2, `${name} colour is wallpaper-independent (spread ${spread}: ${JSON.stringify(values)})`);
}

// 表面种类：窗口内所有不透明背景色去重后不应超过四级。
await page.evaluate(() => {
  const current = JSON.parse(localStorage.getItem('pi-studio:preferences') || '{}');
  localStorage.setItem('pi-studio:preferences', JSON.stringify({ ...current, backgroundMedia: null }));
});
await page.reload();
await page.locator('.app').waitFor();
await sleep(600);
for (const theme of ['dark', 'light']) {
  await page.evaluate((value) => {
    const current = JSON.parse(localStorage.getItem('pi-studio:preferences') || '{}');
    localStorage.setItem('pi-studio:preferences', JSON.stringify({ ...current, theme: value }));
  }, theme);
  await page.reload();
  await page.locator('.app').waitFor();
  await sleep(500);
  const surfaces = await page.evaluate(() => {
    const seen = new Map();
    for (const node of document.querySelectorAll('.app *')) {
      const style = getComputedStyle(node);
      const color = style.backgroundColor;
      if (!color || color === 'rgba(0, 0, 0, 0)' || color === 'transparent') continue;
      if (color.startsWith('color(') || color.startsWith('rgba')) continue;
      seen.set(color, (seen.get(color) || 0) + 1);
    }
    return [...seen.entries()].sort((a, b) => b[1] - a[1]);
  });
  console.log(theme, 'opaque surfaces', JSON.stringify(surfaces.slice(0, 8)));
  assert.ok(surfaces.length <= 8, `${theme}: opaque surface count stays small (${surfaces.length})`);
}

// 对比度
const contrast = await page.evaluate(() => {
  const parse = (value) => value.match(/[\d.]+/g).slice(0, 3).map(Number);
  const luminance = ([r, g, b]) => {
    const channel = (raw) => {
      const value = raw / 255;
      return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
  };
  const ratio = (a, b) => {
    const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
    return (hi + 0.05) / (lo + 0.05);
  };
  const canvas = parse(getComputedStyle(document.querySelector('.app')).backgroundColor);
  const read = (token) => {
    const probe = document.createElement('span');
    probe.style.color = `var(${token})`;
    document.body.appendChild(probe);
    const value = parse(getComputedStyle(probe).color);
    probe.remove();
    return value;
  };
  return {
    text1: ratio(read('--text-1'), canvas).toFixed(2),
    text2: ratio(read('--text-2'), canvas).toFixed(2),
  };
});
console.log('contrast on canvas', JSON.stringify(contrast));
assert.ok(Number(contrast.text1) >= 4.5, `text-1 contrast ${contrast.text1}`);
assert.ok(Number(contrast.text2) >= 4.5, `text-2 contrast ${contrast.text2}`);

// Sample blank pixels on each surface of the live window. Use its own theme colours
// as the base and the known red PNG as the source in the source-over calculation.
async function assertVisibility(label, inside, outside, scrim = 0) {
  const { points, chrome, canvas } = await page.evaluate(async () => {
    const view = document.querySelector('.settings-overlay') || document.querySelector('.app');
    await Promise.all([...document.querySelectorAll('.window-wallpaper img')].map(image => image.decode()));
    await Promise.all([...view.querySelectorAll('.shell-sidebar, .file-panel')].flatMap(node =>
      node.getAnimations().map(animation => animation.finished.catch(() => {}))));
    const rect = selector => view.querySelector(selector).getBoundingClientRect();
    const region = rect('.content-region');
    const sidebar = rect('.shell-sidebar');
    const frame = document.querySelector('.app').getBoundingClientRect();
    const points = [
      ['outside', 2, 2],
      ['outside bottom', frame.left + frame.width / 2, frame.bottom + 3],
      ['header', region.left + region.width / 2, region.top - 4],
      ['inner gutter', region.right + 3, region.top + region.height / 2],
      ['canvas', region.left + 8, region.top + region.height / 2],
    ];
    if (sidebar.width > 0) points.push(['sidebar', sidebar.left + 4, sidebar.top + sidebar.height / 2]);
    const panel = view.querySelector('.panel-body');
    if (panel) {
      const box = panel.getBoundingClientRect();
      points.push(['workbench', box.right - 8, box.top + box.height / 2]);
    }
    const context = document.createElement('canvas').getContext('2d');
    function rgb(token) {
      context.fillStyle = getComputedStyle(view).getPropertyValue(token);
      context.fillRect(0, 0, 1, 1);
      return Array.from(context.getImageData(0, 0, 1, 1).data).slice(0, 3);
    }
    return { points, chrome: rgb('--surface-chrome'), canvas: rgb('--surface-canvas') };
  });
  const pixels = await sample(points);
  for (const [area, actual] of Object.entries(pixels)) {
    const base = ['canvas', 'workbench'].includes(area) ? canvas : chrome;
    const alpha = area.startsWith('outside') ? (outside / 100) * (1 - scrim / 100) : inside / 100;
    const expected = base.map((channel, i) => Math.round(channel * (1 - alpha) + (i === 0 ? 255 : 0) * alpha));
    assert.ok(actual.every((v, i) => Math.abs(v - expected[i]) <= 2),
      `${label} ${area}: expected RGB ${expected}, got ${actual}`);
  }
}

try {
  await loadWallpaper('red.png', 32, 48);
  await page.locator('.bottom-row[title="设置"]').click();
  for (const theme of ['dark', 'light']) {
    await page.getByRole('button', { name: theme === 'dark' ? '深色' : '浅色', exact: true }).click();
    for (const percent of [32, 0, 75, 100]) {
      await page.locator('#background-inside').fill(String(percent));
      await assertVisibility(`${theme} settings ${percent}%`, percent, 48);
    }
  }
  await page.locator('#background-inside').fill('32');
  await page.locator('#background-blur').fill('100');
  await assertVisibility('blurred wallpaper edges', 32, 48);
  await page.locator('#background-blur').fill('0');
  await page.locator('#background-opacity').fill('100');
  await page.locator('#background-surface').fill('75');
  await assertVisibility('separate outer scrim', 32, 100, 75);
  await page.locator('#background-opacity').fill('0');
  await assertVisibility('outer media hidden', 32, 0, 75);
  await page.getByRole('button', { name: '返回对话' }).click();
  await assertVisibility('conversation', 32, 0, 75);
  await page.getByRole('button', { name: '打开右侧面板' }).click();
  await page.locator('.file-panel.is-open .panel-start').waitFor();
  await assertVisibility('docked workbench', 32, 0, 75);
  await page.locator('.panel-start').getByRole('button', { name: '临时聊天', exact: true }).click();
  await page.getByRole('button', { name: '全屏', exact: true }).click();
  await assertVisibility('fullscreen workbench', 32, 0, 75);
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+,' : 'Control+,');
  await page.locator('.settings-content h1').waitFor();
  await assertVisibility('settings over fullscreen workbench', 32, 0, 75);
} finally {
  await app.close();
}
console.log('shell acceptance passed', JSON.stringify({ drift, results, contrast }, null, 1));
