/**
 * Durable compaction UI regression.
 *
 * Run the Vite server first:
 *   pnpm run web
 *   node tools/qa/qa-compaction-dock.mjs
 */
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright-core';

const output = new URL('../../.qa/screenshots/durable-compaction/', import.meta.url).pathname;
await mkdir(output, { recursive: true });

const browser = await chromium.launch({
  executablePath: process.env.CHROME_BIN || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
});

try {
  const page = await browser.newPage({ viewport: { width: 1_200, height: 820 }, deviceScaleFactor: 2 });
  page.setDefaultTimeout(10_000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));

  await page.addInitScript(() => {
    const cwd = '/workspace/durable-compaction';
    const model = {
      modelRef: 'demo/reasoner',
      label: 'Demo Reasoner',
      thinkingLevel: 'high',
      thinkingLevels: ['default', 'high'],
      effectiveThinkingLevel: 'high',
    };
    const summary = {
      id: 'durable-compaction-session',
      cwd,
      title: 'Durable 压缩恢复测试',
      kind: 'conversation',
      goal: '',
      pinned: false,
      archived: false,
      createdAt: Date.now() - 60_000,
      updatedAt: Date.now(),
      messageCount: 2,
    };
    const messages = [
      { role: 'user', sourceIndex: 0, timestamp: 1, content: [{ type: 'text', text: '继续优化代码' }] },
      { role: 'assistant', sourceIndex: 1, timestamp: 2, content: [{ type: 'text', text: '我先检查当前实现。' }] },
    ];
    const listeners = new Set();
    let revision = 0;
    window.running = false;
    const snapshot = () => ({
      ...summary,
      model,
      running: window.running,
      requestId: window.running ? 'durable-compaction-request' : '',
      compacting: false,
      inbox: [],
      tools: [],
      nestedTools: [],
      usage: {},
      agent: { cwd, name: 'QA Agent' },
    });
    window.emitConversation = (type, payload = {}) => {
      if (type === 'run.started') window.running = true;
      if (type === 'run.completed' || type === 'run.failed') window.running = false;
      revision += 1;
      for (const listener of listeners) listener({
        type,
        payload,
        conversationId: summary.id,
        revision,
      });
    };
    window.piApi = new Proxy({
      state: async () => ({ workspaces: [{ cwd, name: 'Durable QA', sessions: [summary] }], model }),
      models: async () => ({
        models: [{ id: model.modelRef, name: model.label, provider: 'demo', providerName: 'Demo' }],
        enabled: [model.modelRef],
        current: model.modelRef,
        selection: model,
        defaultSelection: model,
      }),
      conversationPage: async () => ({
        ...snapshot(),
        messages,
        turnDiffs: [],
        page: { hasOlder: false },
        messageStart: 0,
      }),
      conversationOutline: async () => ({
        id: summary.id,
        items: [{ sourceIndex: 0, text: '继续优化代码', timestamp: 1 }],
        totalMessages: messages.length,
      }),
      conversationSnapshot: async () => snapshot(),
      subscribeConversation: async () => snapshot(),
      unsubscribeConversation: async () => ({ ok: true }),
      conversationSubmit: async input => {
        window.running = true;
        return {
          conversationId: input.id,
          submissionId: 'durable-compaction-submission',
          requestId: input.requestId,
          status: 'placed',
          whenBusy: 'followUp',
        };
      },
      sessionSubagents: async () => [],
      onConversationEvent: listener => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      modeGet: async () => ({ available: true, mode: 'full' }),
      composerResources: async () => ({ commands: [], skills: [] }),
      extensionsUi: async () => ({ items: [], errors: [], syncedAt: Date.now(), apiVersion: 1 }),
    }, {
      get: (target, key) => key in target
        ? target[key]
        : String(key).startsWith('on')
          ? () => () => {}
          : async () => undefined,
    });
  });

  await page.goto(process.env.PREVIEW_URL || 'http://127.0.0.1:5180', { waitUntil: 'domcontentloaded' });
  await page.locator('.workspace-row').first().click();
  await page.locator('.session-row').first().click();
  await page.locator('.composer textarea').fill('继续优化代码');
  await page.getByRole('button', { name: '发送消息', exact: true }).click();

  await page.evaluate(() => window.emitConversation('compaction.started', { reason: 'manual' }));
  await page.locator('.compaction-banner').waitFor();
  assert.match(await page.locator('.composer textarea').getAttribute('placeholder'), /正在压缩上下文/);
  assert.equal(await page.locator('.send-button[aria-label="正在压缩上下文"]:not(:disabled)').count(), 0);
  await page.evaluate(() => window.emitConversation('compaction.completed'));
  await page.locator('.compaction-banner').waitFor({ state: 'detached' });
  assert.doesNotMatch(await page.locator('.composer textarea').getAttribute('placeholder'), /压缩/);

  await page.evaluate(() => window.emitConversation('assistant.updated', {
    message: {
      role: 'assistant',
      timestamp: 10,
      content: [{ type: 'text', text: '压缩完成，继续检查代码。' }],
    },
  }));
  await page.getByText('压缩完成，继续检查代码。', { exact: true }).waitFor();
  await page.locator('.composer textarea').fill('补充说明');
  assert.equal(await page.locator('.send-button[aria-label="补充当前任务"]').isDisabled(), false);

  // Completed-but-aborted compaction and a later run completion remain idempotent.
  await page.evaluate(() => window.emitConversation('compaction.started'));
  await page.locator('.compaction-banner').waitFor();
  await page.evaluate(() => window.emitConversation('compaction.completed', { aborted: true }));
  await page.locator('.compaction-banner').waitFor({ state: 'detached' });
  await page.evaluate(() => window.emitConversation('run.completed', { inputs: [] }));

  for (const theme of ['light', 'dark']) {
    await page.evaluate(next => { document.documentElement.dataset.theme = next; }, theme);
    await page.screenshot({ path: `${output}${theme}.png`, animations: 'disabled' });
  }

  assert.deepEqual(errors, []);
  console.log('PASS: Durable compaction events lock and unlock the composer, late aborts stay idempotent, and both themes render without overflow.');
} finally {
  await browser.close();
}
