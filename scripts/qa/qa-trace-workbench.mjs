import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { serveProductionRenderer } from './fixtures/production-renderer-server.mjs';
import { installConversationFixture } from './fixtures/conversation-refinement.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));
const output = path.join(root, '.qa/trace-workbench');
await mkdir(output, { recursive: true });
const server = await serveProductionRenderer(root);
let browser;
const results = { checks: [], errors: [] };
try {
  browser = await chromium.launch({ executablePath: process.env.CHROME_BIN || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 920 }, deviceScaleFactor: 2 });
  page.setDefaultTimeout(10000);
  page.on('pageerror', error => results.errors.push(error.message));
  await page.addInitScript(installConversationFixture);
  await page.addInitScript(() => {
    localStorage.setItem('pi-studio:preferences', JSON.stringify({ theme: 'dark', stepDisplay: 'standard' }));
    const api = window.piApi;
    const originalPage = api.conversationPage;
    api.conversationPage = async input => {
      const value = await originalPage(input);
      const base = Date.now() - 600_000;
      value.messages = [];
      value.requestTraces = [];
      for (let round = 0; round < 8; round++) {
        const at = base + round * 60_000;
        value.messages.push({ role: 'user', timestamp: at, content: [{ type: 'text', text: `请审查第 ${round + 1} 个模块的界面结构与交互。` }] });
        for (let step = 0; step < 12; step++) {
          const id = `${round}-${step}`;
          value.messages.push({ role: 'assistant', timestamp: at + 1000 + step * 3000, content: [{ type: 'thinking', thinking: '检查组件布局、状态与数据来源，再核对工具输出。' }, { type: 'toolCall', id, name: 'read', arguments: { path: `web/src/features/module-${id}.tsx` } }] });
          value.messages.push({ role: 'toolResult', toolCallId: id, timestamp: at + 1250 + step * 3000, durationMs: 250, content: [{ type: 'text', text: `export function Module() {\n  return <section>第 ${round + 1} 轮模块内容</section>;\n}` }] });
        }
        value.messages.push({ role: 'assistant', timestamp: at + 50_000, content: [{ type: 'text', text: '布局审查完成。\n\n- 已核对组件状态\n- 已检查输入参数与执行结果' }] });
      }
      value.messages.forEach((message, index) => { message.sourceIndex = index; });
      return value;
    };
    api.models = async () => ({ models: [{ id: 'qa/a', name: '模型 A', provider: 'qa', model: 'a' }, { id: 'qa/b', name: '模型 B', provider: 'qa', model: 'b' }], enabled: ['qa/a', 'qa/b'], current: 'qa/a' });
    window.__evaluationQa = { parents: [], starts: [] };
    api.createConversation = async input => { window.__evaluationQa.parents.push(input); return { id: 'evaluation-root', cwd: input.cwd }; };
    api.conversationCompareStart = async input => { window.__evaluationQa.starts.push(input); throw new Error('QA 模拟启动失败'); };
  });
  await page.goto(server.origin);
  await page.locator('.workspace-row').first().waitFor();
  await page.getByRole('button', { name: '搜索工作区', exact: true }).click();
  await page.getByRole('searchbox', { name: '搜索工作区或会话', exact: true }).fill('精准目标');
  await page.locator('.session-row').filter({ hasText: '精准目标' }).click();
  await page.getByRole('tab', { name: '打开会话轨迹页面' }).click();
  assert.equal(await page.locator('.chat-tabs .tab-count').count(), 0);
  assert.equal(await page.locator('.comparison-tab').count(), 0);
  assert.equal(await page.locator('.conversation-trace-detail').count(), 0);
  assert.equal(await page.getByRole('button', { name: '全部时间', exact: true }).count(), 0);
  const frame = await page.locator('.conversation-trace-page-inner').boundingBox();
  const rows = page.locator('.conversation-trace-item');
  assert(await rows.count() > 96);
  assert.equal((await rows.first().boundingBox()).height, 32);
  await page.screenshot({ path: path.join(output, 'trace-default.png') });
  const cells = page.locator('.trace-activity-cell');
  assert.equal(await cells.count(), await rows.count());
  await cells.nth(2).hover();
  await page.getByRole('tooltip').waitFor();
  assert.match(await page.getByRole('tooltip').innerText(), /250 毫秒/);
  await page.screenshot({ path: path.join(output, 'trace-hover.png') });
  await cells.last().click();
  await page.getByRole('complementary', { name: '轨迹详情' }).waitFor();
  assert.equal((await page.locator('.conversation-trace-page-inner').boundingBox()).width, frame.width);
  assert(await page.locator('.conversation-trace-list').evaluate(node => node.scrollTop > 100));
  assert.equal(await page.locator('.conversation-trace-item.is-selected').count(), 1);
  await page.getByRole('button', { name: '关闭轨迹详情' }).click();
  assert.equal(await page.locator('.conversation-trace-detail').count(), 0);
  await page.getByRole('textbox', { name: '搜索轨迹' }).fill('module-0-0');
  await rows.first().click();
  await page.getByRole('tab', { name: '结果', exact: true }).click();
  assert.match(await page.locator('.trace-detail-content').innerText(), /export function Module/);
  await page.getByRole('tab', { name: '计时', exact: true }).click();
  assert.match(await page.locator('.trace-detail-content').innerText(), /250 毫秒/);
  await page.getByRole('tab', { name: '概述', exact: true }).click();
  await page.getByRole('textbox', { name: '搜索轨迹' }).fill('');
  await page.screenshot({ path: path.join(output, 'trace-detail.png') });
  await page.getByRole('button', { name: '关闭轨迹详情' }).click();
  await page.getByRole('button', { name: '子调用', exact: true }).click();
  assert.equal(await page.locator('.conversation-trace-item.lane-tool').count(), 0);
  await cells.nth(2).click();
  assert(await page.locator('.conversation-trace-item.lane-tool').count() > 0);
  results.checks.push('single-line rows, no default inspector, all activity items reachable, hover timing, activity jump, fixed outer width, result/timing tabs, close, search and display toggles');
  await page.getByRole('button', { name: '打开右侧面板', exact: true }).click();
  await page.getByRole('button', { name: '模型双跑', exact: true }).click();
  await page.locator('.comparison-prompt textarea').fill('用相同输入评估模型回答');
  await page.screenshot({ path: path.join(output, 'comparison.png') });
  const start = page.locator('.comparison-start-button');
  await start.click();
  await page.getByText('QA 模拟启动失败', { exact: true }).waitFor();
  await start.click();
  await page.waitForFunction(() => window.__evaluationQa.starts.length === 2);
  const log = await page.evaluate(() => window.__evaluationQa);
  assert.equal(log.parents.length, 1, 'retry must reuse the independent parent');
  assert.equal(log.starts[0].parentId, 'evaluation-root');
  assert.notEqual(log.starts[0].parentId, 'history');
  await page.evaluate(() => {
    window.piApi.conversationCompareStart = input => new Promise(resolve => {
      window.__evaluationQa.resolveStart = () => resolve({ id: 'evaluation-run', parentId: input.parentId, prompt: input.prompt, createdAt: Date.now(), branches: input.branches.map((branch, index) => ({ ...branch, sessionId: `eval-${index}`, worktreeId: `tree-${index}` })) });
    });
    window.piApi.conversationCompareSnapshot = async ({ branches }) => branches.map(branch => ({ ...branch, status: 'completed', running: false, compacting: false, metrics: { requests: 1, tokens: 100, costUsd: 0 }, answer: { text: '评估示例结果', streaming: false } }));
  });
  await start.click();
  await page.waitForFunction(() => Boolean(window.__evaluationQa.resolveStart));
  await page.getByRole('main').getByRole('button', { name: '收起右侧面板', exact: true }).click();
  await page.locator('.file-panel').waitFor({ state: 'detached' });
  await page.getByRole('button', { name: '打开右侧面板', exact: true }).click();
  await page.locator('.comparison-prompt textarea').waitFor();
  assert.equal(await page.locator('.comparison-start-button').isDisabled(), true);
  assert.equal(await page.getByRole('button', { name: '新评估', exact: true }).isDisabled(), true);
  await page.evaluate(() => window.__evaluationQa.resolveStart());
  await page.locator('.comparison-results').waitFor();
  await page.getByText('评估示例结果', { exact: true }).first().waitFor();
  await page.getByRole('button', { name: '新评估', exact: true }).click();
  assert.equal(await page.locator('.comparison-prompt textarea').inputValue(), '');
  await page.getByRole('button', { name: '评估历史', exact: true }).click();
  await page.getByRole('option').filter({ hasText: '用相同输入评估模型回答' }).click();
  await page.locator('.comparison-results').waitFor();
  results.checks.push('pending start remains guarded through panel close/reopen; success is saved and history reopens');
  results.checks.push('comparison opens in right workbench, creates independent evaluation parent, retries reuse parent');
  assert.deepEqual(results.errors, []);
} catch (error) {
  console.error(error);
  results.errors.push(String(error));
  process.exitCode = 1;
} finally {
  await writeFile(path.join(output, 'results.json'), JSON.stringify(results, null, 2));
  await Promise.race([browser?.close(), new Promise(resolve => setTimeout(resolve, 3000))]);
  await server.close();
}
console.log(JSON.stringify(results, null, 2));
