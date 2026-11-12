import { composerValue } from './fixtures/composer-editor.mjs';
/** Isolated production UI QA for archives, shortcut recording and context estimates. */
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { installPerformanceFixture } from './fixtures/performance.mjs';
import { installSettingsUtilitiesFixture } from './fixtures/settings-utilities.mjs';
import { serveProductionRenderer } from './fixtures/production-renderer-server.mjs';
const root = fileURLToPath(new URL('../..', import.meta.url)); const output = path.join(root, '.qa/settings-utilities'); await mkdir(output, { recursive: true });
const result = { checks: [], screenshots: [], pageErrors: [], blockedRequests: [], assets: (await readFile(path.join(root, 'web-dist/index.html'), 'utf8')).match(/assets\/[^"']+\.(?:js|css)/g) };
const server = await serveProductionRenderer(root); let browser; let page;
const nav = () => page.locator('.settings-navigation'); const composer = () => page.getByRole('textbox', { name: '发送给 Pi 的消息', exact: true });
const chip = () => page.locator('.context-usage-trigger'); const panel = () => page.getByRole('dialog', { name: '上下文用量', exact: true });
const row = id => page.locator(`.archive-session-card[data-session-id="${id}"]`);
async function settle() { await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))); }
async function qa(method, ...args) { await page.evaluate(({ method, args }) => window.__settingsUtilitiesQa[method](...args), { method, args }); await settle(); }
async function pending(method) { await page.waitForFunction(method => window.__settingsUtilitiesQa.pending(method) > 0, method); }
async function count(method) { return page.evaluate(method => window.__settingsUtilitiesQa.calls.filter(item => item.method === method).length, method); }
async function settings(route) { if (!await nav().count()) await page.locator('.sidebar-bottom button[title="设置"]').click(); await nav().getByRole('button', { name: route, exact: true }).click(); }
async function closeSettings() { await page.getByRole('button', { name: '返回对话', exact: true }).click(); await nav().waitFor({ state: 'detached' }); }
async function capture(name, theme) { await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme); await settle(); assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false); await page.screenshot({ path: path.join(output, `${name}.png`), animations: 'disabled' }); result.screenshots.push(name); }
try {
  browser = await chromium.launch({ executablePath: process.env.CHROME_BIN || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
  page = await browser.newPage({ viewport: { width: 980, height: 640 }, deviceScaleFactor: 2, reducedMotion: 'reduce' }); page.setDefaultTimeout(15000);
  page.on('pageerror', error => result.pageErrors.push(error.message));
  await page.route('**/*', route => { const url = route.request().url(); if (url.startsWith(server.origin) || /^(data|blob):/.test(url)) return route.continue(); result.blockedRequests.push(url); return route.abort(); });
  await page.addInitScript({ content: `(${installPerformanceFixture.toString()})({sessionCount:2,turnCount:4});(${installSettingsUtilitiesFixture.toString()})();` });
  await page.goto(server.origin); await page.locator('.session-row').filter({ hasText: '性能会话 0000' }).click(); await page.locator('.assistant-response').first().waitFor();
  const draft = '归档、快捷键与上下文检查期间保留我的草稿。'; await composer().fill(draft);
  await chip().filter({ hasText: '40%' }).waitFor(); await chip().focus(); await chip().press('Enter'); await panel().waitFor();
  assert.equal(await page.locator('.context-usage-panel [tabindex="-1"]').evaluate(node => node === document.activeElement), true);
  assert.equal(await chip().getAttribute('aria-controls'), await panel().getAttribute('id'));
  assert.match(await panel().innerText(), /40.0k \/ 100k/); assert.match(await panel().innerText(), /最近一次请求的估算/);
  await panel().evaluate(node => { node.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', isComposing: true, bubbles: true, cancelable: true })); node.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', keyCode: 229, bubbles: true, cancelable: true })); });
  assert.equal(await panel().count(), 1); await page.keyboard.press('Escape'); await panel().waitFor({ state: 'detached' }); assert.equal(await chip().evaluate(node => node === document.activeElement), true);
  await chip().press('Space'); await panel().waitFor(); await page.keyboard.press('Shift+Tab'); await panel().waitFor({ state: 'detached' }); assert.equal(await chip().evaluate(node => node === document.activeElement), true);
  await chip().press('ArrowDown'); await panel().waitFor(); await panel().getByRole('button', { name: '自动压缩设置', exact: true }).focus(); await page.keyboard.press('Tab'); await panel().waitFor({ state: 'detached' }); assert.equal(await page.evaluate(() => document.activeElement === document.body), false);
  await chip().click(); await panel().waitFor(); await composer().focus(); await panel().waitFor({ state: 'detached' }); assert.equal(await composer().evaluate(node => node === document.activeElement), true);
  await chip().click(); await capture('01-context-light', 'light'); await panel().getByRole('button', { name: '关闭上下文用量', exact: true }).click();
  await qa('hold', 'contextPolicy', 'qa/b'); await page.locator('.model-label').click(); await page.getByRole('menuitem').filter({ hasText: '切换会话模型' }).click(); await page.getByRole('menuitemradio', { name: 'Context B', exact: true }).click(); await pending('contextPolicy');
  assert.equal((await chip().innerText()).trim(), '—', 'old A window cannot survive a pending B model policy'); await qa('release', 'contextPolicy'); await chip().filter({ hasText: '20%' }).waitFor(); assert.equal(await composerValue(composer()), draft);
  await chip().click(); assert.match(await panel().innerText(), /40.0k \/ 200k/); await capture('02-context-dark', 'dark'); await panel().getByRole('button', { name: '立即压缩', exact: true }).click(); await page.getByText('QA 手动压缩失败，原会话内容保留', { exact: true }).waitFor(); assert.equal(await composerValue(composer()), draft); assert.equal(await count('conversationCompact'), 1);
  await qa('hold', 'contextPolicy', 'qa/a');
  await page.locator('.model-label').click(); await page.getByRole('menuitem').filter({ hasText: '切换会话模型' }).click(); await page.getByRole('menuitemradio', { name: 'Context A', exact: true }).click(); await pending('contextPolicy');
  await page.locator('.model-label').click(); await page.getByRole('menuitem').filter({ hasText: '切换会话模型' }).click(); await page.getByRole('menuitemradio', { name: 'Context B', exact: true }).click(); await chip().filter({ hasText: '20%' }).waitFor();
  await qa('release', 'contextPolicy'); assert.equal((await chip().innerText()).trim(), '20%', 'late A policy cannot replace active B denominator');
  result.checks.push('context estimates use one denominator; model switch pending hides stale window; nonmodal keyboard/IME/Escape/Tab/outside focus, manual failure preserves draft');

  await settings('归档会话'); const search = page.getByRole('searchbox', { name: '搜索归档会话', exact: true }); await search.waitFor(); assert.equal(await page.locator('.archive-session-card').count(), 126);
  await search.fill('needle 发布验证'); await row('arch-125').waitFor(); assert.equal(await page.locator('.archive-session-card').count(), 1);
  await capture('03-archives-light', 'light'); await search.fill('no-matches'); await page.getByText('没有匹配的归档会话', { exact: true }).waitFor(); await page.getByRole('button', { name: '清除搜索', exact: true }).click(); assert.equal(await search.inputValue(), '');
  await qa('fail', 'conversationAction'); await row('arch-0').getByRole('button', { name: '恢复会话', exact: true }).click(); await row('arch-0').getByRole('alert').waitFor(); assert.equal(await row('arch-0').count(), 1);
  await qa('hold', 'conversationAction', 'arch-0'); await row('arch-0').getByRole('button', { name: '恢复会话', exact: true }).click(); await pending('conversationAction');
  assert.equal(await row('arch-1').getByRole('button', { name: '恢复会话', exact: true }).isDisabled(), true); assert.equal(await count('conversationAction'), 2);
  await qa('release', 'conversationAction'); await row('arch-0').waitFor({ state: 'detached' }); await settle(); assert.equal(await page.evaluate(() => document.activeElement.closest('.archive-session-card')?.dataset.sessionId), 'arch-1');
  await row('arch-1').getByRole('button', { name: '永久删除', exact: true }).click(); const confirm = page.getByRole('alertdialog', { name: '永久删除这个归档会话？', exact: true }); await confirm.waitFor(); await confirm.getByRole('button', { name: '取消', exact: true }).click(); assert.equal(await count('conversationAction'), 2); assert.equal(await row('arch-1').count(), 1);
  await row('arch-1').getByRole('button', { name: '永久删除', exact: true }).click(); await confirm.getByRole('button', { name: '永久删除', exact: true }).click(); await row('arch-1').waitFor({ state: 'detached' });
  await qa('fail', 'state'); await row('arch-2').getByRole('button', { name: '恢复会话', exact: true }).click(); await page.locator('.conversation-list-notice').waitFor();
  const writes = await count('conversationAction'); assert.equal(await row('arch-2').getByRole('button', { name: '恢复会话', exact: true }).isDisabled(), true); await page.getByRole('button', { name: '刷新会话列表', exact: true }).click(); await row('arch-2').waitFor({ state: 'detached' }); assert.equal(await count('conversationAction'), writes, 'successful write plus failed projection retries only a read');
  await search.fill('发布验证'); await capture('04-archives-dark', 'dark');
  result.checks.push('126 archived sessions/two workspaces searchable by title and workspace, empty clear, restore error/retry and lock, delete confirmation/cancel, removed-row focus, successful mutation failed state read only retry');

  await settings('快捷键'); const shortcut = label => page.locator('.shortcut-row').filter({ has: page.locator('strong', { hasText: new RegExp(`^${label}$`) }) }).locator('.shortcut-key'); const palette = shortcut('命令面板');
  await page.getByRole('heading', { name: '快捷键', exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: '恢复默认', exact: true }).count(), 0, 'no-op reset is hidden while every binding is default');
  const initial = await page.evaluate(() => localStorage.getItem('pi-studio:preferences')); await palette.click(); assert.equal(await palette.getAttribute('aria-pressed'), 'true');
  await palette.evaluate(node => { node.dispatchEvent(new KeyboardEvent('keydown', { key: 'q', metaKey: true, isComposing: true, bubbles: true, cancelable: true })); node.dispatchEvent(new KeyboardEvent('keydown', { key: 'q', metaKey: true, keyCode: 229, bubbles: true, cancelable: true })); });
  assert.equal(await page.evaluate(() => localStorage.getItem('pi-studio:preferences')), initial); assert.equal(await palette.getAttribute('aria-pressed'), 'true');
  await page.keyboard.press('Meta+,'); await page.locator('.shortcut-conflict').waitFor(); assert.equal(await palette.getAttribute('aria-pressed'), 'true'); assert.equal(await page.evaluate(() => localStorage.getItem('pi-studio:preferences')), initial);
  await page.keyboard.press('Tab'); assert.equal(await palette.getAttribute('aria-pressed'), 'false'); assert.equal(await shortcut('打开设置').evaluate(node => node === document.activeElement), true);
  await palette.click(); await page.keyboard.press('Escape'); assert.equal(await palette.getAttribute('aria-pressed'), 'false');
  await palette.click(); await page.keyboard.press('Meta+Alt+P'); await page.waitForFunction(() => JSON.parse(localStorage.getItem('pi-studio:preferences')).shortcuts.palette === 'Mod+Alt+P');
  await palette.click(); await page.getByRole('heading', { name: '快捷键', exact: true }).click(); assert.equal(await palette.getAttribute('aria-pressed'), 'false');
  await page.getByRole('button', { name: '恢复默认', exact: true }).waitFor();
  await capture('05-shortcuts-light', 'light'); await page.getByRole('button', { name: '恢复默认', exact: true }).click(); await page.waitForFunction(() => JSON.parse(localStorage.getItem('pi-studio:preferences')).shortcuts.palette === 'Mod+K'); assert.equal(await page.getByRole('button', { name: '恢复默认', exact: true }).count(), 0, 'reset disappears again after defaults are restored'); await capture('06-shortcuts-dark', 'dark');
  await closeSettings(); assert.equal(await composerValue(composer()), draft);
  result.checks.push('shortcut capture ignores IME/229, conflict never changes binding or triggers shell navigation, Tab cancels naturally, Escape/pointer cancel, valid combo persists, reset defaults and main draft preserved');
  // An old archive completion must not supersede an already-started native navigation.
  await qa('open', 'perf-1'); await page.locator('.chat-heading h1').filter({ hasText: '性能会话 0001' }).waitFor();
  const draftB = 'B 在旧会话归档完成后仍保留的草稿'; await composer().fill(draftB);
  await qa('open', 'perf-0'); await page.locator('.chat-heading h1').filter({ hasText: '性能会话 0000' }).waitFor(); assert.equal(await composerValue(composer()), draft);
  await qa('expireTranscriptCache'); await qa('hold', 'conversationAction', 'perf-0');
  await page.locator('.session-row-shell[data-session-id="perf-0"]').hover(); await page.getByRole('button', { name: '归档会话：性能会话 0000', exact: true }).click();
  const archiveConfirm = page.getByRole('dialog', { name: '归档这个会话？', exact: true }).or(page.getByRole('alertdialog', { name: '归档这个会话？', exact: true }));
  await archiveConfirm.getByRole('button', { name: '归档会话', exact: true }).click(); await pending('conversationAction');
  await qa('hold', 'conversationPage', 'perf-1'); await qa('open', 'perf-1'); await pending('conversationPage');
  await qa('release', 'conversationAction'); await page.locator('.session-row-shell[data-session-id="perf-0"]').waitFor({ state: 'detached' });
  assert.equal(await page.getByRole('heading', { name: '开始一个新会话', exact: true }).count(), 0, 'old archive cannot start a new draft during target read');
  await qa('release', 'conversationPage'); await page.locator('.chat-heading h1').filter({ hasText: '性能会话 0001' }).waitFor(); assert.equal(await composerValue(composer()), draftB);
  result.checks.push('pending A archive + native B navigation with held history cannot start a new draft; B becomes active after read and retains its draft');
  assert.deepEqual(result.pageErrors, []); assert.deepEqual(result.blockedRequests, []); assert.equal(await count('conversationSubmit'), 0); result.calls = await page.evaluate(() => window.__settingsUtilitiesQa.calls); await rm(path.join(output, 'failure.png'), { force: true });
} catch (error) { result.error = error.stack; if (page) await page.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {}); throw error; }
finally { await writeFile(path.join(output, 'results.json'), `${JSON.stringify(result, null, 2)}\n`); await browser?.close(); await server.close(); }
console.log(JSON.stringify({ output, checks: result.checks, screenshots: result.screenshots }, null, 2));
