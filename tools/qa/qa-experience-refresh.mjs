/**
 * First-use, settings navigation, and workbench layout regression check.
 * Run after `pnpm run build`: node tools/qa/qa-experience-refresh.mjs
 * Uses only a fresh temporary Studio profile and a disposable workspace.
 */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron } from 'playwright-core';

const root = fileURLToPath(new URL('../..', import.meta.url));
const output = path.join(root, '.qa', 'experience-refresh');
const profile = await mkdtemp(path.join(os.tmpdir(), 'pi-studio-experience-'));
const workspace = path.join(profile, 'workspace');
await mkdir(output, { recursive: true });
await mkdir(workspace);
await writeFile(path.join(workspace, 'README.md'), '# Experience QA\nDisposable project fixture.\n');
const env = {
  ...process.env,
  PI_STUDIO_USER_DATA: profile,
  PI_STUDIO_DB: path.join(profile, 'studio.sqlite'),
};
delete env.ELECTRON_RUN_AS_NODE;
delete env.PI_STUDIO_DEV;

let app;
let page;
const pageErrors = [];
const layoutResults = [];

async function setWindowSize(width, height) {
  const actual = await app.evaluate(({ BrowserWindow }, size) => {
    const window = BrowserWindow.getAllWindows().find((item) => !item.isDestroyed() && item.webContents.getURL().includes('index.html'));
    if (!window) throw new Error('QA renderer window not found');
    window.setContentSize(size.width, size.height);
    const [width, height] = window.getContentSize();
    return { width, height };
  }, { width, height });
  // macOS can clamp a native window to the display's available work area.
  await page.waitForFunction((size) => window.innerWidth === size.width && window.innerHeight === size.height, actual);
}

async function capture(name) {
  await page.evaluate(async () => {
    await Promise.all(document.getAnimations().filter((animation) => animation.effect?.getTiming().iterations !== Infinity).map((animation) => animation.finished.catch(() => {})));
  });
  const geometry = await page.evaluate(() => {
    const selectors = ['.new-conversation-welcome', '.composer', '.settings-navigation', '.settings-content', '.file-panel.is-open'];
    return {
      width: innerWidth,
      height: innerHeight,
      horizontalOverflow: document.documentElement.scrollWidth > innerWidth + 1,
      surfaces: selectors.flatMap((selector) => {
        const element = document.querySelector(selector);
        if (!element || getComputedStyle(element).visibility === 'hidden') return [];
        const box = element.getBoundingClientRect();
        return [{ selector, x: box.x, y: box.y, width: box.width, height: box.height }];
      }),
    };
  });
  assert.equal(geometry.horizontalOverflow, false, `${name}: no document-wide horizontal overflow`);
  layoutResults.push({ name, ...geometry });
  await page.screenshot({ path: path.join(output, `${name}.png`), animations: 'disabled' });
}

async function waitForPanelWidth(width) {
  await page.waitForFunction((expected) => {
    const box = document.querySelector('.file-panel.is-open')?.getBoundingClientRect();
    return box && Math.abs(box.width - expected) <= 1;
  }, width);
}

try {
  app = await _electron.launch({ args: [root], env });
  page = await app.firstWindow();
  page.setDefaultTimeout(20_000);
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.locator('.new-conversation-welcome').waitFor();
  await setWindowSize(1440, 920);

  const welcome = page.locator('.new-conversation-welcome');
  assert.equal(await welcome.getByRole('heading', { name: '开始一个新会话', exact: true }).count(), 1);
  assert.match(await welcome.innerText(), /工作区/);
  assert.match(await welcome.innerText(), /模型/);
  await welcome.getByRole('button', { name: '选择工作区', exact: true }).waitFor();
  assert.equal(await page.locator('.workspace-choice').count(), 0, 'initial setup does not duplicate the workspace chooser in the composer');
  assert.equal(await page.locator('.model-label').count(), 0, 'initial setup does not duplicate the model chooser in the composer');
  await capture('01-first-use-light');

  // Only the dialog result is stubbed; workspace registration uses real IPC.
  await app.evaluate(({ dialog }, directory) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [directory] });
  }, workspace);
  await welcome.getByRole('button', { name: '选择工作区', exact: true }).click();
  await page.locator('.workspace-choice.has-selection').waitFor();
  assert.equal(await page.locator('.model-label').count(), 0, 'missing model stays in the single welcome setup path');
  const composer = page.getByRole('textbox', { name: '发送给 Pi 的消息', exact: true });
  await welcome.getByRole('button', { name: '了解项目', exact: true }).click();
  await page.waitForFunction(() => Boolean(document.querySelector('textarea[aria-label="发送给 Pi 的消息"]')?.value.trim()));
  const draft = await composer.inputValue();
  assert.equal(await page.locator('.session-row:not(.empty)').count(), 0, 'example fills a draft without creating a conversation');
  assert.equal(await page.locator('.new-conversation-welcome').count(), 1, 'example leaves new-conversation state intact');
  await page.locator('.new-conversation-suggestions').waitFor({ state: 'hidden' });

  await page.locator('.sidebar-bottom button[title="设置"]').click();
  const navigation = page.locator('.settings-navigation');
  await navigation.waitFor();
  assert.ok(await navigation.locator('.settings-nav-group').count() >= 3, 'settings are grouped');
  const search = navigation.getByRole('searchbox', { name: '搜索设置', exact: true });
  await search.fill('API');
  await navigation.getByRole('button', { name: '模型配置', exact: true }).waitFor();
  assert.equal(await navigation.getByRole('button', { name: '通用', exact: true }).count(), 0, 'aliases filter unrelated pages');
  await navigation.getByRole('button', { name: '模型配置', exact: true }).click();
  await page.getByRole('heading', { name: '模型配置', exact: true }).waitFor();
  await capture('02-settings-search');
  await search.fill('no-setting-matches-this-phrase');
  await navigation.locator('.settings-navigation-empty').waitFor();
  assert.equal(await navigation.locator('.settings-nav-row').count(), 0);
  await search.press('Escape');
  assert.equal(await search.inputValue(), '', 'Escape clears search');
  assert.equal(await navigation.isVisible(), true, 'Escape keeps settings open');
  await navigation.getByRole('button', { name: '通用', exact: true }).waitFor();
  await navigation.getByRole('button', { name: '返回对话', exact: true }).click();
  await welcome.waitFor();
  assert.equal(await composer.inputValue(), draft, 'returning from settings preserves the draft');
  assert.equal(await page.getByRole('button', { name: '发送消息', exact: true }).isDisabled(), true, 'ordinary prompts need a configured model');
  await composer.press('Enter');
  assert.equal(await composer.inputValue(), draft, 'Enter without a model preserves the draft');
  assert.equal(await page.locator('.session-row:not(.empty)').count(), 0, 'Enter without a model does not create a conversation');
  await composer.fill('/model');
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await page.getByRole('heading', { name: '模型配置', exact: true }).waitFor();
  await navigation.getByRole('button', { name: '返回对话', exact: true }).click();
  await welcome.waitFor();
  assert.equal(await composer.inputValue(), '', '/model routes missing-model setup to full configuration and consumes the command');
  await composer.fill(draft);

  await page.getByRole('button', { name: '打开右侧面板', exact: true }).click();
  await waitForPanelWidth(390);
  await capture('03-panel-default-light');
  const separator = page.getByRole('separator', { name: '调整右侧面板宽度' });
  await separator.focus();
  await separator.press('ArrowLeft');
  await waitForPanelWidth(430);
  assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('pi-studio:panel-width'))), 430);

  // Reload only this disposable renderer to prove a saved width survives startup.
  await page.reload();
  await welcome.waitFor();
  if (!(await page.locator('.file-panel.is-open').count())) {
    await page.getByRole('button', { name: '打开右侧面板', exact: true }).click();
  }
  await waitForPanelWidth(430);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const panelTool = page.locator('.panel-start-tools').getByRole('button', { name: '浏览器', exact: true });
  await panelTool.hover();
  assert.equal(await panelTool.evaluate((element) => getComputedStyle(element).transform), 'none', 'reduced motion removes hover displacement');
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  const toolStyle = await panelTool.evaluate((element) => {
    const style = getComputedStyle(element);
    return { transform: style.transform, shadow: style.boxShadow, border: style.borderTopWidth };
  });
  assert.deepEqual(toolStyle, { transform: 'none', shadow: 'none', border: '0px' }, 'workbench entries stay quiet on hover');

  for (const [size, width, height] of [['wide', 1440, 920], ['narrow', 980, 740], ['minimum', 980, 640]]) {
    await setWindowSize(width, height);
    for (const theme of ['light', 'dark']) {
      await page.evaluate((value) => { document.documentElement.dataset.theme = value; }, theme);
      await capture(`04-panel-${size}-${theme}`);
    }
  }
  await page.getByRole('button', { name: '收起右侧面板', exact: true }).click();
  await page.locator('.file-panel').waitFor({ state: 'detached' });
  const composerBounds = await page.locator('.composer').boundingBox();
  const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
  assert.ok(composerBounds && composerBounds.y >= 0 && composerBounds.y + composerBounds.height <= viewport.height + 1, 'composer remains inside the minimum-height window');
  await capture('05-chat-minimum-dark');
  await page.locator('.sidebar-bottom button[title="设置"]').click();
  await navigation.waitFor();
  await page.locator('.settings-content').getByRole('button', { name: '深色', exact: true }).click();
  const backBounds = await navigation.getByRole('button', { name: '返回对话', exact: true }).boundingBox();
  assert.ok(backBounds && backBounds.y >= 0 && backBounds.y + backBounds.height <= viewport.height + 1, 'settings back button stays visible at minimum height');
  await capture('06-settings-minimum-dark');
  assert.deepEqual(pageErrors, [], 'renderer has no uncaught errors');
  console.log(`Experience refresh QA passed; screenshots: ${output}`);
} catch (error) {
  if (page) await page.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {});
  throw error;
} finally {
  await writeFile(path.join(output, 'results.json'), JSON.stringify({ pageErrors, layouts: layoutResults }, null, 2));
  if (app) await app.close();
  await rm(profile, { recursive: true, force: true });
}
