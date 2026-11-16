import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
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
  window.piApi.files = async (cwd, path) => ({ cwd, path, entries: [] });
  window.piApi.terminalCreate = async ({ id, cwd, cols, rows }) => ({
    id, cwd, shell: '/bin/zsh', status: 'running', sequence: 1,
    replay: { cols, rows, truncated: false, steps: [{ type: 'data', data: Array.from({ length: 180 }, (_, i) => `output ${i + 1}`).join('\r\n') }] },
  });
  let onTemporary;
  window.piApi.onTemporary = fn => { onTemporary = fn; return () => {}; };
  window.piApi.temporaryPrompt = async ({ id }) => {
    const emit = count => onTemporary({ id, type: 'message', message: {
      role: 'assistant', timestamp: 1, content: [{ type: 'text', text: Array.from({ length: count }, (_, i) => `第 ${i + 1} 段输出。`).join('\n\n') }],
    } });
    window.appendTemporaryOutput = () => emit(95);
    emit(80);
  };
}

const near = (a, b, label) => assert.ok(Math.abs(a - b) <= 1, `${label}: ${a} / ${b}`);
const bottom = node => node.scrollHeight - node.scrollTop - node.clientHeight <= 1;

async function checkJump(page, scroller, label, verifyPaused) {
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
  near(rect.x + rect.width / 2, before.x + before.width / 2, 'centered over output');
  assert.deepEqual(await scroller.boundingBox(), before, 'showing the arrow keeps the same reading area');
  if (verifyPaused) await verifyPaused();
  await button.press('Enter');
  await button.waitFor({ state: 'detached' });
  assert.deepEqual(await scroller.boundingBox(), before, 'jumping keeps the same reading area');
}

async function checkTerminal(page, fullscreen) {
  await page.locator('.file-panel').evaluate(async panel => {
    await Promise.all(panel.getAnimations().map(animation => animation.finished));
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  });
  const box = await page.locator('.terminal-stage').evaluate(stage => {
    const rect = selector => document.querySelector(selector).getBoundingClientRect();
    const panel = rect('.terminal-panel'), toolbar = rect('.terminal-toolbar'), host = rect('.terminal-host');
    const screen = rect('.xterm-screen'), frame = rect('.app'), canvas = rect('.file-panel'), card = stage.getBoundingClientRect();
    return {
      margin: [card.top - toolbar.bottom, panel.right - card.right, panel.bottom - card.bottom, card.left - panel.left],
      padding: [host.top - card.top, card.right - host.right, card.bottom - host.bottom, host.left - card.left],
      screenFits: screen.height > 0 && screen.width > 0 && screen.bottom <= host.bottom + 1 && screen.right <= host.right + 1,
      viewportBackground: getComputedStyle(stage.querySelector('.xterm-viewport')).backgroundColor,
      cardBackground: getComputedStyle(stage).backgroundColor,
      radius: getComputedStyle(stage).borderRadius,
      frameGutters: [canvas.left - frame.left, frame.right - canvas.right],
    };
  });
  assert.ok(box.margin[0] > 0);
  box.margin.forEach(value => near(value, box.margin[0], 'even terminal margins'));
  near(box.padding[0], box.padding[2], 'vertical text inset');
  near(box.padding[1], box.padding[3], 'horizontal text inset');
  assert.ok(Math.min(...box.padding) >= 8 && parseFloat(box.radius) > 0);
  assert.ok(box.screenFits, 'the fitted rows and columns stay inside the padded surface');
  assert.equal(box.viewportBackground, box.cardBackground, 'any space below a whole row matches the terminal theme');
  if (fullscreen) {
    assert.ok(box.frameGutters[0] > 0);
    near(...box.frameGutters, 'both exposed workbench edges');
  }
}

async function checkTerminalModes(page, savePreview) {
  const button = name => page.getByRole('button', { name, exact: true });
  await checkTerminal(page, false);
  await button('全屏').click();
  await page.waitForFunction(() => document.querySelector('.xterm-screen').clientWidth > window.innerWidth * .85);
  await checkTerminal(page, true);
  await checkJump(page, page.locator('.terminal-host'), '跳到最新输出', async () => {
    await checkTerminal(page, true);
    await page.screenshot({ path: savePreview, animations: 'disabled' });
  });
  await button('分栏').click();
  await page.waitForFunction(() => document.querySelector('.xterm-screen').clientWidth < window.innerWidth * .75);
  await checkTerminal(page, true);
  await button('退出分栏').click();
  await button('退出全屏').click();
  await page.waitForFunction(() => document.querySelector('.file-panel').clientWidth < 800);
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
    const page = await app.firstWindow();
    page.setDefaultTimeout(12000);
    await app.evaluate(({ dialog }, directory) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [directory] });
    }, workspace);
    await page.getByRole('button', { name: '打开工作区', exact: true }).click();
    await page.getByRole('button', { name: '打开右侧面板', exact: true }).click();
    await page.locator('.panel-start').getByRole('button', { name: '新建终端' }).click();
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
    await checkTerminalModes(page, `${output}/terminal-desktop.png`);
    // Reconnect to the existing terminal and jump through its restored scrollback.
    const previous = await page.locator('.terminal-host .xterm').elementHandle();
    await page.getByRole('button', { name: '重新连接终端', exact: true }).click();
    await page.waitForFunction(node => !node.isConnected, previous);
    await page.locator('.terminal-live-state.is-running').waitFor();
    await checkJump(page, page.locator('.terminal-host'), '跳到最新输出');
    console.log('Passed native terminal scrolling, resizing, split view and reconnect.');
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
    await checkJump(page, chat, '回到最新消息');
    assert.ok(await chat.evaluate(bottom));

    await button('打开右侧面板').click();
    await page.locator('.panel-start').getByRole('button', { name: '新建终端' }).click();
    await page.locator('.terminal-live-state.is-running').waitFor();
    if (theme === 'dark') await page.locator('.app.is-wallpaper-inside .window-wallpaper img').waitFor();
    else await page.locator('.terminal-panel[data-terminal-theme="nord"]').waitFor();
    await page.evaluate(() => document.fonts.ready);
    await checkTerminalModes(page, `${output}/terminal-${theme}.png`);

    const color = node => getComputedStyle(node).backgroundColor;
    const tab = page.getByRole('tab', { selected: true });
    await page.mouse.move(1, 1);
    const selected = await session.evaluate(color);
    assert.notEqual(selected, 'rgba(0, 0, 0, 0)');
    assert.equal(await tab.evaluate(color), selected);
    await session.hover();
    const hover = await session.evaluate(async node => {
      await Promise.all(node.getAnimations().map(animation => animation.finished));
      return getComputedStyle(node).backgroundColor;
    });
    await tab.hover();
    assert.equal(await tab.evaluate(color), hover);
    await page.locator('.bottom-row[title="设置"]').click();
    const settings = page.locator('.settings-nav-row.is-active');
    await settings.waitFor();
    assert.equal(await settings.evaluate(color), selected);
    await settings.hover();
    await page.waitForFunction(expected => getComputedStyle(document.querySelector('.settings-nav-row.is-active')).backgroundColor === expected, hover);
    await button('返回对话').click();

    await page.locator('.sidebar').getByRole('button', { name: '临时聊天' }).click();
    const temporary = page.locator('.temporary-scroll');
    await page.getByRole('textbox', { name: '临时聊天消息' }).fill('输出多段文本');
    await button('发送临时消息').click();
    await page.waitForFunction(() => document.querySelector('.temporary-scroll')?.scrollTop > 500);
    await checkJump(page, temporary, '回到最新消息', async () => {
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
