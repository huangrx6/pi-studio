/** Full production app: hidden workspaces cannot paint or take focus under settings. */
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { serveProductionRenderer } from './fixtures/production-renderer-server.mjs';
import { installPerformanceFixture } from './fixtures/performance.mjs';
import { installPanelFilesFixture } from './fixtures/panel-files.mjs';
import { installSettingsIsolationFixture } from './fixtures/settings-isolation.mjs';

const output = new URL('../../.qa/settings-isolation/', import.meta.url);
await mkdir(output, { recursive: true });
const server = await serveProductionRenderer(fileURLToPath(new URL('../..', import.meta.url)));
const result = { checks: [], errors: [] };
let browser;
try {
  browser = await chromium.launch({ executablePath: process.env.CHROME_BIN || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 }, reducedMotion: 'reduce' });
  page.setDefaultTimeout(10_000);
  page.on('pageerror', error => result.errors.push(error.message));
  await page.route('**/*', route => route.request().url().startsWith(server.origin) ? route.continue() : route.abort());
  await page.addInitScript({ content: `(${installPerformanceFixture})({sessionCount:2,turnCount:4});(${installPanelFilesFixture})();(${installSettingsIsolationFixture})();` });
  await page.goto(server.origin);
  await page.locator('.session-row').first().click();
  await page.locator('.assistant-response').first().waitFor();
  const settings = page.locator('.settings-overlay');
  const nav = settings.locator('.settings-navigation');
  const workspace = page.locator('.app > .content-region');
  async function check(name, selector, keyboard = false) {
    const surface = workspace.locator(selector).first();
    await surface.waitFor();
    const handle = await surface.elementHandle();
    const before = await page.evaluate(() => ({ ...window.__settingsIsolationQa }));
    if (keyboard) await page.keyboard.press('ControlOrMeta+,');
    else await page.locator('.sidebar-bottom button[title="设置"]').click();
    await settings.waitFor();
    assert.equal(await page.getByRole('listbox').count(), 0, `${name}: workspace menus close before interacting with settings`);
    assert.equal(await page.getByRole('menu').count(), 0, `${name}: workspace action menus close before interacting with settings`);
    await nav.getByRole('button', { name: '模型配置', exact: true }).click();
    await settings.getByRole('heading', { name: '模型配置', exact: true }).waitFor();
    assert.equal(await page.getByRole('listbox').count(), 0, `${name}: workspace menus close on entry`);
    assert.equal(await handle.evaluate(node => node.isConnected), true, `${name}: workspace remains mounted`);
    const leaking = await workspace.evaluate(root => [root, ...root.querySelectorAll('*')]
      .filter(node => node.checkVisibility({ checkVisibilityCSS: true, checkOpacity: true })).map(node => node.className).slice(0, 8));
    assert.deepEqual(leaking, [], `${name}: no descendants may restore visibility`);
    await handle.evaluate(node => node.querySelector('button,input,textarea,[tabindex]')?.focus());
    assert.equal(await workspace.evaluate(root => root.contains(document.activeElement)), false, `${name}: hidden controls cannot take focus`);
    for (const label of ['快捷键', '模型配置']) {
      await nav.getByRole('button', { name: label, exact: true }).click();
      assert.equal(await surface.isVisible(), false, `${name}: hidden across settings routes`);
    }
    if (name === 'subagent-graph' || name === 'terminal') await page.screenshot({ path: fileURLToPath(new URL(`${name}-settings.png`, output)) });
    await nav.getByRole('button', { name: '返回对话', exact: true }).click();
    await settings.waitFor({ state: 'detached' });
    await surface.waitFor();
    assert.equal(await handle.evaluate(node => node.isConnected && node.checkVisibility()), true, `${name}: same surface restored`);
    const after = await page.evaluate(() => ({ ...window.__settingsIsolationQa }));
    assert.equal(after.terminalCreates, before.terminalCreates, `${name}: settings must not restart a terminal`);
    assert.equal(after.terminalCloses, before.terminalCloses);
    result.checks.push(name);
    console.log(`verified: ${name}`);
    await handle.dispose();
  }
  const progress = async () => page.getByRole('button', { name: '进展', exact: true }).click();
  await check('conversation', '.assistant-response');
  await page.locator('.session-row-shell').first().hover();
  await page.locator('.session-row-shell').first().locator('.sidebar-row-actions button').first().click();
  await check('sidebar-menu', '.assistant-response', true);
  await progress();
  await page.getByRole('button', { name: '查看全部子智能体', exact: true }).click();
  await check('subagent-list', '.agent-list');
  await page.getByRole('button', { name: '流程图视图', exact: true }).click();
  await workspace.locator('.react-flow__node').first().waitFor();
  if (process.argv.includes('--reproduce-old-rule')) {
    await page.addStyleTag({ content: '.app:has(> .settings-overlay) > .content-region { display: grid; visibility: hidden; pointer-events: none; } .app:has(> .settings-overlay) > .sidebar { display: flex; visibility: hidden; pointer-events: none; }' });
  }
  await check('subagent-graph', '.react-flow__node');
  await page.getByRole('button', { name: '列表视图', exact: true }).click();
  await workspace.locator('.agent-list').getByRole('button').first().click();
  await check('subagent-transcript', '.agent-transcript');
  await progress();
  await page.getByRole('button', { name: '查看全部任务', exact: true }).click();
  await page.getByRole('button', { name: '筛选任务状态', exact: true }).click();
  await check('tasks', '.session-tasks-page', true);
  async function tool(label) {
    await page.getByRole('button', { name: '打开工具', exact: true }).click();
    await page.getByRole('menuitem', { name: label, exact: true }).click();
  }
  await tool('Git');
  await check('git', '.git-workspace-page');
  await page.locator('.chat-header').getByRole('button', { name: '扩展', exact: true }).click();
  await page.getByRole('dialog', { name: '扩展', exact: true }).getByRole('button', { name: /^查看 .* 详情$/ }).first().click();
  await check('extensions', '.extension-workbench-panel');
  await page.locator('.chat-header').getByRole('button', { name: '轨迹', exact: true }).click();
  await check('trace', '.conversation-trace-page');
  await tool('工作区文件');
  await check('files', '.panel-file-browser');
  await page.locator('.file-row').filter({ hasText: 'shared.txt' }).click();
  await check('file-preview', '.panel-file-preview');
  await tool('新建终端');
  await page.locator('.terminal-panel').getByText('运行中', { exact: true }).waitFor();
  await check('terminal', '.terminal-panel');
  await page.locator('.panel-tab').filter({ hasText: '终端' }).click({ button: 'right' });
  await check('panel-context-menu', '.terminal-panel', true);
  await page.locator('.xterm-helper-textarea').focus();
  await page.keyboard.type('echo retained');
  await page.waitForFunction(() => window.__settingsIsolationQa.terminalWrites.map(row => row.data).join('').includes('echo retained'));
  await tool('浏览器');
  await check('browser', '.browser-panel', true);
  await tool('运行服务');
  await check('services', '.runtime-services-panel');
  assert.deepEqual(result.errors, []);
  console.log(JSON.stringify(result));
} finally {
  await writeFile(new URL('results.json', output), JSON.stringify(result, null, 2));
  await browser?.close();
  await server.close();
}
