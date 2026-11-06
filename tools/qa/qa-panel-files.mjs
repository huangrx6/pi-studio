/** Production renderer QA: scoped files, bounded cache, late reads and local recovery. */
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { installPerformanceFixture } from './fixtures/performance.mjs';
import { installPanelFilesFixture } from './fixtures/panel-files.mjs';
import { serveProductionRenderer } from './fixtures/production-renderer-server.mjs';
const root = fileURLToPath(new URL('../..', import.meta.url));
const cacheBytesOnly = process.argv.includes('--cache-bytes-only');
const output = path.join(root, cacheBytesOnly ? '.qa/panel-file-bytes' : '.qa/panel-files'); await mkdir(output, { recursive: true });
const result = { checks: [], screenshots: [], pageErrors: [], blockedRequests: [], assets: (await readFile(path.join(root, 'web-dist/index.html'), 'utf8')).match(/assets\/[^"']+\.(?:js|css)/g) };
const server = await serveProductionRenderer(root); let browser, page;
const tab = name => page.locator('.panel-tab').filter({ has: page.locator('.panel-tab-label', { hasText: new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`) }) });
const preview = () => page.locator('.panel-file-preview');
const composer = () => page.getByRole('textbox', { name: '发送给 Pi 的消息', exact: true });
async function settle() { await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))); }
async function qa(method, ...args) { await page.evaluate(({ method, args }) => window.__panelFilesQa[method](...args), { method, args }); await settle(); }
async function calls(method, owner, file) { return page.evaluate(({ method, owner, file }) => window.__panelFilesQa.calls.filter(item => item.method === method && (!owner || item.cwd === window.__panelFilesQa.roots[owner]) && (file === undefined || item.path === file)), { method, owner, file }); }
async function held(method, owner, file = '') {
  await page.waitForFunction(({ method, owner, file }) => window.__panelFilesQa.pending().some(item => item.method === method && item.cwd === window.__panelFilesQa.roots[owner] && item.path === file), { method, owner, file });
  return page.evaluate(({ method, owner, file }) => window.__panelFilesQa.pending().find(item => item.method === method && item.cwd === window.__panelFilesQa.roots[owner] && item.path === file).id, { method, owner, file });
}
async function openSession(owner) { await qa('open', owner); await page.locator('.chat-heading h1').filter({ hasText: `文件会话 ${owner.toUpperCase()}` }).waitFor(); }
async function tree() {
  if (await tab('文件').count()) await tab('文件').click();
  else if (await page.getByRole('button', { name: '打开工具', exact: true }).count()) {
    await page.getByRole('button', { name: '打开工具', exact: true }).click(); await page.getByRole('menuitem', { name: '工作区文件', exact: true }).click();
  } else await page.locator('.panel-start').getByRole('button', { name: '工作区文件', exact: true }).click();
  await page.locator('.panel-file-browser').waitFor();
}
async function openFile(file) { await tree(); await page.locator('.file-row').filter({ has: page.locator('span', { hasText: new RegExp(`^${file.replace('.', '\\.')}$`) }) }).click(); }
async function expectFile(owner, file, version = 1) { await preview().filter({ hasText: `WORKSPACE ${owner.toUpperCase()} · ${file} · version ${version}` }).waitFor(); }
async function closeFile(file, nth = 0) { await tab(file).nth(nth).getByRole('button', { name: `关闭 ${file}`, exact: true }).click(); }
async function capture(name, theme) {
  await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme); await settle();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
  await page.screenshot({ path: path.join(output, `${name}.png`), animations: 'disabled' }); result.screenshots.push(name);
}
async function checkCacheBytes() {
  const mib = 1024 * 1024;
  await qa('payload', 'a', 'budget-large.txt', 17 * mib);
  for (let i = 0; i < 3; i++) await qa('payload', 'a', `budget-${i}.txt`, 6 * mib);
  await openFile('shared.txt'); await expectFile('a', 'shared.txt');
  await openFile('budget-large.txt'); await expectFile('a', 'budget-large.txt');
  const complete = 'WORKSPACE A · budget-large.txt · version 1\n\nThis is isolated synthetic file content.\n原始工作区：/qa/synthetic/workspace-a\nEND OF COMPLETE A budget-large.txt';
  assert.equal(await preview().locator('.file-preview-code code').textContent(), complete, 'accepted oversized result displays its complete text, including the end sentinel');
  assert.equal(await preview().locator('img,video,audio,iframe').count(), 0, 'synthetic retained dataUrl must never invoke a media decoder');
  await tab('shared.txt').click(); await expectFile('a', 'shared.txt'); assert.equal((await calls('filePreview', 'a', 'shared.txt')).length, 1);
  await tab('budget-large.txt').click(); await expectFile('a', 'budget-large.txt');
  assert.equal((await calls('filePreview', 'a', 'budget-large.txt')).length, 2, 'oversized result is reread after leaving its tab');
  assert.equal(await preview().locator('.file-preview-code code').textContent(), complete);
  await capture('01-oversized-complete-light', 'light');
  await tab('shared.txt').click(); await expectFile('a', 'shared.txt'); assert.equal((await calls('filePreview', 'a', 'shared.txt')).length, 1, 'oversized entries do not flush unrelated small caches');
  await closeFile('budget-large.txt');
  result.checks.push('17 Mi-character retained dataUrl exceeds 32 MiB UTF16 estimate; current result shows complete text, no decoder mounted, returning rereads while unrelated small cache survives');
  await openFile('budget-0.txt'); await expectFile('a', 'budget-0.txt');
  await openFile('budget-1.txt'); await expectFile('a', 'budget-1.txt');
  await tab('budget-0.txt').click(); await expectFile('a', 'budget-0.txt');
  await openFile('budget-2.txt'); await expectFile('a', 'budget-2.txt');
  assert.ok(await page.locator('.panel-tab').count() < 8, 'eviction is caused by bytes, not the item cap');
  for (let i = 0; i < 3; i++) assert.equal(await tab(`budget-${i}.txt`).count(), 1, 'byte eviction retains every open tab');
  await tab('budget-0.txt').click(); await expectFile('a', 'budget-0.txt'); assert.equal((await calls('filePreview', 'a', 'budget-0.txt')).length, 1, 'recently touched entry survives byte LRU');
  await openSession('b'); await tab('budget-1.txt').click(); await expectFile('a', 'budget-1.txt');
  assert.equal((await calls('filePreview', 'a', 'budget-1.txt')).length, 2, 'least recently used byte-heavy entry rereads its original A workspace');
  assert.equal((await calls('filePreview', 'b', 'budget-1.txt')).length, 0);
  await capture('02-byte-lru-owner-dark', 'dark');
  result.checks.push('three 6 Mi-character payloads cross byte budget below eight tabs; touched entry stays cached, oldest reloads from original A cwd under B, no tab lost');
}
try {
  browser = await chromium.launch({ executablePath: process.env.CHROME_BIN || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
  page = await browser.newPage({ viewport: { width: 980, height: 640 }, deviceScaleFactor: 2, reducedMotion: 'reduce' }); page.setDefaultTimeout(15000);
  page.on('pageerror', error => result.pageErrors.push(error.message));
  await page.route('**/*', route => { const url = route.request().url(); if (url.startsWith(server.origin) || /^(data|blob):/.test(url)) return route.continue(); result.blockedRequests.push(url); return route.abort(); });
  await page.addInitScript({ content: `(${installPerformanceFixture.toString()})({sessionCount:2,turnCount:2});(${installPanelFilesFixture.toString()})();` });
  await page.goto(server.origin); await page.locator('.session-row').filter({ hasText: '文件会话 A' }).click(); await page.locator('.assistant-response').first().waitFor();
  const draftA = '文件隔离测试保留 A 草稿'; await composer().fill(draftA);
  await page.getByRole('button', { name: '打开右侧面板', exact: true }).click();
  if (cacheBytesOnly) { await checkCacheBytes(); } else {
  await openFile('shared.txt'); await expectFile('a', 'shared.txt');
  await openSession('b'); await openFile('shared.txt'); await expectFile('b', 'shared.txt');
  assert.equal(await tab('shared.txt').count(), 2); assert.equal((await calls('filePreview', 'a', 'shared.txt')).length, 1); assert.equal((await calls('filePreview', 'b', 'shared.txt')).length, 1);
  await tab('shared.txt').nth(0).click(); await expectFile('a', 'shared.txt'); assert.equal((await calls('filePreview', 'a', 'shared.txt')).length, 1, 'original A tab keeps its scoped cached result while B is current');
  await page.getByRole('button', { name: '文件操作', exact: true }).click(); await page.getByRole('menuitem', { name: 'Synthetic Editor', exact: true }).click();
  assert.equal((await calls('fileActions', 'a', 'shared.txt')).length, 1); assert.equal((await calls('openWith', 'a', 'shared.txt')).length, 1); assert.equal((await calls('openWith', 'b', 'shared.txt')).length, 0);
  result.checks.push('same relative path in A/B has two scoped tabs and independent content/cache; activating A under B and external app actions preserve A cwd');

  const beforeSplit = (await calls('files', 'b', '')).length;
  await page.getByRole('button', { name: '分栏', exact: true }).click();
  await page.locator('.panel-split-tree .file-row[title="B-folder"]').waitFor(); await expectFile('a', 'shared.txt');
  assert.ok((await calls('files', 'b', '')).length > beforeSplit, 'showing split tree loads the current B workspace even while A file is selected');
  await qa('hold', 'files', 'b', ''); await page.getByRole('button', { name: '刷新文件列表', exact: true }).click();
  const splitRead = await held('files', 'b', '');
  await expectFile('a', 'shared.txt');
  assert.equal(await preview().locator('.file-preview-loading').count(), 0, 'directory loading must not mark the independent file preview busy');
  assert.equal(await page.locator('.panel-split-main .panel-empty').count(), 0, 'directory refresh must not clear A preview');
  await qa('release', splitRead); await qa('unhold', 'files', 'b', '');
  await page.locator('.panel-split-tree .file-row[title="B-folder"]').waitFor(); await expectFile('a', 'shared.txt');
  assert.equal(await page.locator('.panel-split-tree .file-row[title="A-folder"]').count(), 0);
  const geometry = async () => page.evaluate(() => {
    const rect = selector => { const { x, y, width, height } = document.querySelector(selector).getBoundingClientRect(); return { x, y, width, height }; };
    return { panel: rect('.file-panel'), tree: rect('.panel-split-tree'), main: rect('.panel-split-main') };
  });
  let layout = await geometry();
  assert.ok(layout.main.width >= layout.panel.width * .95, 'narrow split preview uses nearly the full panel width');
  assert.ok(layout.tree.y + layout.tree.height <= layout.main.y + 1, 'narrow split places directory above preview');
  for (const selector of ['.panel-split-tree .file-tree', '.panel-split-main .file-preview-code']) {
    const scroll = await page.locator(selector).evaluate(node => { node.scrollTop = 40; const actual = node.scrollTop; node.scrollTop = 0; return actual; });
    assert.ok(scroll > 0, `${selector} retains independent scrolling`);
  }
  await page.getByRole('button', { name: '全屏', exact: true }).click(); await settle();
  layout = await geometry();
  assert.ok(layout.tree.x + layout.tree.width <= layout.main.x + 1, 'wide fullscreen split places directory beside preview');
  assert.ok(Math.abs(layout.tree.y - layout.main.y) <= 1, 'wide split columns share a top edge');
  await expectFile('a', 'shared.txt'); await capture('01-split-fullscreen-light', 'light');
  await page.getByRole('button', { name: '退出全屏', exact: true }).click(); await settle();
  layout = await geometry(); assert.ok(layout.main.width >= layout.panel.width * .95); assert.ok(layout.tree.y + layout.tree.height <= layout.main.y + 1);
  await capture('02-split-current-workspace-light', 'light');
  await page.getByRole('button', { name: '退出分栏', exact: true }).click(); await page.locator('.panel-split-tree').waitFor({ state: 'detached' }); await expectFile('a', 'shared.txt');
  result.checks.push('split mode loads current B directory beside original A file; held directory refresh cannot clear or busy A preview; narrow split stacks independently scrolling regions at full preview width, fullscreen restores columns, returning and exiting split retain preview');

  await openSession('a'); await qa('hold', 'filePreview', 'a', 'late.txt'); await openFile('late.txt'); const late = await held('filePreview', 'a', 'late.txt');
  await openSession('b'); await tab('shared.txt').nth(1).click(); await expectFile('b', 'shared.txt'); await qa('release', late); await expectFile('b', 'shared.txt'); await qa('unhold', 'filePreview', 'a', 'late.txt');
  await tab('late.txt').click(); await expectFile('a', 'late.txt'); assert.equal((await calls('filePreview', 'a', 'late.txt')).length, 1);
  result.checks.push('late A preview cannot overwrite active B, but remains available in original A tab');

  await openSession('a'); await qa('hold', 'filePreview', 'a', 'closed.txt'); await openFile('closed.txt'); const closed = await held('filePreview', 'a', 'closed.txt');
  await closeFile('closed.txt'); await qa('release', closed); assert.equal(await tab('closed.txt').count(), 0); await qa('unhold', 'filePreview', 'a', 'closed.txt');
  await openFile('closed.txt'); await expectFile('a', 'closed.txt'); assert.equal((await calls('filePreview', 'a', 'closed.txt')).length, 2, 'closed pending file is not resurrected or cached');
  await closeFile('closed.txt'); await openFile('closed.txt'); await expectFile('a', 'closed.txt'); assert.equal((await calls('filePreview', 'a', 'closed.txt')).length, 3, 'closing loaded file evicts its cache');
  await qa('hold', 'filePreview', 'a', 'reopen.txt'); await openFile('reopen.txt'); const old = await held('filePreview', 'a', 'reopen.txt'); await closeFile('reopen.txt');
  await qa('version', 'a', 'reopen.txt', 2); await qa('unhold', 'filePreview', 'a', 'reopen.txt'); await openFile('reopen.txt'); await expectFile('a', 'reopen.txt', 2);
  await qa('release', old); await expectFile('a', 'reopen.txt', 2); await tab('shared.txt').nth(0).click(); await tab('reopen.txt').click(); await expectFile('a', 'reopen.txt', 2);
  result.checks.push('closing pending tabs cannot revive them; closed loaded previews are evicted; old close/reopen response cannot overwrite newer preview or cache');

  await qa('fail', 'filePreview', 'a', 'error.txt'); await openFile('error.txt'); await page.locator('.panel-file-error').filter({ hasText: 'QA A filePreview error.txt 读取失败' }).waitFor();
  await page.getByRole('button', { name: '重试读取文件', exact: true }).click(); await expectFile('a', 'error.txt');
  await tree(); await qa('hold', 'files', 'a', 'folder'); await page.locator('.file-row[title="A-folder"]').click(); const directory = await held('files', 'a', 'folder');
  await openSession('b'); await page.locator('.file-row[title="B-folder"]').waitFor(); await qa('release', directory); await page.locator('.file-row[title="B-folder"]').waitFor(); assert.equal(await page.locator('.file-row[title="A-nested.txt"]').count(), 0);
  await qa('unhold', 'files', 'a', 'folder'); await qa('fail', 'files', 'b', ''); await page.getByRole('button', { name: '刷新文件列表', exact: true }).click();
  await page.locator('.panel-file-error').filter({ hasText: 'QA B files / 读取失败' }).waitFor(); await capture('03-directory-error-dark', 'dark');
  await page.getByRole('button', { name: '重试读取目录', exact: true }).click(); await page.locator('.file-row[title="B-folder"]').waitFor(); assert.equal(await page.locator('.panel-file-error').count(), 0);
  result.checks.push('file errors recover locally; delayed A directory cannot replace B; directory failure/retry stays local and reloads current workspace');

  for (let i = 0; i < 10; i++) { await openFile(`cache-${i}.txt`); await expectFile('b', `cache-${i}.txt`); }
  assert.equal(await page.locator('.panel-tab').filter({ has: page.locator('.panel-tab-label', { hasText: /^cache-\d\.txt$/ }) }).count(), 10, 'bounded content cache never removes open tabs');
  assert.equal((await calls('filePreview', 'b', 'cache-0.txt')).length, 1);
  await tab('cache-0.txt').click(); await expectFile('b', 'cache-0.txt'); assert.equal((await calls('filePreview', 'b', 'cache-0.txt')).length, 2, 'oldest entry reloads after >8 previews');
  // A tab retains its root even when cache eviction forces a fresh read under B.
  await tab('shared.txt').nth(0).click(); await expectFile('a', 'shared.txt'); assert.equal((await calls('filePreview', 'a', 'shared.txt')).length, 2);
  await capture('04-evicted-owner-dark', 'dark');
  result.checks.push('more than eight previews evict content without losing tabs; evicted A tab rereads A while current session is B');
  }
  await page.getByRole('button', { name: '收起右侧面板', exact: true }).click(); await page.locator('.file-panel').waitFor({ state: 'detached' });
  await openSession('a'); assert.equal(await composer().inputValue(), draftA);
  assert.deepEqual(result.pageErrors, []); assert.deepEqual(result.blockedRequests, []); assert.equal((await calls('conversationSubmit')).length, 0);
  result.calls = await page.evaluate(() => window.__panelFilesQa.calls); await rm(path.join(output, 'failure.png'), { force: true });
} catch (error) {
  result.error = error.stack;
  if (page) {
    result.calls = await page.evaluate(() => window.__panelFilesQa?.calls).catch(() => []);
    result.pending = await page.evaluate(() => window.__panelFilesQa?.pending()).catch(() => []);
    await page.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {});
  }
  throw error;
}
finally { await writeFile(path.join(output, 'results.json'), `${JSON.stringify(result, null, 2)}\n`); await browser?.close(); await server.close(); }
console.log(JSON.stringify({ output, checks: result.checks, screenshots: result.screenshots }, null, 2));
