// Production-renderer regression: drafts and queued prompts survive reloads
// through IndexedDB without replaying a queued submission automatically.
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright-core';

const output = new URL('../../.qa/screenshots/composer-persistence/', import.meta.url).pathname;
const baseUrl = process.env.PI_STUDIO_QA_BASE_URL || 'http://127.0.0.1:5180';
await mkdir(output, { recursive: true });

const browser = await chromium.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
});
const errors = [];

function sleep(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

async function readPersistedSnapshot(page) {
  return page.evaluate(() => new Promise((resolve, reject) => {
    const open = indexedDB.open('pi-studio-composer-state', 1);
    open.onerror = () => reject(open.error || new Error('IndexedDB open failed'));
    open.onupgradeneeded = () => {
      if (!open.result.objectStoreNames.contains('snapshots')) {
        open.result.createObjectStore('snapshots');
      }
    };
    open.onsuccess = () => {
      const database = open.result;
      const transaction = database.transaction('snapshots', 'readonly');
      const request = transaction.objectStore('snapshots').get('current');
      request.onerror = () => reject(request.error || new Error('IndexedDB read failed'));
      request.onsuccess = () => resolve(request.result || null);
      transaction.oncomplete = () => database.close();
    };
  }));
}

async function waitForSnapshot(page, predicate) {
  let snapshot = null;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    snapshot = await readPersistedSnapshot(page);
    if (snapshot && predicate(snapshot)) return snapshot;
    await sleep(100);
  }
  throw new Error(`Persisted composer snapshot did not become ready: ${JSON.stringify(snapshot)}`);
}

try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
  page.setDefaultTimeout(10_000);
  page.on('pageerror', error => errors.push(error.stack || error.message));

  await page.addInitScript(() => {
    // Run on every document load so startup depends on the active draft stored
    // in IndexedDB, not the convenience copy in localStorage.
    localStorage.clear();
    localStorage.setItem('pi-studio:preferences', JSON.stringify({ busySend: 'queue' }));
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
        id: 'persist-session-a',
        cwd: '/workspace',
        title: '持久化会话 A',
        kind: 'conversation',
        goal: '',
        pinned: false,
        archived: false,
        createdAt: Date.now() - 30_000,
        updatedAt: Date.now(),
        messageCount: 1,
        running: false,
        messages: [{ role: 'assistant', timestamp: 1, content: [{ type: 'text', text: '会话 A 已就绪。' }] }],
      },
      {
        id: 'persist-session-running',
        cwd: '/workspace',
        title: '运行中的持久化会话',
        kind: 'conversation',
        goal: '',
        pinned: false,
        archived: false,
        createdAt: Date.now() - 20_000,
        updatedAt: Date.now() - 1,
        messageCount: 1,
        running: true,
        messages: [{ role: 'assistant', timestamp: 2, content: [{ type: 'text', text: '仍在执行。' }] }],
      },
      {
        id: 'persist-session-b',
        cwd: '/workspace',
        title: '持久化会话 B',
        kind: 'conversation',
        goal: '',
        pinned: false,
        archived: false,
        createdAt: Date.now() - 10_000,
        updatedAt: Date.now() - 2,
        messageCount: 1,
        running: false,
        messages: [{ role: 'assistant', timestamp: 3, content: [{ type: 'text', text: '会话 B 已就绪。' }] }],
      },
    ];
    const summaryOf = ({ messages: _messages, ...summary }) => summary;
    const byId = id => sessions.find(session => session.id === id);
    const snapshot = id => {
      const session = byId(id);
      return {
        ...summaryOf(session),
        requestId: session.running ? 'running-request' : '',
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
    window.qaComposerPersistence = { calls: [] };

    window.piApi = new Proxy({
      state: async () => ({
        workspaces: [{
          cwd: '/workspace',
          name: 'Composer persistence fixture',
          sessions: sessions.map(summaryOf),
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
          id: 'persisted-image',
          kind: 'image',
          name: 'persisted.png',
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
      conversationOutline: async id => ({
        id,
        items: [],
        totalMessages: byId(id).messages.length,
      }),
      conversationSnapshot: async id => snapshot(id),
      subscribeConversation: async id => snapshot(id),
      unsubscribeConversation: async () => ({ ok: true }),
      sessionSubagents: async () => [],
      conversationSubmit: async payload => {
        window.qaComposerPersistence.calls.push(payload);
        return {
          conversationId: payload.id,
          submissionId: 'confirmed-recovered-queue',
          requestId: payload.requestId,
          status: 'accepted',
          whenBusy: payload.whenBusy,
        };
      },
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
      saveConversationExtensionUiPreferences: async value => ({
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

  await page.goto(baseUrl);
  await page.locator('.workspace-row').first().click();
  const composer = page.locator('.composer textarea');
  const sessionA = page.locator('.session-row').filter({ hasText: '持久化会话 A' });
  const runningSession = page.locator('.session-row').filter({ hasText: '运行中的持久化会话' });

  await sessionA.click();
  await composer.fill('会话 A 跨重启草稿');
  await page.getByRole('button', { name: '添加图片或文件' }).click();
  await page.locator('.composer-attachments .composer-image-preview-trigger').waitFor();
  await waitForSnapshot(page, snapshot => (
    snapshot.activeDraftKey === 'session:persist-session-a'
    && snapshot.drafts?.some(draft => (
      draft.key === 'session:persist-session-a'
      && draft.text === '会话 A 跨重启草稿'
      && draft.attachments?.length === 1
    ))
  ));

  await page.reload();
  await page.getByRole('heading', { name: '持久化会话 A' }).waitFor();
  assert.equal(await composer.inputValue(), '会话 A 跨重启草稿');
  assert.equal(await page.locator('.composer-attachments .composer-image-preview-trigger').count(), 1);

  await page.locator('.new-chat').click();
  await composer.fill('新对话工作区跨重启草稿');
  await waitForSnapshot(page, snapshot => (
    snapshot.activeDraftKey === 'new:/workspace'
    && snapshot.drafts?.some(draft => (
      draft.key === 'new:/workspace'
      && draft.text === '新对话工作区跨重启草稿'
    ))
  ));

  await page.reload();
  await page.locator('.new-conversation-welcome').waitFor();
  assert.equal(await composer.inputValue(), '新对话工作区跨重启草稿');

  await runningSession.click();
  await composer.fill('刷新后必须等待确认的排队消息');
  await composer.press('Control+Enter');
  const queuePanel = page.locator('.queued-panel[aria-label="排队消息"]');
  await queuePanel.waitFor();
  const queuedSnapshot = await waitForSnapshot(page, snapshot => (
    snapshot.activeDraftKey === 'session:persist-session-running'
    && snapshot.queues?.some(queue => (
      queue.sessionId === 'persist-session-running'
      && queue.items?.some(item => item.text === '刷新后必须等待确认的排队消息')
    ))
  ));
  const queuedItem = queuedSnapshot.queues
    .find(queue => queue.sessionId === 'persist-session-running')
    .items.find(item => item.text === '刷新后必须等待确认的排队消息');
  assert.equal(await page.evaluate(() => window.qaComposerPersistence.calls.length), 0);

  await page.reload();
  await page.getByRole('heading', { name: '运行中的持久化会话' }).waitFor();
  await queuePanel.waitFor();
  await page.waitForTimeout(700);
  assert.equal(await queuePanel.locator('.queued-item').count(), 1);
  await queuePanel.getByText('上次退出前未发送；确认后再发送。', { exact: true }).waitFor();
  assert.equal(
    await page.evaluate(() => window.qaComposerPersistence.calls.length),
    0,
    'a restored queue must not submit automatically',
  );
  await page.screenshot({ path: `${output}restored-queue.png`, animations: 'disabled' });

  await queuePanel.getByRole('button', { name: '立即插话发送' }).click();
  await page.waitForFunction(() => window.qaComposerPersistence.calls.length === 1);
  const call = await page.evaluate(() => window.qaComposerPersistence.calls[0]);
  assert.equal(call.id, 'persist-session-running');
  assert.equal(call.text, '刷新后必须等待确认的排队消息');
  assert.equal(call.requestId, queuedItem.submission.requestId);
  await queuePanel.waitFor({ state: 'detached' });
  assert.equal(await page.evaluate(() => window.qaComposerPersistence.calls.length), 1);
  assert.deepEqual(errors, []);
  console.log('PASS: drafts and attachments survive reloads; restored queues wait for one explicit confirmation before submitting.');
} catch (error) {
  const page = browser.contexts()[0]?.pages()[0];
  if (page) {
    await page.screenshot({ path: `${output}failure.png` });
    console.error('browser errors:', errors);
    console.error('body:', (await page.locator('body').innerText()).slice(0, 2_000));
  }
  throw error;
} finally {
  await browser.close();
}
