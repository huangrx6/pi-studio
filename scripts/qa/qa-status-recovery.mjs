import { composerValue } from './fixtures/composer-editor.mjs';
/** Built-renderer status/recovery QA, with in-memory data and no provider calls. */
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { installStatusRecoveryFixture } from './fixtures/status-recovery.mjs';
import { serveProductionRenderer } from './fixtures/production-renderer-server.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));
const output = path.join(root, '.qa', 'status-recovery');
await mkdir(output, { recursive: true });
const result = { pageErrors: [], matrix: [], screenshots: [], checks: [] };
const server = await serveProductionRenderer(root);
let browser;
let page;
async function focused(locator) {
  await page.waitForFunction((element) => document.activeElement === element, await locator.elementHandle());
}
async function capture(name) {
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false, 'the viewport has no horizontal overflow');
  const composerVisible = await page.locator('.composer').evaluate((element) => { const box = element.getBoundingClientRect(); return box.bottom <= innerHeight + 1 && box.left >= 0 && box.right <= innerWidth + 1; });
  assert.equal(composerVisible, true, 'the composer remains inside the viewport');
  await page.screenshot({ path: path.join(output, `${name}.png`), animations: 'disabled' });
  result.screenshots.push(name);
}
try {
  browser = await chromium.launch({ executablePath: process.env.CHROME_BIN || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
  page = await browser.newPage({ viewport: { width: 1440, height: 920 }, deviceScaleFactor: 2 });
  page.setDefaultTimeout(15_000);
  page.on('pageerror', (error) => result.pageErrors.push(error.message));
  await page.route('**/*', (route) => route.request().url().startsWith(server.origin) || /^(data|blob):/.test(route.request().url()) ? route.continue() : route.abort());
  await page.addInitScript(installStatusRecoveryFixture);
  await page.goto(server.origin);
  await page.locator('.workspace-row').waitFor();
  if (await page.locator('.workspace-row').getAttribute('aria-expanded') !== 'true') await page.locator('.workspace-row').click();
  const composer = page.getByRole('textbox', { name: '发送给 Pi 的消息', exact: true });
  const dock = page.locator('.long-task-dock');
  const selectSession = async (title) => {
    await page.locator('.session-row').filter({ has: page.locator('.session-title').filter({ hasText: new RegExp(`^${title}$`) }) }).click();
    await page.locator('.chat-heading h1').filter({ hasText: new RegExp(`^${title}$`) }).waitFor();
  };
  const cases = [
    { title: '任务正在运行', label: '目标执行中', resume: false, pause: true },
    { title: '任务等待继续', label: '等待继续', resume: true, pause: true },
    { title: '任务已暂停', label: '已暂停', resume: true, pause: false },
    { title: '任务等待补充', label: '等待处理', resume: true, pause: true },
    { title: '任务执行失败', label: '执行失败', resume: false, pause: false },
    { title: '任务尚未开始', label: '等待目标', resume: false, pause: false },
    { title: '任务暂停但后台运行', label: '已暂停', resume: true, pause: false },
    { title: '任务阻塞但后台运行', label: '等待处理', resume: true, pause: true },
    { title: '任务失败但后台运行', label: '执行失败', resume: false, pause: false },
  ];
  for (const item of cases) {
    await selectSession(item.title);
    await dock.getByText(item.label, { exact: true }).waitFor();
    assert.equal(await dock.getByRole('button', { name: '继续', exact: true }).count(), Number(item.resume), `${item.title}: resume availability follows backend status`);
    assert.equal(await dock.getByRole('button', { name: '暂停', exact: true }).count(), Number(item.pause), `${item.title}: pause availability follows backend status`);
    assert.equal(await dock.getByRole('button', { name: '换目标', exact: true }).count(), 1);
    assert.match(await dock.locator('.long-task-goal').innerText(), /完成项目可读性与键盘操作检查/);
    if (item.label === '执行失败') assert.doesNotMatch(await dock.innerText(), /检查剩余交互与错误恢复/);
    result.matrix.push(item);
  }
  await selectSession('任务已完成');
  assert.equal(await dock.count(), 0, 'completed tasks release composer space');

  await page.evaluate(() => { window.__statusQa.failSubscriptions('subscription-recovery', 3); });
  await selectSession('实时连接恢复');
  const subscriptionError = page.getByRole('alert').filter({ hasText: 'QA_SUBSCRIBE_FAILURE' });
  await subscriptionError.waitFor();
  assert.match(await page.locator('.messages').innerText(), /此前工作已保存/, 'the stored transcript remains usable after live subscription failure');
  const subscriptionDraft = '实时连接断开或重试失败时，这段草稿也必须保留。';
  await composer.fill(subscriptionDraft);
  await capture('03-subscription-failure-light');

  await selectSession('任务已完成');
  assert.equal(await subscriptionError.count(), 0, 'a subscription error never leaks into another conversation');
  await selectSession('实时连接恢复');
  await subscriptionError.waitFor();
  assert.equal(await page.evaluate(() => window.__statusQa.subscriptionAttempts('subscription-recovery')), 2, 'returning to the conversation retries its live subscription');
  assert.equal(await composerValue(composer), subscriptionDraft);
  const reconnect = () => subscriptionError.getByRole('button', { name: '重新连接', exact: true });
  await reconnect().click();
  await page.waitForFunction(() => window.__statusQa.subscriptionAttempts('subscription-recovery') === 3);
  await reconnect().waitFor();
  assert.equal(await reconnect().isEnabled(), true, 'a failed reconnect remains manually retryable');
  await reconnect().click();
  await page.waitForFunction(() => window.__statusQa.subscriptionAttempts('subscription-recovery') === 4);
  await subscriptionError.waitFor({ state: 'detached' });
  await focused(composer);

  await page.evaluate(() => window.__statusQa.emit('subscription-recovery', 'run.started', {
    requestId: 'qa-live',
    inputs: ['qa-live-subscription'],
    running: true,
  }));
  await page.getByRole('button', { name: '停止当前任务', exact: true }).waitFor();
  assert.equal(await composerValue(composer), subscriptionDraft);
  await page.evaluate(() => { window.__statusQa.closeConversationStream('subscription-recovery'); });
  const closedStreamError = page.getByRole('alert').filter({ hasText: '实时连接已中断' });
  await closedStreamError.waitFor();
  assert.equal(
    await page.getByRole('button', { name: '停止当前任务', exact: true }).count(),
    1,
    'a silent stream closure does not claim that the active task completed',
  );
  assert.equal(await composerValue(composer), subscriptionDraft, 'stream recovery keeps the draft');
  await capture('03b-stream-closed-light');
  await closedStreamError.getByRole('button', { name: '重新连接', exact: true }).click();
  await page.waitForFunction(() => window.__statusQa.subscriptionAttempts('subscription-recovery') === 5);
  await closedStreamError.waitFor({ state: 'detached' });
  await page.evaluate(() => window.__statusQa.emit('subscription-recovery', 'run.completed', {
    requestId: 'qa-live',
    inputs: ['qa-live-subscription'],
    running: false,
  }));
  await page.getByRole('button', { name: '停止当前任务', exact: true }).waitFor({ state: 'detached' });
  result.checks.push('live subscription failure stays scoped to its session, transcript and draft remain usable, failed/manual retries recover, an unexpected stream close remains recoverable without claiming completion, and a post-reconnect run event reaches the UI');

  await selectSession('任务等待补充');
  const draft = '恢复失败或切换会话后，这段草稿应当保留。';
  await composer.fill(draft);
  await page.setViewportSize({ width: 980, height: 640 });
  const details = dock.getByRole('button', { name: '展开详情', exact: true });
  await details.click();
  assert.equal(await dock.getByRole('button', { name: '收起详情', exact: true }).getAttribute('aria-expanded'), 'true');
  assert.match(await dock.locator('.long-task-detail').innerText(), /需要补充项目验收标准/);
  await capture('01-blocked-expanded-light');
  await dock.getByRole('button', { name: '收起详情', exact: true }).click();
  await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
  await capture('02-blocked-collapsed-dark');

  await page.evaluate(() => { window.__statusQa.holdActions = true; });
  await dock.getByRole('button', { name: '继续', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.long-task-dock')?.getAttribute('aria-busy') === 'true');
  assert.ok((await dock.locator('.long-task-action').evaluateAll((buttons) => buttons.map((button) => button.disabled))).every(Boolean), 'busy dock disables state-changing action buttons');
  assert.equal(await dock.getByRole('button', { name: '展开详情', exact: true }).isEnabled(), true, 'details remain readable while a state change is pending');
  assert.equal(await page.evaluate(() => window.__statusQa.calls.filter((call) => call.action === 'long-task-resume').length), 1, 'one action is submitted while busy');
  await page.evaluate(() => window.__statusQa.releaseAction(true));
  await page.waitForFunction(() => document.querySelector('.long-task-dock')?.getAttribute('aria-busy') === 'false');
  await page.getByRole('alert').filter({ hasText: 'QA_ACTION_FAILURE' }).waitFor();
  assert.equal(await composerValue(composer), draft);
  await capture('04-action-failure');
  await page.evaluate(() => { window.__statusQa.holdActions = false; });
  await dock.getByRole('button', { name: '继续', exact: true }).click();
  await dock.getByText('目标执行中', { exact: true }).waitFor();
  await dock.getByRole('button', { name: '暂停', exact: true }).click();
  await dock.getByText('已暂停', { exact: true }).waitFor();
  assert.equal(await composerValue(composer), draft);
  result.checks.push('status/running matrix, long detail disclosure, narrow composer, held action/rejection/manual recovery, draft preservation');

  // Exercise the actual conversation-event listener, without asking a provider.
  await page.evaluate(() => window.__statusQa.emit('blocked', 'run.failed', { taskId: 'qa-failure', kind: 'model', reason: 'model_error', detail: 'QA_EVENT_FAILURE：此轮执行失败，草稿仍应保留。\n' + '详细的错误上下文仅用于检查展开，不应占满对话区域。'.repeat(15), message: 'QA_EVENT_FAILURE', running: false }));
  const errorCard = page.getByRole('alert').filter({ hasText: 'QA_EVENT_FAILURE' });
  await errorCard.waitFor();
  await errorCard.locator('summary').filter({ hasText: '查看详情' }).click();
  assert.match(await errorCard.innerText(), /详细的错误上下文/);
  await errorCard.getByRole('button', { name: '关闭错误提示', exact: true }).click();
  assert.equal(await composerValue(composer), draft);
  assert.equal(await page.locator('.notification-trigger').count(), 0);
  assert.deepEqual(result.pageErrors, []);
  console.log(`Status recovery QA passed: ${result.matrix.length} state combinations; screenshots: ${output}`);
} catch (error) {
  if (page) {
    await page.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {});
    result.failure = await page.evaluate(() => ({ focus: document.activeElement?.outerHTML.slice(0, 500), dock: document.querySelector('.long-task-dock')?.outerHTML, alerts: [...document.querySelectorAll('[role="alert"]')].map((element) => element.textContent) })).catch(() => null);
  }
  throw error;
} finally {
  await writeFile(path.join(output, 'results.json'), JSON.stringify(result, null, 2));
  if (browser) await browser.close();
  await server.close();
}
