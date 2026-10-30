// Session-scoped queue regression: switching chats must not erase pending input.
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright-core';

const output = new URL('../../.qa/screenshots/queued-prompts/', import.meta.url).pathname;
await mkdir(output, { recursive: true });

const browser = await chromium.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
});
const errors = [];

try {
  const page = await browser.newPage({ viewport: { width: 1500, height: 960 }, deviceScaleFactor: 2 });
  page.setDefaultTimeout(8000);
  page.on('pageerror', (error) => errors.push(error.stack || error.message));

  await page.addInitScript(() => {
    localStorage.clear();
    localStorage.setItem('pi-studio:preferences', JSON.stringify({ busySend: 'queue' }));
    const model = {
      modelRef: 'demo/model',
      label: 'Demo',
      thinkingLevel: 'default',
      thinkingLevels: ['default'],
      effectiveThinkingLevel: 'off',
    };
    const sessions = [
      {
        id: 'queue-session-a',
        cwd: '/workspace',
        title: '会话 A',
        kind: 'conversation',
        goal: '',
        pinned: false,
        archived: false,
        createdAt: Date.now() - 60_000,
        updatedAt: Date.now(),
        messageCount: 2,
        running: true,
        messages: [
          { role: 'user', timestamp: 1, content: [{ type: 'text', text: '先处理会话 A' }] },
          { role: 'assistant', timestamp: 2, content: [{ type: 'text', text: '会话 A 正在执行。' }] },
        ],
      },
      {
        id: 'queue-session-b',
        cwd: '/workspace',
        title: '会话 B',
        kind: 'conversation',
        goal: '',
        pinned: false,
        archived: false,
        createdAt: Date.now() - 30_000,
        updatedAt: Date.now() - 1,
        messageCount: 1,
        running: false,
        messages: [
          { role: 'assistant', timestamp: 3, content: [{ type: 'text', text: '会话 B 空闲。' }] },
        ],
      },
    ];
    const listListeners = new Set();
    window.qaQueue = {
      calls: [],
      finishSessionA() {
        sessions[0].running = false;
        for (const listener of listListeners) listener();
      },
    };
    const sessionSummary = (session) => {
      const { messages: _messages, ...summary } = session;
      return summary;
    };
    const sessionsById = () => new Map(sessions.map((session) => [session.id, session]));
    const snapshot = (id) => {
      const session = sessionsById().get(id);
      return {
        ...sessionSummary(session),
        requestId: session.running ? 'request-a' : '',
        running: session.running,
        compacting: false,
        inbox: [],
        tools: [],
        nestedTools: [],
        usage: {},
        model,
        agent: { cwd: session.cwd, name: 'QA Agent' },
      };
    };

    window.piApi = new Proxy({
      state: async () => ({
        workspaces: [{
          cwd: '/workspace',
          name: 'Queue fixture',
          sessions: sessions.map(sessionSummary),
        }],
        model,
      }),
      models: async () => ({
        models: [{ id: 'demo/model', name: 'Demo', provider: 'demo', providerName: 'Demo' }],
        enabled: [],
        current: 'demo/model',
        selection: model,
        defaultSelection: model,
      }),
      conversationPage: async ({ id }) => {
        const session = sessionsById().get(id);
        return {
          ...snapshot(id),
          messages: session.messages,
          turnDiffs: [],
          page: { hasOlder: false },
          messageStart: 0,
        };
      },
      conversationOutline: async (id) => ({
        id,
        items: sessionsById().get(id).messages
          .flatMap((message, sourceIndex) => message.role === 'user'
            ? [{ sourceIndex, text: message.content[0]?.text || '', timestamp: message.timestamp }]
            : []),
        totalMessages: sessionsById().get(id).messages.length,
      }),
      conversationSnapshot: async (id) => snapshot(id),
      subscribeConversation: async (id) => snapshot(id),
      unsubscribeConversation: async () => ({ ok: true }),
      sessionSubagents: async () => [],
      conversationSubmit: async (payload) => {
        window.qaQueue.calls.push(payload);
        const session = sessionsById().get(payload.id);
        session.running = true;
        return {
          conversationId: payload.id,
          submissionId: 'queued-submit',
          requestId: payload.requestId,
          status: 'queued',
          whenBusy: payload.whenBusy,
        };
      },
      conversationInterrupt: async () => ({ ok: true, wasRunning: true }),
      onConversationListChanged: (listener) => {
        listListeners.add(listener);
        return () => listListeners.delete(listener);
      },
      onConversationEvent: () => () => {},
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
      get: (target, key) => (
        key in target
          ? target[key]
          : String(key).startsWith('on')
            ? () => () => {}
            : async () => undefined
      ),
    });
  });

  await page.goto('http://127.0.0.1:5180');
  await page.locator('.workspace-row').first().click();
  await page.locator('.session-row').filter({ hasText: '会话 A' }).click();
  const composer = page.locator('.composer textarea');
  await composer.fill('切换会话后仍然保留的排队消息');
  await page.getByRole('button', { name: '排队发送', exact: true }).click();
  const queuePanel = page.locator('.queued-panel[aria-label="排队消息"]');
  await queuePanel.waitFor();
  assert.equal(await page.getByText('切换会话后仍然保留的排队消息', { exact: true }).count(), 1);

  await page.locator('.session-row').filter({ hasText: '会话 B' }).click();
  assert.equal(await queuePanel.count(), 0, 'session B has its own empty queue');
  assert.equal((await page.evaluate(() => window.qaQueue.calls.length)), 0, 'switching must not submit session A queue');

  await page.locator('.session-row').filter({ hasText: '会话 A' }).click();
  await queuePanel.waitFor();
  assert.equal(await page.getByText('切换会话后仍然保留的排队消息', { exact: true }).count(), 1);
  await page.screenshot({ path: output + 'restored-after-switch.png', animations: 'disabled' });

  // Finish session A while session B is open. The queue must still submit to A
  // without leaking its optimistic user message into B.
  await page.locator('.session-row').filter({ hasText: '会话 B' }).click();
  await page.evaluate(() => window.qaQueue.finishSessionA());
  await page.waitForFunction(() => window.qaQueue.calls.length === 1);
  const submitted = await page.evaluate(() => window.qaQueue.calls[0]);
  assert.equal(submitted.id, 'queue-session-a');
  assert.equal(submitted.text, '切换会话后仍然保留的排队消息');
  assert.equal(submitted.whenBusy, 'followUp');
  await page.getByRole('heading', { name: '会话 B' }).waitFor();
  assert.equal(await page.getByText('会话 B 空闲。', { exact: true }).count(), 1);
  await queuePanel.waitFor({ state: 'detached' });
  assert.deepEqual(errors, []);
  console.log('PASS: queued prompts are session-scoped, survive switching, and submit to their original session while another chat is open.');
} catch (error) {
  const page = browser.contexts()[0]?.pages()[0];
  if (page) {
    await page.screenshot({ path: output + 'failure.png' });
    console.error('browser errors:', errors);
    console.error('body:', (await page.locator('body').innerText()).slice(0, 1600));
  }
  throw error;
} finally {
  await browser.close();
}
