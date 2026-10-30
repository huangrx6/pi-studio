// Image context-menu regression: composer, conversation, and preview images expose copy actions.
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright-core';

const output = new URL('../../.qa/screenshots/image-copy-menu/', import.meta.url).pathname;
await mkdir(output, { recursive: true });
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
    const canvas = document.createElement('canvas');
    canvas.width = 320;
    canvas.height = 180;
    const context = canvas.getContext('2d');
    context.fillStyle = '#0d0f10';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = '#b8f25d';
    context.fillRect(56, 48, 208, 84);
    const imageSrc = canvas.toDataURL('image/png');
    const png = imageSrc.slice(imageSrc.indexOf(',') + 1);
    const model = {
      modelRef: 'demo/model',
      label: 'Demo',
      thinkingLevel: 'default',
      thinkingLevels: ['default'],
      effectiveThinkingLevel: 'off',
      defaultThinkingLevel: 'off',
      supportsImages: true,
    };
    const messages = [
      {
        role: 'user',
        timestamp: 1,
        content: [
          { type: 'text', text: '检查这张图片' },
          { type: 'image', mimeType: 'image/png', data: png },
        ],
      },
      { role: 'assistant', timestamp: 2, content: [{ type: 'text', text: '图片已收到。' }] },
    ];
    const session = {
      id: 'image-copy-session',
      cwd: '/workspace',
      title: '图片复制测试',
      kind: 'conversation',
      goal: '',
      pinned: false,
      archived: false,
      createdAt: Date.now() - 10_000,
      updatedAt: Date.now(),
      messageCount: messages.length,
      running: false,
      messages,
    };
    const summary = ({ messages: _messages, ...value }) => value;
    const snapshot = {
      ...summary(session),
      requestId: '',
      compacting: false,
      inbox: [],
      tools: [],
      nestedTools: [],
      usage: {},
      model,
      agent: { cwd: '/workspace', name: 'QA Agent' },
    };

    window.copyImageCalls = [];
    window.piApi = new Proxy({
      state: async () => ({
        workspaces: [{ cwd: '/workspace', name: 'Image fixture', sessions: [summary(session)] }],
        model,
      }),
      models: async () => ({
        models: [{ id: 'demo/model', name: 'Demo', provider: 'demo', providerName: 'Demo', supportsImages: true }],
        enabled: ['demo/model'],
        current: 'demo/model',
        selection: model,
        defaultSelection: model,
      }),
      pickAttachments: async () => ({
        attachments: [{
          id: 'composer-image',
          kind: 'image',
          name: 'composer.png',
          mime: 'image/png',
          bytes: 68,
          data: png,
        }],
      }),
      copyImage: async (payload) => {
        window.copyImageCalls.push(payload);
        return { ok: true };
      },
      conversationPage: async () => ({
        ...snapshot,
        messages,
        requestTraces: [],
        turnDiffs: [],
        page: { hasOlder: false },
        messageStart: 0,
      }),
      conversationOutline: async () => ({ id: session.id, items: [], totalMessages: messages.length }),
      conversationSnapshot: async () => snapshot,
      subscribeConversation: async () => snapshot,
      unsubscribeConversation: async () => ({ ok: true }),
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
      get: (target, key) => (
        key in target
          ? target[key]
          : String(key).startsWith('on')
            ? () => () => {}
            : async () => undefined
      ),
    });
    window.expectedImageSrc = imageSrc;
  });

  await page.goto('http://127.0.0.1:5180');
  await page.locator('.workspace-row').first().click();
  await page.locator('.session-row').first().click();
  await page.getByRole('button', { name: '添加图片或文件', exact: true }).click();

  const composerImage = page.locator('.composer-attachments .composer-image-preview-trigger');
  await composerImage.waitFor();
  await composerImage.click({ button: 'right' });
  await page.getByRole('menuitem', { name: '复制图片', exact: true }).waitFor();
  await page.screenshot({ path: output + 'composer-context-menu.png', animations: 'disabled' });
  await page.getByRole('menuitem', { name: '复制图片', exact: true }).click();

  const conversationImage = page.locator('.conversation-image-tile').first();
  await conversationImage.waitFor();
  await conversationImage.click({ button: 'right' });
  await page.getByRole('menuitem', { name: '复制图片', exact: true }).click();

  await conversationImage.click();
  const preview = page.getByRole('dialog', { name: '图片预览' });
  await preview.waitFor();
  await page.waitForTimeout(500);
  const previewImage = preview.locator('.yarl__slide_current .yarl__slide_image').first();
  const previewImageBox = await previewImage.boundingBox();
  assert.ok(previewImageBox);
  const previewPoint = {
    x: previewImageBox.x + previewImageBox.width / 2,
    y: previewImageBox.y + previewImageBox.height / 2,
  };
  await page.mouse.click(
    previewPoint.x,
    previewPoint.y,
    { button: 'right' },
  );
  await page.getByRole('menuitem', { name: '复制图片', exact: true }).waitFor();
  await page.screenshot({ path: output + 'preview-context-menu.png', animations: 'disabled' });
  await page.getByRole('menuitem', { name: '复制图片', exact: true }).click();

  const calls = await page.evaluate(() => window.copyImageCalls);
  const expectedImageSrc = await page.evaluate(() => window.expectedImageSrc);
  assert.equal(calls.length, 3);
  assert.ok(calls.every((call) => call.src === expectedImageSrc));
  assert.deepEqual(errors, []);
  console.log('PASS: composer, conversation, and fullscreen image previews expose a working copy action.');
} catch (error) {
  const page = browser.contexts()[0]?.pages()[0];
  if (page) {
    await page.screenshot({ path: output + 'failure.png', animations: 'disabled' });
    console.error('browser errors:', errors);
    console.error('body:', (await page.locator('body').innerText()).slice(0, 1600));
  }
  throw error;
} finally {
  await browser.close();
}
