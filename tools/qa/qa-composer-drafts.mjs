// Session-scoped composer regression: unsent drafts must survive chat switches.
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';

const browser = await chromium.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
});
const errors = [];

try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
  page.setDefaultTimeout(8000);
  page.on('pageerror', (error) => errors.push(error.stack || error.message));

  await page.addInitScript(() => {
    localStorage.clear();
    const model = {
      modelRef: 'demo/model',
      label: 'Demo',
      thinkingLevel: 'default',
      thinkingLevels: ['default'],
      effectiveThinkingLevel: 'off',
      defaultThinkingLevel: 'off',
      supportsImages: true,
    };
    const sessions = [
      {
        id: 'draft-session-a',
        cwd: '/workspace',
        title: '草稿会话 A',
        kind: 'conversation',
        goal: '',
        pinned: false,
        archived: false,
        createdAt: Date.now() - 20_000,
        updatedAt: Date.now(),
        messageCount: 1,
        running: false,
        messages: [{ role: 'assistant', timestamp: 1, content: [{ type: 'text', text: '会话 A' }] }],
      },
      {
        id: 'draft-session-b',
        cwd: '/workspace',
        title: '草稿会话 B',
        kind: 'conversation',
        goal: '',
        pinned: false,
        archived: false,
        createdAt: Date.now() - 10_000,
        updatedAt: Date.now() - 1,
        messageCount: 1,
        running: false,
        messages: [{ role: 'assistant', timestamp: 2, content: [{ type: 'text', text: '会话 B' }] }],
      },
    ];
    const summary = ({ messages: _messages, ...session }) => session;
    const byId = (id) => sessions.find((session) => session.id === id);
    const snapshot = (id) => ({
      ...summary(byId(id)),
      requestId: '',
      running: false,
      compacting: false,
      inbox: [],
      tools: [],
      nestedTools: [],
      usage: {},
      model,
      agent: { cwd: '/workspace', name: 'QA Agent' },
    });

    window.piApi = new Proxy({
      state: async () => ({
        workspaces: [{
          cwd: '/workspace',
          name: 'Draft fixture',
          sessions: sessions.map(summary),
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
      pickAttachments: async () => ({
        attachments: [{
          id: 'draft-image',
          kind: 'image',
          name: 'draft.png',
          mime: 'image/png',
          bytes: 68,
          data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jZ1sAAAAASUVORK5CYII=',
        }],
      }),
      conversationPage: async ({ id }) => ({
        ...snapshot(id),
        messages: byId(id).messages,
        requestTraces: [],
        turnDiffs: [],
        page: { hasOlder: false },
        messageStart: 0,
      }),
      conversationOutline: async (id) => ({ id, items: [], totalMessages: byId(id).messages.length }),
      conversationSnapshot: async (id) => snapshot(id),
      subscribeConversation: async (id) => snapshot(id),
      unsubscribeConversation: async () => ({ ok: true }),
      sessionSubagents: async () => [],
      onConversationListChanged: () => () => {},
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
  const sessionA = page.locator('.session-row').filter({ hasText: '草稿会话 A' });
  const sessionB = page.locator('.session-row').filter({ hasText: '草稿会话 B' });
  const composer = page.locator('.composer textarea');

  await sessionA.click();
  await composer.fill('只属于会话 A 的草稿');
  await page.getByRole('button', { name: '添加图片或文件' }).click();
  await page.locator('.composer-attachments .composer-image-preview-trigger').waitFor();
  await sessionB.click();
  assert.equal(await composer.inputValue(), '', '会话 B 不应继承会话 A 的草稿');
  assert.equal(await page.locator('.composer-attachments .composer-image-preview-trigger').count(), 0, '会话 B 不应继承会话 A 的附件');
  await composer.fill('只属于会话 B 的草稿');
  await sessionA.click();
  assert.equal(await composer.inputValue(), '只属于会话 A 的草稿');
  assert.equal(await page.locator('.composer-attachments .composer-image-preview-trigger').count(), 1, '会话 A 的附件应随草稿恢复');
  await sessionB.click();
  assert.equal(await composer.inputValue(), '只属于会话 B 的草稿');

  await page.locator('.new-chat').click();
  assert.equal(await composer.inputValue(), '', '新对话不应继承已有会话草稿');
  await composer.fill('未创建会话的工作区草稿');
  await sessionA.click();
  assert.equal(await composer.inputValue(), '只属于会话 A 的草稿');
  await page.locator('.new-chat').click();
  assert.equal(await composer.inputValue(), '未创建会话的工作区草稿');

  assert.deepEqual(errors, []);
  console.log('PASS: composer text and attachment state are isolated by conversation and survive switching.');
} catch (error) {
  const page = browser.contexts()[0]?.pages()[0];
  if (page) {
    console.error('browser errors:', errors);
    console.error('body:', (await page.locator('body').innerText()).slice(0, 1600));
  }
  throw error;
} finally {
  await browser.close();
}
