import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MIN_WINDOW_SIZE } from '../../electron/main/core/window-bounds.cjs';
import { startChecklistModel } from './fixtures/checklist-model.mjs';
import { configureTestModel, launchTestDesktop } from './fixtures/isolated-desktop.mjs';
import { hideToolPanel, openPluginCatalog, openPluginTool, openToolPanel, resizeToolHost } from './fixtures/tool-panel.mjs';

const output = fileURLToPath(new URL('../../.qa/screenshots/typography/', import.meta.url));
const profile = await mkdtemp(path.join(tmpdir(), 'pi-studio-type-'));
const workspace = path.join(profile, '示例项目');
await Promise.all([mkdir(workspace), mkdir(output, { recursive: true })]);
const model = await startChecklistModel();
let app;

async function fontSize(locator) {
  await locator.waitFor({ state: 'visible' });
  return locator.evaluate(node => parseFloat(getComputedStyle(node).fontSize));
}

try {
  const desktop = await launchTestDesktop(workspace, profile, 1240, 840);
  app = desktop.app;
  const { page } = desktop;
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const capture = async name => {
    await page.mouse.move(2, 2);
    return page.screenshot({ path: path.join(output, name + '.png'), animations: 'disabled' });
  };
  const composer = page.getByRole('textbox', { name: '发送给 Pi 的消息' });
  const settings = page.locator('.settings-content');
  const openSettings = () => page.getByRole('button', { name: '设置', exact: true }).click();
  const back = () => page.keyboard.press('Escape');
  assert.equal(await fontSize(composer), 12);
  assert.equal(await fontSize(page.locator('.new-conversation-welcome h1')), 25);
  for (const selector of ['.sidebar-rail-button > svg', '.shell-panel-toggle > svg', '.composer-attach-button > svg']) {
    const { width, height } = await page.locator(selector).first().boundingBox();
    assert.deepEqual([width, height], [15, 15], selector);
  }

  await configureTestModel(page, workspace, model.baseUrl);
  await app.evaluate(({ dialog }, directory) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [directory] });
  }, workspace);
  await page.getByRole('button', { name: '打开工作区', exact: true }).click();
  await page.locator('.workspace-choice.has-selection').waitFor();
  await composer.fill('请检查示例项目 QA-DONE 的排版。');
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await model.reply('QA-DONE', 'finish', [
    '# 工作区排版', '同一段正文在聊天、消息编辑器和文件预览里使用相同的默认字号。',
    '## 阅读层级', '分组标题和说明各有自己的字号，工具栏里的时间与计数使用更小的一档。',
    '### 代码预览', '正文引用的文件名，例如 `README.md`，使用等宽字体。',
    '```text\n项目目录\n  README.md\n  src/\n```',
  ].join('\n\n'));
  const reply = page.locator('.assistant-response .markdown').last();
  const message = page.locator('.user-bubble').last();
  assert.equal(await fontSize(reply), 12);
  assert.equal(await fontSize(message), 12);
  for (const [selector, expected] of [['h1', 21], ['h2', 17], ['h3', 14], ['p code', 11], ['pre code', 11]]) {
    assert.equal(await fontSize(reply.locator(selector).first()), expected, selector);
  }
  await page.locator('.chat-scroll').evaluate(scroller => scroller.scrollTo({ top: 0, behavior: 'instant' }));
  await capture('conversation');

  await openSettings();
  for (const width of [1240, MIN_WINDOW_SIZE.width]) {
    await resizeToolHost(app, page, width, 840);
    await page.waitForFunction(width => innerWidth === width, width);
    for (const [selector, expected] of [
      ['.settings-page-header h1', 21], ['.preference-disclosure-heading', 14],
      ['.general-setting-label h3', 12], ['.general-setting-description', 11],
    ]) assert.equal(await fontSize(settings.locator(selector).first()), expected, selector);
    const navRow = page.locator('.settings-nav-row').first();
    assert.equal((await navRow.locator('svg').boundingBox()).width, 15);
    assert.ok((await navRow.boundingBox()).height >= 36);
    assert.equal((await settings.locator('.settings-page-header-icon > svg').boundingBox()).width, 21);
    assert.ok(await settings.evaluate(node => node.scrollWidth <= node.clientWidth + 1));
    await capture('settings-' + width);
  }

  const value = settings.getByRole('button', { name: /^字号：/ });
  await value.click();
  const input = settings.getByRole('textbox', { name: '字号数值' });
  await input.fill('18');
  await input.press('Enter');
  await back();
  assert.equal(await fontSize(composer), 18);
  assert.equal(await fontSize(reply), 18);
  assert.equal(await fontSize(message), 18);
  assert.equal(await fontSize(reply.locator('h2')), 23);
  assert.equal(await fontSize(reply.locator('pre code')), 17);
  await resizeToolHost(app, page, 1240, 840);
  await openSettings();
  assert.equal(await fontSize(settings.locator('.general-setting-label h3').first()), 12);
  await value.click();
  await input.fill('12');
  await input.press('Enter');
  await back();
  assert.equal(await fontSize(reply), 12);
  assert.equal(await page.evaluate(() => document.documentElement.style.getPropertyValue('--chat-font-size')), '');

  await page.getByRole('button', { name: '打开 防止电脑休眠 详情', exact: true }).click();
  const modes = page.getByRole('dialog', { name: '防止电脑休眠', exact: true });
  const modeFrame = modes.frameLocator('iframe');
  await modeFrame.locator('fieldset:enabled').waitFor();
  assert.equal(await fontSize(modeFrame.locator('label strong').first()), 12);
  assert.equal(await fontSize(modeFrame.locator('label small').first()), 11);
  await back();
  await modes.waitFor({ state: 'detached' });

  const tools = await openToolPanel(app, page);
  const tool = tools.locator('.tool-group:visible .tool-picker button').first();
  assert.equal(await fontSize(tool), 12);
  assert.equal((await tool.locator(':scope > :is(svg, img)').boundingBox()).width, 14);
  assert.equal(await fontSize(tools.locator('.tool-group:visible .tool-shortcut kbd').first()), 10);
  await hideToolPanel(page, tools);

  const navigation = page.getByRole('navigation', { name: '主导航' });
  for (const [name, selector] of [['计划', '.plans-heading h1'], ['团队', '.team-page h1']]) {
    await navigation.getByRole('button', { name: '更多', exact: true }).click();
    await navigation.getByRole('button', { name, exact: true }).click();
    assert.equal(await fontSize(page.locator(selector).first()), 21, name);
  }
  await openPluginCatalog(page);
  assert.equal(await fontSize(page.locator('.app-hub-heading h1')), 21);
  await page.getByRole('button', { name: '安装 任务看板', exact: true }).click();
  const install = page.getByRole('dialog', { name: '安装预览', exact: true });
  assert.equal(await fontSize(install.locator('h2').first()), 17);
  await install.getByRole('button', { name: '确认安装', exact: true }).click();
  await install.waitFor({ state: 'detached' });
  const details = page.getByRole('dialog', { name: '插件 任务看板' });
  await details.getByRole('button', { name: '关闭', exact: true }).click();
  await details.waitFor({ state: 'detached' });
  const board = await openPluginTool(app, page, '任务看板');
  const add = board.frame.locator('[data-action="new-task"]:enabled').first();
  assert.equal(await fontSize(add), 12);
  await add.click();
  const pickerIcon = board.frame.locator('.tb-select-trigger .tb-control-icon').first();
  await pickerIcon.waitFor();
  assert.equal((await pickerIcon.boundingBox()).width, 13);
  await board.page.evaluate(() => {
    document.documentElement.style.setProperty('--text-label', '16px');
    document.documentElement.style.setProperty('--icon-sm', '17px');
  });
  await board.frame.locator('html[style*="--text-label: 16px"]').waitFor({ state: 'attached' });
  assert.equal(await fontSize(board.frame.locator('.tb-select-trigger').first()), 16);
  assert.equal((await pickerIcon.boundingBox()).width, 17);
  console.log('Desktop typography passed at both widths, including Markdown, chat preferences and sandboxed plugin controls.');
} finally {
  await model.close();
  await app?.close();
  await rm(profile, { recursive: true, force: true });
}
