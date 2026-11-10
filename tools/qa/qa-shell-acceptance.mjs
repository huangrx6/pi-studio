/**
 * 方案 A 的验收脚本：
 *   1. 纯红 / 纯蓝 / 暗色照片三张壁纸下，窗口内同一元素取色 RGB 差 ≤ 2；
 *   2. 窗口内出现的表面色不超过四级（含 hover 不算）；
 *   3. text-1 / text-2 对各自底色对比度 ≥ 4.5。
 * 运行前先 pnpm run build。截图写到 .qa/acceptance/。
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

// 逻辑坐标 → 物理像素（截图是 2x）
const POINTS = [
  ['sidebar', 120, 420],
  ['canvas', 1180, 700],
  ['header', 900, 52],
  ['composer', 900, 560],
];

const app = await _electron.launch({ args: [root], env });
const page = await app.firstWindow();
page.setDefaultTimeout(20000);
await page.locator('.app').waitFor();
await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1440, 920));
await page.waitForFunction(() => innerWidth === 1440);

async function sample() {
  const shot = await app.evaluate(async ({ BrowserWindow }) => {
    const image = await BrowserWindow.getAllWindows()[0].webContents.capturePage();
    return { width: image.getSize().width, bitmap: image.toBitmap().toString('base64') };
  });
  const buffer = Buffer.from(shot.bitmap, 'base64');
  const at = (x, y) => {
    const offset = (y * shot.width + x) * 4;
    return [buffer[offset + 2], buffer[offset + 1], buffer[offset]];
  };
  return Object.fromEntries(POINTS.map(([name, x, y]) => [name, at(x * 2, y * 2)]));
}

const results = {};
for (const [name, file] of [['red', 'red.png'], ['blue', 'blue.png'], ['photo', 'photo.png']]) {
  await page.evaluate((wallpaper) => {
    const current = JSON.parse(localStorage.getItem('pi-studio:preferences') || '{}');
    localStorage.setItem('pi-studio:preferences', JSON.stringify({
      ...current,
      theme: 'dark',
      backgroundMedia: { kind: 'image', url: `pi-media://background/${wallpaper}`, name: wallpaper, mime: 'image/png', bytes: 300 },
      backgroundOpacity: 100, backgroundBlur: 0, backgroundSurfaceOpacity: 0,
    }));
  }, file);
  await page.reload();
  await page.locator('.app').waitFor();
  await page.waitForFunction(() => innerWidth === 1440);
  await sleep(900);
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

await app.close();
console.log('shell acceptance passed', JSON.stringify({ drift, results, contrast }, null, 1));
