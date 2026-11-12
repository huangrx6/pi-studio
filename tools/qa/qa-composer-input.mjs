import { composerValue, selectComposerRange } from './fixtures/composer-editor.mjs';
import { checkReferenceEditor } from './fixtures/reference-editor-checks.mjs';
/** Production renderer input QA using synthetic IPC, no real submissions or files. */
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { installPerformanceFixture } from './fixtures/performance.mjs';
import { installSettingsExecutionFixture } from './fixtures/settings-execution.mjs';
import { installComposerInputFixture } from './fixtures/composer-input.mjs';
import { serveProductionRenderer } from './fixtures/production-renderer-server.mjs';
const root = fileURLToPath(new URL('../..', import.meta.url)); const output = path.join(root, '.qa/composer-input'); await mkdir(output, { recursive: true });
const results = { checks: [], screenshots: [], pageErrors: [], blockedRequests: [], assets: (await readFile(path.join(root, 'web-dist/index.html'), 'utf8')).match(/assets\/[^"']+\.(?:js|css)/g) };
const server = await serveProductionRenderer(root); let browser; let page;
let expectedExtensionCommands = 0;
const composer = () => page.getByRole('textbox', { name: '发送给 Pi 的消息', exact: true });
const picker = () => page.locator('.composer-picker'); const options = () => picker().getByRole('option');
async function settle() { await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))); }
async function qa(method, ...args) { await page.evaluate(({ method, args }) => window.__composerInputQa[method](...args), { method, args }); await settle(); }
async function pending(method, size = 1) { await page.waitForFunction(({ method, size }) => window.__composerInputQa.pending(method).length === size, { method, size }); }
async function count(method) { return page.evaluate(method => window.__composerInputQa.calls.filter(call => call.method === method).length, method); }
async function open(id) { await qa('open', id); await page.locator('.chat-heading h1').filter({ hasText: id === 'perf-0' ? '性能会话 0000' : '性能会话 0001' }).waitFor(); }
async function fill(text) { await composer().fill(text); await settle(); }
async function screenshot(name) { assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false, 'no document overflow'); await page.screenshot({ path: path.join(output, `${name}.png`), animations: 'disabled' }); results.screenshots.push(name); }
async function paste(text, files = [], selection) {
  const length = (await composerValue(composer())).length;
  await selectComposerRange(composer(), ...(selection || [length, length]));
  await composer().evaluate((node, { text, files }) => {
    const data = new DataTransfer(); if (text) data.setData('text/plain', text);
    for (const file of files) data.items.add(new File([file.content || 'fixture file'], file.name, { type: file.type || 'text/plain' }));
    node.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: data }));
  }, { text, files, selection }); await settle();
}
async function assertNoSubmissions() { assert.equal(await count('conversationSubmit'), 0); assert.equal(await count('runExtensionCommand'), expectedExtensionCommands); }
try {
  browser = await chromium.launch({ executablePath: process.env.CHROME_BIN || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
  page = await browser.newPage({ viewport: { width: 980, height: 640 }, deviceScaleFactor: 2, reducedMotion: 'reduce' }); page.setDefaultTimeout(15000);
  page.on('pageerror', error => results.pageErrors.push(error.message));
  await page.route('**/*', route => { const url = route.request().url(); if (url.startsWith(`${server.origin}/`) || /^(data|blob):/.test(url)) return route.continue(); results.blockedRequests.push(url); return route.abort(); });
  await page.addInitScript({ content: `(${installPerformanceFixture.toString()})({sessionCount:2,turnCount:4});(${installSettingsExecutionFixture.toString()})();(${installComposerInputFixture.toString()})();` });
  await page.goto(server.origin); await page.locator('.session-row').filter({ hasText: '性能会话 0000' }).click(); await page.locator('.assistant-response').first().waitFor();
  await checkReferenceEditor(page);
  results.checks.push('typed reference icons, quoted paths, atomic deletion, undo/redo, raw clipboard round trip, HTML paste rejection, native IME, multiline input and long labels');
  await fill('/qa'); await options().first().waitFor();
  assert.equal(await composer().getAttribute('aria-controls'), 'composer-suggestions');
  const activeId = await composer().getAttribute('aria-activedescendant'); assert(activeId);
  assert.equal(await page.locator(`#${activeId}`).getAttribute('aria-selected'), 'true');
  assert(await options().evaluateAll(nodes => nodes.every(node => node.tabIndex === -1)));
  await screenshot('01-suggestions-light');
  await composer().evaluate(node => {
    for (const key of ['ArrowDown', 'Escape', 'Enter']) node.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, isComposing: true }));
    node.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 229, bubbles: true, cancelable: true }));
  }); await settle();
  assert.equal(await composerValue(composer()), '/qa'); assert.equal(await composer().getAttribute('aria-activedescendant'), activeId); assert.equal(await picker().count(), 1); await assertNoSubmissions();
  await composer().press('Shift+Enter'); assert.equal(await composerValue(composer()), '/qa\n'); await assertNoSubmissions();
  await fill('/qa'); await options().first().waitFor(); await composer().press('Shift+Tab');
  assert.equal(await composerValue(composer()), '/qa', 'Shift+Tab cannot select an option'); assert.equal(await composer().evaluate(node => node === document.activeElement), false);
  await composer().focus(); await composer().press('Escape'); await picker().waitFor({ state: 'detached' });
  await fill(''); await fill('/qa'); await options().first().waitFor(); await options().filter({ hasText: '/qa-review-a' }).click();
  assert.match(await composerValue(composer()), /^\/qa-review-a\s/); assert.equal(await picker().count(), 0); await assertNoSubmissions();
  results.checks.push('suggestion listbox/active descendant relation, options not separate Tab stops, IME/keyCode229 inert, ShiftEnter newline, ShiftTab normal navigation, pointer command inserts draft without execution');

  await fill(''); await qa('hold', 'composerResources', 'perf-0'); await fill('/qa'); await pending('composerResources');
  assert.equal(await options().count(), 0, 'new pending request clears old suggestions'); await composer().press('Enter'); assert.equal(await composerValue(composer()), '/qa'); await assertNoSubmissions();
  await open('perf-1'); const draftB = 'B 的原始草稿，不接收 A 的结果。'; await fill(draftB);
  await qa('release', 'composerResources'); assert.equal(await composerValue(composer()), draftB); assert.equal(await picker().count(), 0);
  await fill('/qa'); await options().filter({ hasText: '/qa-review-b' }).waitFor(); assert.equal(await options().filter({ hasText: '/qa-review-a' }).count(), 0);
  await fill(''); await qa('fail', 'composerResources'); await fill('/qa'); await picker().getByRole('alert').waitFor();
  assert.equal(await options().count(), 0); await composer().press('Enter'); assert.equal(await composerValue(composer()), '/qa'); await assertNoSubmissions();
  await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; }); await screenshot('02-suggestions-error-dark');
  await picker().getByRole('button', { name: '重试建议', exact: true }).click(); await options().filter({ hasText: '/qa-review-b' }).waitFor();
  await fill('@alpha'); await options().filter({ hasText: 'alpha.txt' }).waitFor();
  await qa('hold', 'searchFiles', 'slow'); await fill('@slow'); assert.equal(await options().count(), 0); await pending('searchFiles');
  await fill('@latest'); await options().filter({ hasText: 'latest.txt' }).waitFor(); await qa('release', 'searchFiles');
  assert.equal(await options().filter({ hasText: 'slow.txt' }).count(), 0); assert.equal(await options().filter({ hasText: 'latest.txt' }).count(), 1);
  await options().filter({ hasText: 'QA notes.md' }).click(); assert.match(await composerValue(composer()), /docs\/QA notes\.md/);
  await fill('@'); await options().first().waitFor(); await composer().press('Escape'); await picker().waitFor({ state: 'detached' });
  await fill('/does-not-exist'); await picker().getByText('没有匹配的命令', { exact: true }).waitFor(); await composer().press('Escape'); await picker().waitFor({ state: 'detached' });
  await fill(draftB); await open('perf-0'); assert.equal(await composerValue(composer()), '/qa'); await fill('A 的主草稿。');
  results.checks.push('pending/error suggestions cannot submit or expose stale options; session A response ignored in B, explicit retry, query-race file results, spaced-path insertion, empty and loaded menu Escape');

  const pastedA = 'LONG_A_'.repeat(1800); const pastedEdited = 'LONG_EDIT_'.repeat(1400);
  await fill('原文 SELECT 尾部'); await qa('hold', 'saveAttachment', 'perf-0'); await paste(pastedA, [], [3, 9]); await pending('saveAttachment');
  await open('perf-1'); assert.equal(await composerValue(composer()), draftB); await composer().focus();
  await qa('reject', 'saveAttachment'); assert.equal(await composerValue(composer()), draftB); assert.equal(await composer().evaluate(node => node === document.activeElement), true, 'late paste failure cannot steal B focus');
  await open('perf-0'); assert.equal(await composerValue(composer()), `原文 ${pastedA} 尾部`, 'untouched owner draft restores paste at original replacement position');
  await fill('当前编辑-'); await qa('hold', 'saveAttachment', 'perf-0'); await paste(pastedEdited); await pending('saveAttachment');
  await fill('后续已经编辑的新内容'); await qa('reject', 'saveAttachment');
  const recovered = await composerValue(composer()); assert(recovered.startsWith('后续已经编辑的新内容')); assert(recovered.includes(pastedEdited)); assert.equal(recovered.split(pastedEdited).length, 2);
  results.checks.push('long-paste failure restores original owner only and original selection when unchanged; later edits survive with recovered paste appended exactly once, no cross-session focus/draft overwrite');

  await fill('附件并发测试草稿'); const attach = page.getByRole('button', { name: '添加图片或文件', exact: true });
  await attach.click(); await page.getByRole('button', { name: '移除 picked-1.txt', exact: true }).waitFor();
  await qa('hold', 'pickAttachments', 'perf-0'); await attach.click(); await pending('pickAttachments');
  await page.getByRole('button', { name: '移除 picked-1.txt', exact: true }).click();
  await attach.click(); await pending('pickAttachments', 2); await qa('releaseAt', 'pickAttachments', 1);
  await page.getByRole('button', { name: '移除 picked-3.txt', exact: true }).waitFor(); await qa('release', 'pickAttachments');
  await page.getByRole('button', { name: '移除 picked-2.txt', exact: true }).waitFor(); assert.equal(await page.getByRole('button', { name: '移除 picked-1.txt', exact: true }).count(), 0);
  await qa('hold', 'saveUpload'); await paste('', [{ name: 'upload-one.txt' }]); await pending('saveUpload'); await paste('', [{ name: 'upload-two.txt' }]); await pending('saveUpload', 2);
  await page.getByRole('button', { name: '移除 picked-2.txt', exact: true }).click();
  await qa('releaseAt', 'saveUpload', 1); await page.getByRole('button', { name: '移除 upload-two.txt', exact: true }).waitFor(); await qa('release', 'saveUpload'); await page.getByRole('button', { name: '移除 upload-one.txt', exact: true }).waitFor(); assert.equal(await page.getByRole('button', { name: '移除 picked-2.txt', exact: true }).count(), 0, 'old upload cannot resurrect a removed attachment');
  await fill('混合粘贴:'); await paste('剪贴板文字', [{ name: 'mixed.txt' }]); await page.getByRole('button', { name: '移除 mixed.txt', exact: true }).waitFor(); assert.equal(await composerValue(composer()), '混合粘贴:剪贴板文字');
  await qa('hold', 'saveUpload', 'late-a.txt'); await paste('', [{ name: 'late-a.txt' }]); await pending('saveUpload'); await open('perf-1'); await qa('release', 'saveUpload');
  assert.equal(await composerValue(composer()), draftB); assert.equal(await page.getByRole('button', { name: '移除 late-a.txt', exact: true }).count(), 0);
  await open('perf-0'); await page.getByRole('button', { name: '移除 late-a.txt', exact: true }).waitFor(); assert.equal(await composerValue(composer()), '混合粘贴:剪贴板文字');
  await screenshot('03-attachments-dark');
  results.checks.push('out-of-order picker/upload completions merge with current attachments, removed attachment stays removed, mixed clipboard text/files retained, late file belongs to A and preserves B draft');
  // Only this explicit synthetic command may execute; it cannot invoke real extensions.
  while (await page.getByRole('button', { name: /^移除 / }).count()) await page.getByRole('button', { name: /^移除 / }).first().click();
  await fill('/qa-extension'); await options().first().waitFor(); await composer().press('Escape');
  await qa('hold', 'runExtensionCommand', 'perf-0'); await composer().press('Enter'); await pending('runExtensionCommand'); expectedExtensionCommands++;
  await fill('扩展命令期间的新草稿'); await qa('release', 'runExtensionCommand'); await assertNoSubmissions(); assert.equal(await composerValue(composer()), '扩展命令期间的新草稿');
  await fill('/qa-extension'); await options().first().waitFor(); await composer().press('Escape');
  await qa('hold', 'runExtensionCommand', 'perf-0'); await composer().press('Enter'); await pending('runExtensionCommand'); expectedExtensionCommands++;
  await open('perf-1'); await qa('release', 'runExtensionCommand'); await assertNoSubmissions(); assert.equal(await composerValue(composer()), draftB);
  await open('perf-0'); assert.equal(await composerValue(composer()), '/qa-extension');
  results.checks.push('explicit synthetic extension result with promptText/submit cannot overwrite later editing or another conversation, and never invokes model submission');

  const extensionPanel = page.getByRole('dialog', { name: 'QA 范围面板', exact: true });
  const extensionCommand = page.getByRole('button', { name: '执行 QA 延迟命令', exact: true });
  const extensionPanelAction = page.getByRole('button', { name: '打开 QA 范围面板', exact: true });
  await fill('A 扩展面板归属草稿'); await extensionPanelAction.click(); await extensionPanel.waitFor();
  await open('perf-1'); await extensionPanel.waitFor({ state: 'detached' }); assert.equal(await composerValue(composer()), draftB);
  results.checks.push('an extension panel opened in A closes immediately when B becomes the active workspace/session/model scope');

  await open('perf-0'); assert.equal(await composerValue(composer()), 'A 扩展面板归属草稿');
  await qa('hold', 'runExtensionCommand', 'perf-0'); await extensionCommand.click(); await pending('runExtensionCommand'); expectedExtensionCommands++;
  await open('perf-1'); await qa('release', 'runExtensionCommand'); await settle();
  assert.equal(await composerValue(composer()), draftB); assert.equal(await extensionPanel.count(), 0);
  await page.locator('.notification-trigger').click(); const notificationCenter = page.getByRole('dialog', { name: '通知中心', exact: true });
  assert.equal(await notificationCenter.getByText('A 范围的延迟结果', { exact: true }).count(), 0);
  await notificationCenter.getByRole('button', { name: '关闭通知', exact: true }).click();
  await open('perf-0'); assert.equal(await composerValue(composer()), 'A 扩展面板归属草稿');
  results.checks.push('a late extension command result cannot replace B draft, open B panel, or publish its message as B feedback');

  await qa('hold', 'runExtensionCommand', 'perf-0'); await extensionCommand.click(); await pending('runExtensionCommand'); expectedExtensionCommands++;
  await open('perf-1'); await qa('reject', 'runExtensionCommand'); await settle();
  assert.equal(await composerValue(composer()), draftB); assert.equal(await extensionPanel.count(), 0);
  await page.locator('.notification-trigger').click();
  assert.equal(await notificationCenter.getByText('QA runExtensionCommand failure', { exact: true }).count(), 0);
  await notificationCenter.getByRole('button', { name: '关闭通知', exact: true }).click();
  results.checks.push('a late extension command failure is suppressed instead of appearing as an error in B');

  await open('perf-0'); await fill('A 当前命令草稿');
  await qa('hold', 'runExtensionCommand', 'perf-0'); await extensionCommand.click(); await pending('runExtensionCommand'); expectedExtensionCommands++;
  await qa('release', 'runExtensionCommand'); await extensionPanel.waitFor();
  assert.equal(await composerValue(composer()), 'A 范围结果'); assert.equal(await extensionCommand.isEnabled(), true);
  await screenshot('05-extension-scope-dark'); await extensionPanel.getByRole('button', { name: '完成', exact: true }).click();
  await page.locator('.notification-trigger').click();
  assert.equal(await notificationCenter.getByText('A 范围的延迟结果', { exact: true }).count(), 1);
  await notificationCenter.getByRole('button', { name: '关闭通知', exact: true }).click();
  results.checks.push('same-scope extension results still apply prompt, panel, message, and release the action lock without enabling submission');

  await page.getByText('A 实时数据', { exact: true }).waitFor();
  await open('perf-1'); await page.getByText('B 实时数据', { exact: true }).waitFor();
  await qa('hold', 'openExtensionDataView', 'perf-0'); await open('perf-0');
  await page.getByText('正在连接实时数据', { exact: true }).waitFor();
  assert.equal(await page.getByText('A 实时数据', { exact: true }).count(), 0);
  await open('perf-1'); await page.getByText('B 实时数据', { exact: true }).waitFor();
  await qa('release', 'openExtensionDataView'); await settle();
  assert.equal(await page.getByText('B 实时数据', { exact: true }).count(), 1);
  assert.equal(await page.getByText('A 实时数据', { exact: true }).count(), 0);
  results.checks.push('a live extension view remounts by workspace/session/model ownership, so an A open cannot flash or publish stale data in B');

  await open('perf-0'); await page.getByText('A 实时数据', { exact: true }).waitFor();
  const perfADataView = await page.evaluate(() => window.__composerInputQa.dataViewSubscription('perf-0'));
  assert(perfADataView);
  await page.evaluate(subscriptionId => window.__composerInputQa.emitDataView(subscriptionId, {
    sourceId: 'project:qa-extension/live-data', revision: 6, updatedAt: Date.now(), content: [], error: '实时数据源读取超时',
  }), perfADataView);
  await page.getByRole('button', { name: '重试连接实时数据', exact: true }).waitFor();
  await page.evaluate(() => window.__composerInputQa.dataViewResponse('perf-0', {
    sourceId: 'project:qa-extension/live-data', revision: 1, updatedAt: Date.now(), content: [{ kind: 'text', text: '重连后的实时数据' }],
  }));
  await page.getByRole('button', { name: '重试连接实时数据', exact: true }).click();
  await page.getByText('重连后的实时数据', { exact: true }).waitFor();
  assert.equal(await page.getByText('A 实时数据', { exact: true }).count(), 0);
  results.checks.push('reconnect compares revisions within the new subscription id, so lower-numbered fresh data replaces stale content instead of being ignored');

  const extensionSlotMetrics = await page.locator('.extension-slot.is-composer-before').evaluate(node => ({
    clientHeight: node.clientHeight,
    scrollHeight: node.scrollHeight,
    bottom: node.getBoundingClientRect().bottom,
  }));
  const attachBox = await page.getByRole('button', { name: '添加图片或文件', exact: true }).boundingBox();
  assert(extensionSlotMetrics.scrollHeight > extensionSlotMetrics.clientHeight, 'dense composer extensions scroll inside their bounded region');
  assert(attachBox && attachBox.y + attachBox.height <= 640, 'the core Composer remains inside the 980x640 viewport');
  assert.ok(extensionSlotMetrics.bottom <= 640 + 1);
  await screenshot('06-extension-data-dense-dark');
  results.checks.push('dense composer.before extensions stay in a bounded internal scroll region, keeping the input and attachment controls visible at 980x640');

  // A pending conversion is not permission to erase edits made after Send.
  while (await page.getByRole('button', { name: /^移除 / }).count()) await page.getByRole('button', { name: /^移除 / }).first().click();
  await fill('PREPARING_'.repeat(1500)); await qa('hold', 'saveAttachment', 'perf-0'); await composer().press('Enter'); await pending('saveAttachment');
  await fill('发送准备期间继续编辑的草稿'); await qa('release', 'saveAttachment'); await assertNoSubmissions(); assert.equal(await composerValue(composer()), '发送准备期间继续编辑的草稿');
  const beforeSwitch = 'PREPARING_SWITCH_'.repeat(1000);
  await fill(beforeSwitch); await qa('hold', 'saveAttachment', 'perf-0'); await composer().press('Enter'); await pending('saveAttachment');
  await open('perf-1'); await qa('release', 'saveAttachment'); await assertNoSubmissions(); assert.equal(await composerValue(composer()), draftB);
  await open('perf-0'); assert.equal(await composerValue(composer()), beforeSwitch, 'preparation late completion preserves source draft too');
  results.checks.push('send preparation ignores edits and session changes after async attachment conversion; neither later nor other-session draft is cleared and no stale submission occurs');

  await qa('emit', 'run.started', 'perf-0', { requestId: 'qa-running' });
  await fill('第一条排队消息'); await composer().press('Meta+Enter'); await page.locator('.queued-item').waitFor(); assert.equal(await composerValue(composer()), '');
  await fill('第二条排队消息'); await composer().press('Meta+Enter'); await page.waitForFunction(() => document.querySelectorAll('.queued-item').length === 2);
  const queueDraft = '当前草稿不能被排队编辑覆盖'; await fill(queueDraft);
  await page.getByRole('button', { name: '编辑排队消息', exact: true }).first().click();
  assert.equal(await composerValue(composer()), queueDraft); assert.equal(await page.locator('.queued-item').count(), 2);
  await page.getByText('输入框中还有未发送内容，请先发送或清空，再编辑排队消息。', { exact: true }).waitFor();
  await qa('emit', 'compaction.started', 'perf-0', { reason: 'QA synthetic compaction' });
  assert.equal(await page.getByRole('button', { name: '插话发送全部', exact: true }).isDisabled(), true);
  assert(await page.getByRole('button', { name: '立即插话发送', exact: true }).evaluateAll(nodes => nodes.length === 2 && nodes.every(node => node.disabled)));
  await composer().press('Enter'); await composer().press('Meta+Enter'); assert.equal(await composerValue(composer()), queueDraft); assert.equal(await page.locator('.queued-item').count(), 2); await assertNoSubmissions();
  await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; }); await screenshot('04-queue-compaction-light');
  await page.getByRole('button', { name: '删除排队消息', exact: true }).first().click(); await page.getByRole('button', { name: '删除排队消息', exact: true }).click();
  await page.locator('.queued-panel').waitFor({ state: 'detached' });
  results.checks.push('queue uses explicit MetaEnter without dispatch, editing protects nonempty draft, compaction disables individual/all sends and keeps both queued messages and current draft');
  await page.getByRole('button', { name: '新会话', exact: true }).click(); await page.getByRole('heading', { name: '开始一个新会话', exact: true }).waitFor();
  await fill('开始新会话的原始草稿'); await qa('hold', 'createConversation');
  await composer().press('Enter'); await pending('createConversation'); await composer().press('Enter');
  assert.equal(await count('createConversation'), 1, 'double Enter cannot create duplicate conversations');
  await fill('创建期间的新草稿必须迁移到新会话'); await qa('release', 'createConversation');
  await page.locator('.chat-heading h1').filter({ hasText: 'QA 新创建会话' }).waitFor();
  assert.equal(await composerValue(composer()), '创建期间的新草稿必须迁移到新会话'); await assertNoSubmissions();
  results.checks.push('held create plus repeated Enter creates once; editing during creation migrates latest draft without submitting original content');
  await assertNoSubmissions(); assert.deepEqual(results.pageErrors, []); assert.deepEqual(results.blockedRequests, []);
  results.calls = await page.evaluate(() => window.__composerInputQa.calls.map(({ text, ...call }) => ({ ...call, ...(text ? { textLength: text.length } : {}) })));
  await rm(path.join(output, 'failure.png'), { force: true });
} catch (error) { results.error = error.stack; if (page) await page.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {}); throw error; }
finally { await writeFile(path.join(output, 'results.json'), `${JSON.stringify(results, null, 2)}\n`); await browser?.close(); await server.close(); }
console.log(JSON.stringify({ output, checks: results.checks, screenshots: results.screenshots, pageErrors: results.pageErrors }, null, 2));
