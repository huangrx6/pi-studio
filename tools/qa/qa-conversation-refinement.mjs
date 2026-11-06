/** Production-renderer QA with isolated browser-only history fixtures.
 * Run after the central build: node tools/qa/qa-conversation-refinement.mjs
 * Owns its HTTP server and browser; never reads real userData or calls a model.
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { installConversationFixture } from './fixtures/conversation-refinement.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));
const dist = path.join(root, 'web-dist');
const output = path.join(root, '.qa', 'conversation-refinement');
await mkdir(output, { recursive: true });
const result = { pageErrors: [], screenshots: [], checks: [], fixtureSessions: 125 };
const loadedResources = new Set();
const server = createServer(async (request, response) => {
  try {
    const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
    const file = path.resolve(dist, `.${pathname === '/' ? '/index.html' : pathname}`);
    if (!file.startsWith(`${dist}${path.sep}`)) { response.writeHead(403).end(); return; }
    const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' };
    response.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream' });
    response.end(await readFile(file));
  } catch { response.writeHead(404).end(); }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
let browser;
let page;
async function capture(name) {
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false, `${name}: no horizontal page overflow`);
  await page.screenshot({ path: path.join(output, `${name}.png`), animations: 'disabled' });
  result.screenshots.push(name);
}
async function focused(locator) {
  await page.waitForFunction((element) => document.activeElement === element, await locator.elementHandle());
}
try {
  browser = await chromium.launch({ executablePath: process.env.CHROME_BIN || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
  page = await browser.newPage({ viewport: { width: 1440, height: 920 }, deviceScaleFactor: 2 });
  page.setDefaultTimeout(15_000);
  page.on('pageerror', (error) => result.pageErrors.push(error.message));
  await page.route('**/*', (route) => route.request().url().startsWith(origin) || /^(data|blob):/.test(route.request().url()) ? route.continue() : route.abort());
  page.on('request', (request) => {
    const url = request.url();
    if (url.startsWith(origin)) loadedResources.add(decodeURIComponent(url.split('/').at(-1)));
  });
  await page.addInitScript(installConversationFixture);
  await page.goto(origin);
  await page.locator('.workspace-row').first().waitFor();
  const searchTrigger = page.getByRole('button', { name: '搜索工作区', exact: true });
  const search = page.getByRole('searchbox', { name: '搜索工作区或会话', exact: true });
  const rowTitles = page.locator('.session-row:not(.empty) .session-title');
  const sessionRow = (title) => page.locator('.session-row').filter({ has: page.locator('.session-title').filter({ hasText: title }) });
  const composer = page.getByRole('textbox', { name: '发送给 Pi 的消息', exact: true });
  await searchTrigger.click();
  await search.fill('精准目标');
  await sessionRow('精准目标：组件可读性审查').waitFor();
  assert.deepEqual(await rowTitles.allTextContents(), ['精准目标：组件可读性审查'], 'search is precise across 120+ history entries');
  await page.mouse.move(1000, 100);
  const rendererPrefetch = page.waitForRequest((request) =>
    decodeURIComponent(request.url().split('/').at(-1) || '').startsWith('MarkdownRenderer-'));
  await sessionRow('精准目标：组件可读性审查').hover();
  await rendererPrefetch;
  await sessionRow('精准目标：组件可读性审查').click();
  await page.locator('.assistant-response').filter({ hasText: '审查已完成' }).waitFor();
  assert.equal([...loadedResources].some((file) => file?.startsWith('markdown-highlighter-')), false, 'code-free history does not load the syntax highlighter');
  const draft = '筛选和查看记录时，请保留这段草稿。';
  await composer.fill(draft);
  await search.fill('归档专属关键词');
  await page.getByText('没有匹配的会话', { exact: true }).waitFor();
  assert.equal(await rowTitles.count(), 0, 'archived history is excluded from search');
  await search.fill('Beta');
  await sessionRow('文档核对').waitFor();
  assert.deepEqual(await rowTitles.allTextContents(), ['文档核对'], 'workspace name search keeps matching workspace sessions');
  await search.fill('/qa/workspaces/beta');
  assert.deepEqual(await rowTitles.allTextContents(), ['文档核对'], 'workspace paths remain searchable');
  await search.press('Escape');
  assert.equal(await search.inputValue(), '');
  await focused(search);
  const filter = page.getByRole('button', { name: '会话筛选', exact: true });
  const chooseFilter = async (name) => { await filter.click(); await page.getByRole('option', { name, exact: true }).click(); };
  await chooseFilter('运行中');
  await sessionRow('运行中的构建检查').waitFor();
  assert.deepEqual(await rowTitles.allTextContents(), ['运行中的构建检查']);
  const runningRow = page.locator('.session-row').filter({ hasText: '运行中的构建检查' });
  await page.mouse.move(1000, 100);
  await runningRow.locator('.session-running').waitFor();
  assert.equal(await runningRow.getByRole('status', { name: '会话正在运行' }).count(), 1);
  assert.equal(await runningRow.locator('.session-time').count(), 0, 'running state takes precedence over time');
  assert.equal(await runningRow.locator('.session-pin-mark').count(), 0, 'running state takes precedence over the pinned badge');
  assert.match(await runningRow.getAttribute('title'), /已置顶/, 'the pinned detail remains available on hover');
  await capture('01-running-filter');
  await chooseFilter('已置顶');
  assert.deepEqual((await rowTitles.allTextContents()).sort(), ['已置顶的发布清单', '运行中的构建检查'].sort());
  await search.fill('不存在的会话');
  await page.getByText('没有匹配的会话', { exact: true }).waitFor();
  await capture('02-filter-empty');
  await page.getByRole('button', { name: '清除筛选', exact: true }).click();
  assert.equal(await search.inputValue(), '');
  assert.match(await filter.innerText(), /全部会话/);
  assert.equal(await composer.inputValue(), draft, 'search and filter do not replace the active conversation or draft');
  result.checks.push('hover preloads Markdown, precise search, workspace/path search, archive exclusion, running/pinned filters, combined empty state, draft preservation');

  await chooseFilter('运行中');
  await search.focus();
  await search.press('Escape');
  assert.match(await filter.innerText(), /全部会话/);
  await search.press('Escape');
  await search.waitFor({ state: 'detached' });
  await focused(searchTrigger);
  const expansionBefore = await page.locator('.workspace-row').evaluateAll((rows) => rows.map((row) => [row.textContent, row.getAttribute('aria-expanded')]));
  await searchTrigger.click();
  await search.fill('Beta');
  await sessionRow('文档核对').waitFor();
  await page.locator('.workspace-row').click();
  assert.equal(await rowTitles.count(), 0, 'matching groups can still be manually collapsed');
  await search.press('Escape');
  await search.press('Escape');
  await search.waitFor({ state: 'detached' });
  assert.deepEqual(await page.locator('.workspace-row').evaluateAll((rows) => rows.map((row) => [row.textContent, row.getAttribute('aria-expanded')])), expansionBefore, 'search leaves the saved workspace expansion state unchanged');
  await searchTrigger.click();
  await search.fill('精准目标');
  const shell = page.locator('.session-row-shell').filter({ has: page.locator('.session-title', { hasText: '精准目标' }) });
  const trigger = page.getByRole('button', { name: '精准目标：组件可读性审查的更多操作', exact: true });
  await shell.hover();
  await trigger.focus();
  await trigger.press('ArrowDown');
  const menu = page.getByRole('menu', { name: '精准目标：组件可读性审查的操作', exact: true });
  const items = menu.getByRole('menuitem');
  await menu.waitFor();
  await focused(items.first());
  await page.keyboard.press('ArrowUp');
  await focused(items.last());
  await page.keyboard.press('ArrowDown');
  await focused(items.first());
  await page.keyboard.press('End');
  await focused(items.last());
  await page.keyboard.press('Home');
  await focused(items.first());
  await page.keyboard.press('Escape');
  await menu.waitFor({ state: 'detached' });
  await focused(trigger);
  await trigger.press('ArrowUp');
  await menu.waitFor();
  await focused(items.last());
  await page.keyboard.press('Home');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => window.__conversationQa.calls.some((call) => call.id === 'history' && call.action === 'pin'));
  await menu.waitFor({ state: 'detached' });
  await focused(trigger);
  await trigger.press('Enter');
  await menu.waitFor();
  await menu.getByRole('menuitem', { name: '重命名', exact: true }).click();
  const renameDialog = page.getByRole('dialog', { name: '重命名会话', exact: true });
  await renameDialog.waitFor();
  await renameDialog.getByRole('button', { name: '取消', exact: true }).click();
  await renameDialog.waitFor({ state: 'detached' });
  await focused(trigger);
  await page.waitForFunction((element) => !element.classList.contains('is-open'), await shell.locator('.sidebar-row-actions').elementHandle());
  await search.focus();
  await page.mouse.move(1000, 100);
  assert.equal(await shell.locator('.sidebar-row-actions').evaluate((element) => getComputedStyle(element).visibility), 'hidden', 'after returning focus, moving away hides the row actions again');
  await shell.hover();
  await trigger.focus();
  await trigger.press('Enter');
  await menu.getByRole('menuitem', { name: '重命名', exact: true }).click();
  await renameDialog.getByRole('button', { name: '保存', exact: true }).click();
  await renameDialog.waitFor({ state: 'detached' });
  await focused(trigger);
  await trigger.press('Enter');
  await menu.waitFor();
  await page.evaluate(() => document.querySelector('.chat-scroll')?.dispatchEvent(new Event('scroll')));
  assert.equal(await menu.count(), 1, 'transcript streaming scroll does not dismiss the menu');
  await capture('03-keyboard-menu');
  await page.evaluate(() => document.querySelector('.sidebar')?.dispatchEvent(new Event('scroll')));
  await menu.waitFor({ state: 'detached' });
  await focused(trigger);
  await trigger.press('Space');
  await menu.waitFor();
  await page.keyboard.press('Tab');
  await menu.waitFor({ state: 'detached' });
  await focused(page.getByRole('button', { name: '归档会话：精准目标：组件可读性审查', exact: true }));
  await trigger.focus();
  await trigger.press('Enter');
  await menu.waitFor();
  await page.keyboard.press('Shift+Tab');
  await menu.waitFor({ state: 'detached' });
  await focused(shell.locator('.session-row'));
  result.checks.push('menu Arrow/Home/End loop, Escape, Space/Enter, pin callback and focus restoration, scroll dismissal, Tab exit');

  const trace = page.locator('.turn-trace-toggle').first();
  assert.equal(await trace.getAttribute('aria-expanded'), 'false');
  assert.equal(await page.locator('.activity-tool').count(), 0, 'completed trace does not mount child tool components before first expansion');
  await trace.click();
  await page.locator('.activity-tool').first().waitFor();
  assert.equal(await page.locator('.activity-tool-body').count(), 0, 'standard tools do not mount large output while closed');
  assert.equal(await page.locator('.activity-thinking-body').count(), 0, 'closed thinking does not mount markdown');
  const tool = page.locator('.activity-tool').first();
  assert.equal(await tool.locator('summary').getAttribute('aria-description'), '已完成');
  assert.equal(await tool.locator('.activity-tool-status').count(), 0, 'success state avoids a repeated visual completion label');
  await page.locator('.activity-tool.is-error').getByText('失败', { exact: true }).waitFor();
  await page.locator('.turn-trace-errors').filter({ hasText: '1 次异常' }).waitFor();
  const gallery = page.locator('.tool-result-images').first();
  assert.equal(await gallery.locator('.conversation-image-tile').count(), 1, 'image results remain separate from closed parameter details');
  await tool.locator('summary').click();
  await tool.locator('.activity-tool-body').waitFor();
  assert.match(await tool.locator('.activity-tool-body').innerText(), /QA_TOOL_OUTPUT_0/);
  await tool.locator('summary').click();
  await tool.locator('.activity-tool-body').waitFor({ state: 'detached' });
  assert.equal(await gallery.locator('.conversation-image-tile').count(), 1);
  const thinking = page.locator('.activity-thinking').first();
  await thinking.locator('summary').click();
  await thinking.locator('.activity-thinking-body strong').filter({ hasText: '完整决策正文' }).waitFor();
  await thinking.locator('summary').click();
  await thinking.locator('.activity-thinking-body').waitFor({ state: 'detached' });
  await tool.locator('summary').click();
  await tool.locator('.activity-tool-body').waitFor();
  await trace.click();
  assert.equal(await page.locator('.activity-tool').count(), 10, 'visited trace preserves child state when folded');
  await trace.click();
  assert.equal(await tool.getAttribute('open'), '', 'manual tool expansion survives whole-trace folding');
  await tool.locator('summary').click();
  await page.setViewportSize({ width: 980, height: 640 });
  await capture('04-trace-expanded-light');
  await page.locator('.turn-trace-collapse').click();
  await focused(trace);
  assert.equal(await trace.getAttribute('aria-expanded'), 'false');
  await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
  await capture('05-trace-collapsed-dark');
  assert.equal(await composer.inputValue(), draft);
  result.checks.push('lazy trace/tool/thinking bodies, independent result image, accessible success/error states, preserved manual expansion, bottom collapse focus');

  const settingsTrigger = page.locator('.sidebar-bottom button[title="设置"]');
  await settingsTrigger.click();
  const settingsSearch = page.getByRole('searchbox', { name: '搜索设置', exact: true });
  await settingsSearch.fill('API');
  await settingsSearch.press('Escape');
  assert.equal(await settingsSearch.inputValue(), '', 'first Escape clears settings search');
  await focused(settingsSearch);
  await settingsSearch.press('Escape');
  await page.locator('.settings-navigation').waitFor({ state: 'detached' });
  await focused(settingsTrigger);
  assert.equal(await composer.inputValue(), draft, 'settings Escape return preserves the current draft');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await trace.click();
  await search.fill('');
  await chooseFilter('运行中');
  await page.mouse.move(1000, 100);
  await page.locator('.session-running .spin').waitFor();
  const motion = await page.evaluate(() => ({
    chevron: getComputedStyle(document.querySelector('.turn-trace-chevron')).transitionDuration,
    details: getComputedStyle(document.querySelector('.activity-tool'), '::details-content').transitionDuration,
    spinners: [...document.querySelectorAll('.spin')].map((element) => getComputedStyle(element).animationName),
  }));
  assert.equal(motion.chevron, '0s');
  assert.equal(motion.details, '0s');
  assert.ok(motion.spinners.length > 0, 'reduced-motion check observes a real running-state spinner');
  assert.ok(motion.spinners.every((animation) => animation === 'none'));
  result.reducedMotion = motion;
  result.checks.push('settings Escape clear/return with focus and draft preserved, reduced-motion disables trace transitions and spinners');
  assert.deepEqual(result.pageErrors, []);
  console.log(`Conversation refinement QA passed: ${result.checks.length} groups; screenshots: ${output}`);
} catch (error) {
  if (page) {
    await page.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {});
    result.failure = await page.evaluate(() => ({
      focusedElement: document.activeElement?.outerHTML.slice(0, 500),
      actionVisibility: [...document.querySelectorAll('.session-row-shell .sidebar-row-actions')].map((element) => ({ className: element.className, visibility: getComputedStyle(element).visibility })),
    })).catch(() => null);
  }
  throw error;
} finally {
  await writeFile(path.join(output, 'results.json'), JSON.stringify(result, null, 2));
  if (browser) await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
