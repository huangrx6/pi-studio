/**
 * Sidebar focus regression: clicking a running session must not pin its hover
 * actions. Keyboard focus inside those actions must still keep them visible.
 *
 * Run with the local Vite server:
 *   pnpm run web
 *   node tools/qa/qa-sidebar-running-state.mjs
 */
import { chromium } from 'playwright-core';
import { mkdir } from 'node:fs/promises';
import assert from 'node:assert/strict';

const output = new URL('../../.qa/screenshots/sidebar-running-state/', import.meta.url).pathname;
await mkdir(output, { recursive: true });

const browser = await chromium.launch({
  executablePath: process.env.CHROME_BIN || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
});

try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 920 }, deviceScaleFactor: 2 });
  page.setDefaultTimeout(10000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));

  await page.addInitScript(() => {
    const cwd = '/workspace/pi-studio';
    const now = Date.now();
    const model = {
      modelRef: 'demo/model',
      label: 'Demo Model',
      thinkingLevel: 'default',
      thinkingLevels: ['default'],
      effectiveThinkingLevel: 'off',
    };
    const sessions = [
      {
        id: 'running-session',
        cwd,
        title: '运行中会话',
        kind: 'conversation',
        goal: '',
        pinned: false,
        archived: false,
        running: true,
        createdAt: now - 60_000,
        updatedAt: now - 5_000,
        messageCount: 1,
      },
      {
        id: 'idle-session',
        cwd,
        title: '空闲会话',
        kind: 'conversation',
        goal: '',
        pinned: false,
        archived: false,
        running: false,
        createdAt: now - 120_000,
        updatedAt: now - 120_000,
        messageCount: 1,
      },
    ];
    const messages = [{ role: 'user', content: [{ type: 'text', text: '检查侧边栏状态' }] }];
    const listeners = new Set();
    const session = (id) => sessions.find((item) => item.id === id);
    const snapshot = (id) => ({
      ...session(id),
      model,
      requestId: 'running-request',
      compacting: false,
      inbox: [],
      tools: [],
      nestedTools: [],
      usage: {},
      agent: { cwd, name: 'Sidebar QA Agent' },
    });

    window.piApi = new Proxy({
      state: async () => ({ workspaces: [{ cwd, name: 'pi-studio', sessions }], model }),
      conversationPage: async ({ id }) => ({
        ...snapshot(id),
        messages,
        turnDiffs: [],
        page: { hasOlder: false },
        messageStart: 0,
      }),
      conversationOutline: async (id) => ({
        id,
        items: [{ sourceIndex: 0, text: '检查侧边栏状态', timestamp: now - 60_000 }],
        totalMessages: messages.length,
      }),
      conversationSnapshot: async (id) => snapshot(id),
      subscribeConversation: async (id) => snapshot(id),
      unsubscribeConversation: async () => ({ ok: true }),
      onConversationEvent: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      sessionSubagents: async () => [],
      modeGet: async () => ({ available: true, mode: 'smart' }),
      composerResources: async () => ({ commands: [], skills: [] }),
      extensionsUi: async () => ({ items: [], errors: [], syncedAt: Date.now(), apiVersion: 1 }),
      conversationExtensionUiPreferences: async () => ({
        version: 1,
        layout: 'grid',
        globalOrder: [],
        sessionOrders: {},
      }),
      saveConversationExtensionUiPreferences: async (value) => ({
        version: 1,
        layout: value?.layout || 'grid',
        globalOrder: value?.globalOrder || [],
        sessionOrders: {},
      }),
    }, {
      get(target, key) {
        if (key in target) return target[key];
        if (String(key).startsWith('on')) return () => () => {};
        return async () => undefined;
      },
    });
  });

  const assertRestored = async () => page.waitForFunction(() => {
    const shell = Array.from(document.querySelectorAll('.session-row-shell'))
      .find((element) => element.querySelector('.session-title')?.textContent === '运行中会话');
    const actions = shell?.querySelector('.sidebar-row-actions');
    const spinner = shell?.querySelector('.session-running');
    return actions
      && spinner
      && getComputedStyle(actions).visibility === 'hidden'
      && spinner.getBoundingClientRect().width > 0;
  });

  try {
    await page.goto(process.env.PREVIEW_URL || 'http://127.0.0.1:5180');
    await page.locator('.workspace-row').first().waitFor();
    if (!await page.locator('.session-row-shell').count()) {
      await page.locator('.workspace-row').first().click();
    }
    await page.locator('.session-row-shell').first().waitFor();

    const runningShell = page.locator('.session-row-shell').filter({
      has: page.locator('.session-title', { hasText: '运行中会话' }),
    });
    await runningShell.locator('.session-row').click();
    await page.mouse.move(1320, 860);
    await assertRestored();
    await page.screenshot({ path: `${output}after-row-click.png`, animations: 'disabled' });

    await runningShell.hover();
    const more = page.getByRole('button', { name: '运行中会话的更多操作', exact: true });
    await more.focus();
    await page.mouse.move(1320, 860);
    assert.equal(
      await runningShell.locator('.sidebar-row-actions').evaluate((element) => getComputedStyle(element).visibility),
      'visible',
    );
    await page.screenshot({ path: `${output}keyboard-action-focus.png`, animations: 'disabled' });

    await page.evaluate(() => document.activeElement instanceof HTMLElement && document.activeElement.blur());
    await assertRestored();
    assert.deepEqual(errors, []);
    console.log(`PASS: sidebar running state restored after click. Screenshots: ${output}`);
  } catch (error) {
    console.error('Sidebar running-state QA failed.', { url: page.url(), errors });
    throw error;
  }
} finally {
  await browser.close();
}
