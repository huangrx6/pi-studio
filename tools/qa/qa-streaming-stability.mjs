/**
 * Browser regression for the live turn footer.
 *
 * A long text stream can trigger layout and scroll updates on every animation
 * frame. The footer and its left rail must remain fixed in the viewport while a
 * reader is following the live edge.
 *
 * Run the Vite server first:
 *   pnpm run web
 *   node tools/qa/qa-streaming-stability.mjs
 */
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';

const browser = await chromium.launch({
  executablePath: process.env.CHROME_BIN || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
});
const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
page.setDefaultTimeout(10_000);
const errors = [];
page.on('pageerror', error => errors.push(error.message));

await page.addInitScript(() => {
  const cwd = '/workspace/pi-studio-stability';
  const model = {
    modelRef: 'demo/reasoner',
    label: 'Demo Reasoner',
    thinkingLevel: 'default',
    thinkingLevels: ['default', 'high'],
    effectiveThinkingLevel: 'high',
    defaultThinkingLevel: 'high',
  };
  const initialMessages = [];
  for (let index = 0; index < 10; index += 1) {
    initialMessages.push({
      role: 'user',
      sourceIndex: initialMessages.length,
      timestamp: index * 2 + 1,
      content: [{ type: 'text', text: `第 ${index + 1} 个问题：验证长会话流式稳定性。` }],
    });
    initialMessages.push({
      role: 'assistant',
      sourceIndex: initialMessages.length,
      timestamp: index * 2 + 2,
      content: [{ type: 'text', text: `## 回答 ${index + 1}\n\n${'这是用于形成真实滚动高度的正文。'.repeat(18)}` }],
    });
  }
  const summary = {
    id: 'stream-stability-session',
    cwd,
    title: '流式稳定性回归',
    kind: 'conversation',
    goal: '',
    pinned: false,
    archived: false,
    createdAt: Date.now() - 3_600_000,
    updatedAt: Date.now(),
    messageCount: initialMessages.length,
  };
  window.__submitArguments = null;
  window.__conversationListeners = [];
  window.__conversationRevision = 0;
  window.__conversationPageCalls = 0;
  const snapshot = () => ({
    ...summary,
    model,
    running: false,
    requestId: '',
    compacting: false,
    inbox: [],
    tools: [],
    nestedTools: [],
    usage: {},
    agent: { cwd, name: 'QA Agent' },
  });
  const api = {
    state: async () => ({
      workspaces: [{ cwd, name: 'pi-studio-stability', sessions: [summary] }],
      cwd,
      model,
    }),
    models: async () => ({
      models: [{ id: model.modelRef, name: model.label, provider: 'demo', providerName: 'Demo' }],
      enabled: [model.modelRef],
      current: model.modelRef,
      selection: model,
      defaultSelection: model,
    }),
    conversationPage: async () => {
      window.__conversationPageCalls += 1;
      return {
      ...snapshot(),
      messages: initialMessages,
      turnDiffs: [],
      page: { hasOlder: false },
      messageStart: 0,
      };
    },
    conversationSnapshot: async () => snapshot(),
    subscribeConversation: async () => snapshot(),
    unsubscribeConversation: async () => ({ ok: true }),
    conversationOutline: async () => ({ id: summary.id, items: [], totalMessages: initialMessages.length }),
    sessionSubagents: async () => [],
    composerResources: async () => ({ commands: [], skills: [] }),
    extensionsUi: async () => ({ items: [], errors: [], syncedAt: Date.now(), apiVersion: 1 }),
    conversationSubmit: async input => {
      window.__submitArguments = input;
      return {
        conversationId: input.id,
        submissionId: 'stream-stability-submission',
        requestId: input.requestId,
        status: 'placed',
        whenBusy: 'followUp',
      };
    },
    onConversationEvent: listener => {
      window.__conversationListeners.push(listener);
      return () => {
        window.__conversationListeners = window.__conversationListeners.filter(item => item !== listener);
      };
    },
  };
  window.piApi = new Proxy(api, {
    get(target, key) {
      if (key in target) return target[key];
      if (String(key).startsWith('on')) return () => () => {};
      return async () => undefined;
    },
  });
});

async function emit(message, type = 'message_update') {
  await page.evaluate(({ message, type }) => {
    window.__conversationRevision += 1;
    const eventType = message.role === 'toolResult'
      ? 'transcript.appended'
      : type === 'message_end'
        ? 'assistant.completed'
        : 'assistant.updated';
    const payload = eventType === 'transcript.appended'
      ? { messages: [message] }
      : { message };
    for (const listener of window.__conversationListeners) listener({
      type: eventType,
      conversationId: 'stream-stability-session',
      revision: window.__conversationRevision,
      payload,
    });
  }, { message, type });
}

async function nextPaint() {
  await page.evaluate(() => new Promise(resolve => {
    requestAnimationFrame(() => requestAnimationFrame(resolve));
  }));
}

try {
  await page.goto(process.env.PREVIEW_URL || 'http://127.0.0.1:5180');
  await page.locator('.workspace-row').first().waitFor();
  await page.locator('.workspace-row').first().evaluate(node => node.click());
  await page.locator('.session-row').first().evaluate(node => node.click());
  await page.locator('.chat-scroll').waitFor();
  await page.waitForFunction(() => {
    const node = document.querySelector('.chat-scroll');
    return node && node.scrollHeight > node.clientHeight;
  });

  await page.locator('.composer textarea').fill('验证工具调用之后的长时间流式输出');
  await page.locator('.send-button').click();
  await page.waitForFunction(() => Boolean(window.__submitArguments) && window.__conversationPageCalls >= 2);

  const timestamp = 9_100;
  await emit({
    role: 'assistant',
    timestamp,
    content: [{ type: 'toolCall', id: 'stability-tool', name: 'read', arguments: { path: 'src/app.css' } }],
  }, 'message_start');
  await nextPaint();
  await emit({
    role: 'toolResult',
    timestamp: timestamp + 1,
    toolCallId: 'stability-tool',
    toolName: 'read',
    content: [{ type: 'text', text: '读取完成' }],
  }, 'message_end');
  await nextPaint();

  let thinking = '';
  let text = '';
  const samples = [];
  await emit({
    role: 'assistant',
    timestamp,
    streaming: true,
    content: [
      { type: 'toolCall', id: 'stability-tool', name: 'read', arguments: { path: 'src/app.css' } },
      { type: 'thinking', thinking: '先检查布局。' },
    ],
  });
  await nextPaint();
  // The whole turn has a deliberate 320ms entrance animation. Measure the
  // sustained stream after that transition so this regression covers jitter,
  // rather than the one-time appearance of the new assistant turn.
  await page.waitForTimeout(380);

  for (let index = 0; index < 36; index += 1) {
    thinking += `第 ${index + 1} 段推理。${'持续分析当前布局和滚动行为。'.repeat(5)}\n\n`;
    await emit({
      role: 'assistant',
      timestamp,
      streaming: true,
      content: [
        { type: 'toolCall', id: 'stability-tool', name: 'read', arguments: { path: 'src/app.css' } },
        { type: 'thinking', thinking },
      ],
    });
    await nextPaint();
    samples.push(await page.evaluate(() => {
      const viewport = document.querySelector('.chat-scroll').getBoundingClientRect();
      const status = document.querySelector('.run-live-status').getBoundingClientRect();
      const rail = document.querySelector('.run-current-inline').getBoundingClientRect();
      const scroll = document.querySelector('.chat-scroll');
      return {
        footerBottom: status.bottom - viewport.bottom,
        footerLeft: status.left - viewport.left,
        footerHeight: status.height,
        railLeft: rail ? rail.left - viewport.left : null,
        railWidth: rail ? rail.width : null,
        distance: scroll.scrollHeight - scroll.clientHeight - scroll.scrollTop,
      };
    }));
  }

  for (let index = 0; index < 36; index += 1) {
    text += `第 ${index + 1} 段正文。${'流式内容持续增长，底栏必须保持稳定。'.repeat(5)}\n\n`;
    await emit({
      role: 'assistant',
      timestamp,
      streaming: true,
      content: [
        { type: 'toolCall', id: 'stability-tool', name: 'read', arguments: { path: 'src/app.css' } },
        { type: 'thinking', thinking },
        { type: 'text', text },
      ],
    });
    await nextPaint();
    samples.push(await page.evaluate(() => {
      const viewport = document.querySelector('.chat-scroll').getBoundingClientRect();
      const status = document.querySelector('.run-live-status').getBoundingClientRect();
      const rail = document.querySelector('.run-current-inline')?.getBoundingClientRect();
      const scroll = document.querySelector('.chat-scroll');
      return {
        footerBottom: status.bottom - viewport.bottom,
        footerLeft: status.left - viewport.left,
        footerHeight: status.height,
        railLeft: rail ? rail.left - viewport.left : null,
        railWidth: rail ? rail.width : null,
        distance: scroll.scrollHeight - scroll.clientHeight - scroll.scrollTop,
      };
    }));
  }

  assert.equal(samples.length, 72);
  assert.ok(Math.max(...samples.map(sample => sample.distance)) <= 36, 'long streams must keep following the live edge');
  for (const key of ['footerBottom', 'footerLeft', 'footerHeight']) {
    const values = samples.map(sample => sample[key]);
    const spread = Math.max(...values) - Math.min(...values);
    assert.ok(spread <= 1, `${key} jittered by ${spread.toFixed(2)}px`);
  }
  for (const key of ['railLeft', 'railWidth']) {
    const values = samples
      .slice(0, 36)
      .map(sample => sample[key])
      .filter(value => value !== null);
    const spread = Math.max(...values) - Math.min(...values);
    assert.ok(spread <= 1, `${key} jittered by ${spread.toFixed(2)}px`);
  }
  assert.deepEqual(errors, []);
  console.log('PASS: live footer and rail remain geometrically stable through a long stream after a tool call.');
} finally {
  await browser.close();
}
