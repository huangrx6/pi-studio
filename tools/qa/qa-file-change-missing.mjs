/**
 * A turn summary can list files that were written during the turn and later moved or
 * deleted. Clicking such a row must degrade in place instead of surfacing the raw IPC
 * wrapper error and leaving a row that fails on every click.
 *
 * Run the Vite server first:
 *   pnpm run web
 *   node tools/qa/qa-file-change-missing.mjs
 */
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright-core';

const output = new URL('../../.qa/screenshots/file-change-missing/', import.meta.url).pathname;
await mkdir(output, { recursive: true });

const browser = await chromium.launch({
  executablePath: process.env.CHROME_BIN || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
});

try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 860 }, deviceScaleFactor: 2 });
  page.setDefaultTimeout(10_000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));

  await page.addInitScript(() => {
    localStorage.setItem('pi-studio:preferences', JSON.stringify({ showCodeView: true }));
    const cwd = '/workspace/pi-studio';
    const model = { modelRef: 'demo/model', label: 'Demo', thinkingLevel: 'default', thinkingLevels: ['default'], effectiveThinkingLevel: 'off' };
    const gone = '/workspace/pi-studio/.qa/probe-outline.mjs';
    const kept = '/workspace/pi-studio/web/src/shared/runtime-refresh.ts';
    const messages = [
      { role: 'user', timestamp: 1, content: [{ type: 'text', text: '整理一下大纲回归脚本' }] },
      {
        role: 'assistant',
        timestamp: 2,
        content: [
          { type: 'text', text: '我先写两个脚本。' },
          { type: 'toolCall', id: 'w1', name: 'write', arguments: { path: gone, content: 'export const a = 1;\n' } },
          { type: 'toolCall', id: 'w2', name: 'write', arguments: { path: kept, content: 'export const b = 2;\n' } },
        ],
      },
      { role: 'toolResult', timestamp: 3, toolCallId: 'w1', content: [{ type: 'text', text: 'ok' }] },
      { role: 'toolResult', timestamp: 4, toolCallId: 'w2', content: [{ type: 'text', text: 'ok' }] },
      { role: 'assistant', timestamp: 5, content: [{ type: 'text', text: '写好了。' }] },
    ];
    const session = { id: 'demo', cwd, title: '整理回归脚本', kind: 'conversation', goal: '', pinned: false, archived: false, createdAt: Date.now() - 60_000, updatedAt: Date.now(), messages, turnDiffs: [] };
    const listeners = new Set();
    const snapshot = () => ({ ...session, model, running: false, requestId: '', compacting: false, inbox: [], tools: [], nestedTools: [], usage: {}, agent: { cwd, name: 'QA Agent' } });
    window.__openRequests = [];
    window.piApi = new Proxy({
      state: async () => ({ workspaces: [{ cwd, name: 'pi-studio', sessions: [session] }], cwd, model }),
      conversationPage: async () => ({ ...snapshot(), messages, turnDiffs: [], page: { hasOlder: false }, messageStart: 0 }),
      conversationOutline: async () => ({ id: 'demo', items: [{ sourceIndex: 1, text: '整理一下大纲回归脚本', timestamp: 1 }], totalMessages: messages.length }),
      conversationSnapshot: async () => snapshot(),
      subscribeConversation: async () => snapshot(),
      unsubscribeConversation: async () => ({ ok: true }),
      onConversationEvent: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
      // 模拟 Electron 把主进程错误包成 "Error invoking remote method …"。
      turnDiffAbsoluteFile: async (payload) => {
        window.__openRequests.push(payload);
        if (payload?.path === gone) {
          throw new Error("Error invoking remote method 'pi:turn-diff-absolute-file': Error: 文件不存在或无法访问");
        }
        return { path: payload.path, text: 'export const b = 2;\n', size: 20, binary: false };
      },
      // 打开右栏会同时加载文件树；缺了它会让面板自身的错误覆盖掉被测提示。
      files: async () => ({ path: '', entries: [] }),
      modeGet: async () => ({ available: true, mode: 'smart' }),
      composerResources: async () => ({ commands: [], skills: [] }),
      extensionsUi: async () => ({ items: [], errors: [], syncedAt: Date.now(), apiVersion: 1 }),
      conversationExtensionUiPreferences: async () => ({ version: 1, layout: 'grid', globalOrder: [], sessionOrders: {} }),
    }, { get: (target, key) => key in target ? target[key] : String(key).startsWith('on') ? () => () => {} : async () => undefined });
  });

  await page.goto(process.env.PREVIEW_URL || 'http://127.0.0.1:5180');
  await page.locator('.workspace-row').first().click();
  await page.locator('.session-row').first().click();
  await page.locator('.file-change-summary').waitFor();
  assert.equal(await page.locator('.file-change-item').count(), 2);

  const missingRow = page.locator('.file-change-item').filter({ hasText: 'probe-outline.mjs' });
  await missingRow.click();

  // 1) 全局提示只含真实信息，不再暴露 IPC 通道名与包装语。
  const banner = page.locator('.error-card');
  await banner.waitFor();
  const bannerText = await banner.innerText();
  assert.match(bannerText, /文件不存在或无法访问/);
  assert.doesNotMatch(bannerText, /remote method|pi:turn-diff-absolute-file/);

  await page.locator('.error-card').screenshot({ path: `${output}banner.png`, animations: 'disabled' });

  // 1.5) 错误卡可以关闭，不会一直挂在对话里。
  await page.getByRole('button', { name: '关闭错误提示', exact: true }).click();
  await banner.waitFor({ state: 'detached' });

  // 2) 该行原地失效：不再可点，并说明原因。
  await page.waitForFunction(() => document.querySelectorAll('.file-change-item.is-missing').length === 1);
  assert.equal(await missingRow.isDisabled(), true);
  assert.match(await missingRow.innerText(), /已移出磁盘/);
  assert.match(await page.locator('.file-change-missing-note').innerText(), /1 个文件已不在磁盘上/);
  const requestsAfterFirst = await page.evaluate(() => window.__openRequests.length);
  await missingRow.click({ force: true });
  await page.waitForTimeout(150);
  assert.equal(await page.evaluate(() => window.__openRequests.length), requestsAfterFirst, 'a missing row must not retry');

  // 3) 同一张汇总里其它文件仍然可以打开。
  const keptRow = page.locator('.file-change-item').filter({ hasText: 'fresh.mjs' });
  await keptRow.click();
  await page.waitForFunction(() => window.__openRequests.some((request) => request.path.endsWith('fresh.mjs')));
  await page.locator('.file-panel').waitFor();
  await page.screenshot({ path: `${output}missing-file.png`, animations: 'disabled' });

  assert.deepEqual(errors, []);
  console.log(`PASS: a deleted turn file is marked in place, the banner shows the plain reason, and other rows still open. Screenshot: ${output}`);
} finally {
  await browser.close();
}
