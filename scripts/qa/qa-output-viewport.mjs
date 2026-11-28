import { openToolPanel, resizeToolHost } from './fixtures/tool-panel.mjs';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, _electron } from 'playwright-core';
import { installPerformanceFixture } from './fixtures/performance.mjs';
import { serveProductionRenderer } from './fixtures/production-renderer-server.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));
const output = `${root}/.qa/output-viewport`;
await mkdir(output, { recursive: true });

function installOutputFixture(theme) {
  const prefs = JSON.parse(localStorage.getItem('pi-studio:preferences'));
  Object.assign(prefs, { theme, palette: 'ocean', radiusStyle: 'compact' });
  if (theme === 'dark') {
    prefs.backgroundMedia = { kind: 'image', url: 'pi-media://background/test.svg', name: 'test.svg', mime: 'image/svg+xml', bytes: 256 };
    prefs.backgroundInsideVisibility = 32;
  } else prefs.terminalTheme = 'nord';
  localStorage.setItem('pi-studio:preferences', JSON.stringify(prefs));
  const group = { mountId:'qa-tools', context: {key:'studio', title:'QA'}, tabs:[{ id:'qa-terminal', kind:'terminal', title:'终端' }], active:'qa-terminal' };
  window.toolWindowApi = {
    state: async () => ({key:'studio', groups:[group], visible:true, maximized:false}),
    onState: () => () => {},
    command: async () => {},
  };
  window.piApi.files = async (cwd, path) => ({ cwd, path, entries: [] });
  window.piApi.terminalCreate = async ({ id, cwd, cols, rows }) => ({
    id, cwd, shell: '/bin/zsh', status: 'running', sequence: 1,
    replay: { cols, rows, truncated: false, steps: [{ type: 'data', data: Array.from({ length: 180 }, (_, i) => `output ${i + 1}`).join('\r\n') }] },
  });
  window.piApi.temporaryHistory = async () => [];
  window.piApi.temporaryModel = async () => (await window.piApi.models()).selection;
  let onTemporary;
  window.piApi.onTemporary = fn => { onTemporary = fn; return () => {}; };
  window.piApi.temporaryPrompt = async ({ id, text }) => {
    onTemporary({ id, type: 'message', message: { role: 'user', timestamp: 1, content: [{ type: 'text', text }] } });
    const emit = count => onTemporary({ id, type: 'message', message: {
      role: 'assistant', timestamp: 2, content: [{ type: 'text', text: Array.from({ length: count }, (_, i) => `第 ${i + 1} 段输出。`).join('\n\n') }],
    } });
    window.appendTemporaryOutput = () => emit(95);
    emit(80);
  };
}

const near = (a, b, label) => assert.ok(Math.abs(a - b) <= 1, `${label}: ${a} / ${b}`);
const bottom = node => node.scrollHeight - node.scrollTop - node.clientHeight <= 1;

async function checkJump(page, scroller, label, alignment, verifyPaused) {
  const button = scroller.locator('..').getByRole('button', { name: label, exact: true });
  const before = await scroller.boundingBox();
  await page.mouse.move(before.x + before.width / 2, before.y + before.height / 2);
  await page.mouse.wheel(0, -520);
  await button.waitFor();
  const rect = await button.boundingBox();
  assert.equal(await button.innerText(), '');
  assert.equal(await button.locator('svg').count(), 1);
  near(rect.width, rect.height, 'square hit area');
  assert.ok(rect.width >= 28 && rect.width <= 36);
  if (alignment === 'center') {
    near(rect.x + rect.width / 2, before.x + before.width / 2, 'centered over terminal output');
  } else {
    const column = await scroller.locator('.chat-column').boundingBox();
    const right = rect.x + rect.width;
    assert.ok(right <= before.x + before.width && Math.abs(right - column.x - column.width) <= 64,
      'chat jump button stays within the viewport near the right edge of the reading column');
  }
  const sameReadingArea = async () => {
    const current = await scroller.boundingBox();
    for (const key of ['x', 'y', 'width', 'height']) near(current[key], before[key], `jump keeps reading area ${key}`);
  };
  await sameReadingArea();
  if (verifyPaused) await verifyPaused();
  await button.press('Enter');
  await button.waitFor({ state: 'detached' });
  await sameReadingArea();
}

async function checkTerminal(page) {
  await page.locator('.tool-window').evaluate(async panel => {
    await Promise.all(panel.getAnimations().map(animation => animation.finished));
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  });
  const box = await page.locator('.terminal-stage').evaluate(stage => {
    const rect = selector => document.querySelector(selector).getBoundingClientRect();
    const panel = rect('.terminal-panel'), toolbar = rect('.terminal-toolbar'), host = rect('.terminal-host');
    const screen = rect('.xterm-screen'), card = stage.getBoundingClientRect();
    return {
      margin: [card.top - toolbar.bottom, panel.right - card.right, panel.bottom - card.bottom, card.left - panel.left],
      padding: [screen.top - card.top, card.right - host.right, card.bottom - host.bottom, host.left - card.left],
      screenFits: screen.height > 0 && screen.width > 0 && screen.bottom <= host.bottom + 1 && screen.right <= host.right + 1,
      viewportBackground: getComputedStyle(stage.querySelector('.xterm-viewport')).backgroundColor,
      cardBackground: getComputedStyle(stage).backgroundColor,
      radius: getComputedStyle(stage).borderRadius,
    };
  });
  assert.ok(box.margin[0] > 0);
  box.margin.forEach(value => near(value, box.margin[0], 'even terminal margins'));
  const [top, right, bottom, left] = box.padding;
  near(top, 3, 'border and padding above the first terminal row');
  near(right, left, 'horizontal text inset');
  assert.ok(Math.min(right, bottom, left) >= 8 && parseFloat(box.radius) > 0);
  assert.ok(box.screenFits, 'the fitted rows and columns stay inside the padded surface');
  assert.equal(box.viewportBackground, box.cardBackground, 'any space below a whole row matches the terminal theme');

}

async function checkTerminalModes(page, resize, savePreview, smallWidth = 660) {
  await resize(smallWidth, 650);
  await page.waitForFunction(limit => innerWidth <= limit && document.querySelector('.xterm-screen')?.clientWidth < limit, smallWidth);
  const compactWidth = await page.evaluate(() => innerWidth);
  await checkTerminal(page);
  await resize(1150, 760);
  await page.waitForFunction(compact => innerWidth > compact && document.querySelector('.xterm-screen')?.clientWidth > innerWidth * .85, compactWidth);
  await checkTerminal(page);
  await checkJump(page, page.locator('.terminal-host'), '跳到最新输出', 'center', async () => {
    await checkTerminal(page);
    await page.screenshot({ path: savePreview, animations: 'disabled' });
  });
}

async function checkTerminalColors(app, page, directory) {
  const rows = [
    { prefix: '', text: 'atlas-notes', sgr: '1;38;2;154;190;242' },
    { prefix: '', text: '❯ ls -la', sgr: '1;38;2;159;215;166' },
    { prefix: 'drwxr-xr-x  ', text: 'src/', sgr: '38;5;110' },
    { prefix: '-rw-r--r--  ', text: '.gitignore', sgr: '38;2;208;208;208' },
    { prefix: '-rw-r--r--  ', text: 'README.md', sgr: '97' },
    { prefix: '-rw-r--r--  ', text: '.env.example', sgr: '2;38;2;204;204;204' },
  ];
  const filename = path.join(directory, 'colors.ansi');
  await writeFile(filename, '\x1b[2J\x1b[H' + rows.map(row => row.prefix + '\x1b[' + row.sgr + 'm' + row.text + '\x1b[0m\n').join(''));
  await page.locator('.xterm-helper-textarea').focus();
  await page.keyboard.type("cat '" + filename.replaceAll("'", "'\\''") + "'");
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => window.qaOutputTail.includes('.env.example\x1b[0m'));

  for (const [theme, preset, lightTerminal] of [['light', 'studio', true], ['dark', 'studio', false],
    ['dark', 'solarized-light', true], ['light', 'nord', false]]) {
    await page.evaluate(({ theme, preset }) => {
      const key = 'pi-studio:preferences';
      localStorage.setItem(key, JSON.stringify({ ...JSON.parse(localStorage.getItem(key)), theme, terminalTheme: preset }));
      window.dispatchEvent(new Event('storage'));
    }, { theme, preset });
    await page.waitForFunction(({ theme, preset }) => document.documentElement.dataset.theme === theme &&
      (document.querySelector('.terminal-panel').dataset.terminalTheme ?? 'studio') === preset, { theme, preset });
    const metrics = await page.locator('.xterm-helper-textarea').evaluate(async node => {
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      return { cellWidth: parseFloat(node.style.width), cellHeight: parseFloat(node.style.height),
        renderer: node.closest('.xterm-screen').querySelector('.xterm-rows') ? 'DOM' : 'WebGL',
        ratio: Number(getComputedStyle(node).getPropertyValue('--terminal-minimum-contrast')) };
    });
    if (process.argv.includes('--disable-webgl')) assert.equal(metrics.renderer, 'DOM');
    assert.equal(metrics.ratio, lightTerminal ? 9 : 1);
    if (!lightTerminal) continue;
    const screen = await page.locator('.xterm-screen').boundingBox();
    const clip = { x: screen.x, y: screen.y, width: Math.ceil(30 * metrics.cellWidth), height: Math.ceil(rows.length * metrics.cellHeight) };
    const pixels = await page.screenshot({ clip, scale: 'device' });
    const ratios = await app.evaluate(({ nativeImage }, { png, rows, metrics, clip }) => {
      const image = nativeImage.createFromBuffer(Buffer.from(png, 'base64'));
      const { width } = image.getSize(), bitmap = image.toBitmap(), scale = width / clip.width;
      function luminance(x, y) {
        const i = (y * width + x) * 4;
        const linear = byte => (byte / 255 <= 0.04045 ? byte / 255 / 12.92 : ((byte / 255 + 0.055) / 1.055) ** 2.4);
        return 0.2126 * linear(bitmap[i + 2]) + 0.7152 * linear(bitmap[i + 1]) + 0.0722 * linear(bitmap[i]);
      }
      const background = luminance(width - 1, 0);
      return rows.map(({ prefix, text }, row) => {
        let ink = background;
        for (let y = Math.ceil(row * metrics.cellHeight * scale); y < Math.floor((row + 1) * metrics.cellHeight * scale); y++) {
          for (let x = Math.ceil(prefix.length * metrics.cellWidth * scale); x < Math.floor((prefix.length + text.length) * metrics.cellWidth * scale); x++) {
            ink = Math.min(ink, luminance(x, y));
          }
        }
        return (background + 0.05) / (ink + 0.05);
      });
    }, { png: pixels.toString('base64'), rows, metrics, clip });
    rows.forEach((row, i) => assert.ok(ratios[i] >= 4.5, `${preset} ${row.text} contrast: ${ratios[i]}`));
    console.log(preset, metrics.renderer, 'terminal glyph contrast:', ratios.map(value => value.toFixed(2)).join(', '));
    if (preset === 'studio') {
      const header = await page.locator('.tool-tabs:visible').boundingBox();
      const filename = process.argv.includes('--disable-webgl') ? 'terminal-colors-light-dom.png' : 'terminal-colors-light.png';
      await page.screenshot({ path: path.join(output, filename), clip: {
        ...header, height: Math.ceil(clip.y + clip.height + metrics.cellHeight * 2 - header.y),
      } });
    }
  }
}

// The desktop run uses a real shell in a disposable workspace and a separate Studio profile.
async function checkDesktopTerminal() {
  const profile = await mkdtemp(path.join(tmpdir(), 'pi-output-viewport-'));
  const workspace = path.join(profile, 'workspace');
  const env = { ...process.env, PI_STUDIO_USER_DATA: profile, PI_STUDIO_DB: path.join(profile, 'studio.sqlite'), ZDOTDIR: profile, SHELL: '/bin/zsh' };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.PI_STUDIO_DEV;
  let app;
  try {
    await mkdir(workspace);
    app = await _electron.launch({ args: [root], cwd: workspace, env });
    let page = await app.firstWindow();
    page.setDefaultTimeout(12000);
    await app.evaluate(({ dialog }, directory) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [directory] });
    }, workspace);
    await page.getByRole('button', { name: '打开工作区', exact: true }).click();
    const main = page;
    page = await openToolPanel(app, main);
    if (process.argv.includes('--disable-webgl')) await page.evaluate(() => {
      const getContext = HTMLCanvasElement.prototype.getContext;
      HTMLCanvasElement.prototype.getContext = function(type, ...args) {
        return /webgl/i.test(type) ? null : getContext.call(this, type, ...args);
      };
    });
    await page.getByRole('button', { name:'新终端', exact:true }).click();
    await page.locator('.terminal-live-state.is-running').waitFor();
    await page.evaluate(() => {
      window.qaOutputTail = '';
      window.piApi.onTerminalEvent(event => {
        if (event.type === 'data') window.qaOutputTail = (window.qaOutputTail + event.data).slice(-8192);
      });
    });
    await page.locator('.xterm-helper-textarea').focus();
    await page.keyboard.type('seq 1 180');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => window.qaOutputTail.includes('\r\n180\r\n'));
    const resize = (width, height) => resizeToolHost(app, main, width, height);
    await checkTerminalModes(page, resize, `${output}/terminal-desktop.png`, 980);
    // Reconnect to the existing terminal and jump through its restored scrollback.
    const previous = await page.locator('.terminal-host .xterm').elementHandle();
    await page.getByRole('button', { name: '重新连接终端', exact: true }).click();
    await page.waitForFunction(node => !node.isConnected, previous);
    await page.locator('.terminal-live-state.is-running').waitFor();
    await checkJump(page, page.locator('.terminal-host'), '跳到最新输出', 'center');
    await checkTerminalColors(app, page, workspace);
    console.log('Passed native terminal scrolling, parent window resizing and reconnect.');
  } finally {
    await app?.close();
    await rm(profile, { recursive: true, force: true });
  }
}

if (process.argv.includes('--desktop')) {
  await checkDesktopTerminal();
  process.exit(0);
}

const server = await serveProductionRenderer(root);
let browser;
try {
  browser = await chromium.launch({ executablePath: process.env.CHROME_BIN || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
  for (const theme of ['dark', 'light']) {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });
    page.setDefaultTimeout(8000);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('pi-media://background/test.svg', route => route.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="80" height="80"><rect width="80" height="80" fill="slategray"/></svg>' }));
    await page.addInitScript({ content: `(${installPerformanceFixture})({sessionCount:1,turnCount:10});(${installOutputFixture})(${JSON.stringify(theme)});` });
    await page.goto(server.origin);
    const button = name => page.getByRole('button', { name, exact: true });
    const session = page.locator('.session-row').first();
    await session.click();
    const chat = page.locator('.chat-scroll');
    await page.waitForFunction(() => document.querySelector('.chat-scroll')?.scrollTop > 500);
    await checkJump(page, chat, '回到最新消息', 'right');
    assert.ok(await chat.evaluate(bottom));

    const tools = await browser.newPage({reducedMotion:'reduce'});
    tools.on('pageerror', error => errors.push(error.message));
    await tools.addInitScript({ content: `(${installPerformanceFixture})({sessionCount:1,turnCount:10});(${installOutputFixture})(${JSON.stringify(theme)});` });
    await tools.goto(server.origin + '/tools.html');
    await tools.locator('.terminal-live-state.is-running').waitFor();
    if (theme === 'dark') await page.locator('.app.is-wallpaper-inside .window-wallpaper img').waitFor();
    else await tools.locator('.terminal-panel[data-terminal-theme="nord"]').waitFor();
    await tools.evaluate(() => document.fonts.ready);
    await checkTerminalModes(tools, (width,height) => tools.setViewportSize({width,height}), `${output}/terminal-${theme}.png`);
    await tools.close();

    const color = node => getComputedStyle(node).backgroundColor;
    await page.mouse.move(1, 1);
    const selected = await session.evaluate(color);
    assert.notEqual(selected, 'rgba(0, 0, 0, 0)');
    await session.hover();
    const hover = await session.evaluate(async node => {
      await Promise.all(node.getAnimations().map(animation => animation.finished));
      return getComputedStyle(node).backgroundColor;
    });
    await page.locator('.sidebar-rail').getByRole('button', { name: '设置', exact: true }).click();
    const settings = page.locator('.settings-nav-row.is-active');
    await settings.waitFor();
    assert.equal(await settings.evaluate(color), selected);
    await settings.hover();
    await page.waitForFunction(expected => getComputedStyle(document.querySelector('.settings-nav-row.is-active')).backgroundColor === expected, hover);
    await page.locator('[data-sidebar-section="conversations"]').click();

    await page.locator('.sidebar-rail').getByRole('button', { name: '临时对话', exact: true }).click();
    const temporary = page.locator('.temporary-scroll');
    await page.getByRole('textbox', { name: '临时聊天消息' }).fill('输出多段文本');
    await button('发送临时消息').click();
    await page.waitForFunction(() => document.querySelector('.temporary-scroll')?.scrollTop > 500);
    await checkJump(page, temporary, '回到最新消息', 'right', async () => {
      const top = await temporary.evaluate(node => node.scrollTop);
      await page.evaluate(() => window.appendTemporaryOutput());
      await temporary.getByText('第 95 段输出。', { exact: true }).waitFor({ state: 'attached' });
      near(await temporary.evaluate(node => node.scrollTop), top, 'reading position during new temporary output');
    });
    assert.ok(await temporary.evaluate(bottom));
    assert.deepEqual(errors, []);
    await page.close();
  }
  console.log('Passed output scrolling, terminal geometry and navigation selection in both themes.');
} finally {
  await browser?.close();
  await server.close();
}
