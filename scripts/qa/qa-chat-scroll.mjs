/**
 * Browser regression QA for pinned chat scrolling.
 *
 * Run the Vite server first:
 *   pnpm run web
 *   node scripts/qa/qa-chat-scroll.mjs
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
  const cwd = '/workspace/pi-studio-scroll';
  const model = {
    modelRef: 'demo/reasoner',
    label: 'Demo Reasoner',
    thinkingLevel: 'default',
    thinkingLevels: ['default', 'high'],
    effectiveThinkingLevel: 'high',
    defaultThinkingLevel: 'high',
  };
  const initialMessages = [];
  for (let index = 0; index < 18; index += 1) {
    initialMessages.push({
      role: 'user',
      sourceIndex: initialMessages.length,
      timestamp: index * 2 + 1,
      content: [{ type: 'text', text: `第 ${index + 1} 个问题：验证流式聊天滚动。` }],
    });
    initialMessages.push({
      role: 'assistant',
      sourceIndex: initialMessages.length,
      timestamp: index * 2 + 2,
      content: [{ type: 'text', text: `## 回答 ${index + 1}\n\n${'这是用于形成真实滚动高度的正文。'.repeat(24)}` }],
    });
  }
  const summary = {
    id: 'scroll-session',
    cwd,
    title: '滚动跟随回归',
    kind: 'conversation',
    goal: '',
    pinned: false,
    archived: false,
    createdAt: Date.now() - 60_000,
    updatedAt: Date.now(),
    messageCount: initialMessages.length,
  };
  window.__submitArguments = null;
  window.__conversationListeners = new Set();
  const temporaryListeners = new Set();
  window.__streamTemporaryThinking = thinking => {
    for (const listener of temporaryListeners) listener({
      id: window.__temporaryChatId,
      type: 'message',
      message: { role: 'assistant', timestamp: 9002, streaming: true, content: [{ type: 'thinking', thinking }] },
    });
  };
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
    agent: { cwd, name: 'Scroll QA Agent' },
  });
  const api = {
    state: async () => ({
      workspaces: [{ cwd, name: 'pi-studio-scroll', sessions: [summary] }],
      cwd,
      model,
    }),
    models: async () => ({
      models: [{ id: 'demo/reasoner', name: 'Demo Reasoner', provider: 'demo', providerName: 'Demo' }],
      enabled: ['demo/reasoner'],
      current: model.modelRef,
      selection: model,
      defaultSelection: model,
    }),
    conversationPage: async () => ({
      ...snapshot(),
      messages: initialMessages,
      turnDiffs: [],
      page: { hasOlder: false },
      messageStart: 0,
    }),
    conversationSnapshot: async () => snapshot(),
    conversationOutline: async () => ({ id: summary.id, items: [], totalMessages: initialMessages.length }),
    subscribeConversation: async () => snapshot(),
    unsubscribeConversation: async () => ({ ok: true }),
    onConversationEvent: (listener) => {
      window.__conversationListeners.add(listener);
      return () => window.__conversationListeners.delete(listener);
    },
    modeGet: async () => ({ available: true, mode: 'smart' }),
    composerResources: async () => ({ commands: [], skills: [] }),
    conversationSubmit: args => new Promise(resolve => {
      window.__submitArguments = args;
      window.__resolveSubmit = resolve;
    }),
    onTemporary: listener => {
      temporaryListeners.add(listener);
      return () => temporaryListeners.delete(listener);
    },
    temporaryHistory: async () => [],
    temporaryModel: async () => model,
    temporaryPrompt: ({ id }) => new Promise(() => { window.__temporaryChatId = id; }),
    sessionSubagents: async () => [],
    extensionsUi: async () => ({ items: [], errors: [], syncedAt: Date.now(), apiVersion: 1 }),
  };
  window.piApi = new Proxy(api, {
    get(target, key) {
      if (key in target) return target[key];
      if (String(key).startsWith('on')) return () => () => {};
      return async () => undefined;
    },
  });
});

function metrics() {
  return page.locator('.chat-scroll').evaluate(node => ({
    top: node.scrollTop,
    height: node.scrollHeight,
    client: node.clientHeight,
    distance: node.scrollHeight - node.clientHeight - node.scrollTop,
  }));
}

async function emitStream(text, kind = 'text') {
  await page.evaluate(({ text, kind }) => {
    const message = {
      role: 'assistant',
      timestamp: 9001,
      content: [kind === 'thinking' ? { type: 'thinking', thinking: text } : { type: 'text', text }],
    };
    for (const listener of window.__conversationListeners) listener({
      type: 'assistant.updated',
      conversationId: 'scroll-session',
      revision: Date.now(),
      payload: { message },
    });
  }, { text, kind });
  if (kind === 'text') {
    const lastLine = text.trimEnd().split('\n').at(-1);
    await page.locator('.chat-scroll .assistant-turn.is-live .assistant-response').filter({ hasText: lastLine }).waitFor();
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  }
}

async function verifyLiveThinkingCode(viewportSelector, updateThinking) {
  const step = page.locator(`${viewportSelector} .narrative-step.is-thinking.is-running`);
  for (const count of [24, 42]) {
    const lines = Array.from({ length: count }, (_, index) => `     - 核对当前步骤使用的配置与输入数据 entry-${index + 1}\n`).join('');
    await updateThinking('推理正文\n\n1. 配置示例\n\n   ```yaml\n   entries:\n' + lines);
    const excerpt = step.locator('.narrative-step-thought').filter({ hasText: `entry-${count}` });
    await excerpt.waitFor();
    assert.ok(await excerpt.evaluate(node => node.scrollHeight > node.clientHeight
      && node.scrollHeight - node.clientHeight - node.scrollTop <= 1),
    'the two-line live preview follows the latest streamed input');
  }
  await step.getByRole('button', { expanded: false }).click();
  await step.locator('pre code').filter({ hasText: 'entry-42' }).waitFor();
  await step.getByRole('button', { expanded: true }).click();
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
  await page.waitForTimeout(80);
  assert.ok((await metrics()).distance <= 36, 'opening a session should land at the live edge');

  const userCount = await page.locator('.message.user').count();
  const editor = page.getByRole('textbox', { name: '发送给 Pi 的消息' });
  await editor.click();
  await page.keyboard.insertText('测试发送后立即贴底');
  await page.locator('.send-button').click();
  await page.waitForFunction(count => document.querySelectorAll('.message.user').length === count + 1, userCount);
  await page.waitForFunction(() => Boolean(window.__submitArguments));
  await page.waitForTimeout(50);
  assert.ok((await metrics()).distance <= 36, 'the optimistic user message should pin before thinking begins');
  await verifyLiveThinkingCode('.chat-scroll', thinking => emitStream(thinking, 'thinking'));

  // Expanding the complete thought above moves the reader into its history.
  await page.locator('.chat-scroll').evaluate(node => {
    node.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: 360 }));
    node.scrollTop = node.scrollHeight;
  });
  await page.waitForFunction(() => {
    const node = document.querySelector('.chat-scroll');
    return node.scrollHeight - node.clientHeight - node.scrollTop <= 1;
  });

  let streamedText = '## 实时回复\n\n';
  for (let index = 0; index < 12; index += 1) {
    streamedText += `第 ${index + 1} 段。${'流式内容持续增长。'.repeat(28)}\n\n`;
    await emitStream(streamedText);
    assert.ok((await metrics()).distance <= 36, `stream update ${index + 1} should keep following`);
  }

  const chatBounds = await page.locator('.chat-scroll').boundingBox();
  assert.ok(chatBounds, 'chat viewport should have measurable bounds');
  await page.mouse.move(chatBounds.x + chatBounds.width / 2, chatBounds.y + chatBounds.height / 2);
  const beforeFirstGesture = await metrics();
  await page.mouse.wheel(-20, -12);
  await page.waitForTimeout(40);
  const firstGesture = await metrics();
  assert.ok(firstGesture.top < beforeFirstGesture.top - 1,
    'the first small diagonal wheel should move the transcript immediately');
  streamedText += `轻微斜向的首个手势。${'不能被贴底跟随抢回。'.repeat(8)}\n\n`;
  await emitStream(streamedText);
  const afterFirstGesture = await metrics();
  assert.ok(afterFirstGesture.top < afterFirstGesture.height - afterFirstGesture.client - 1,
    'a small diagonal upward gesture should release follow before leaving the 36px threshold');
  assert.ok(Math.abs(afterFirstGesture.top - firstGesture.top) <= 1,
    'content growth after the first small gesture must not pull the reader back down');

  await page.locator('.chat-scroll').evaluate(node => {
    node.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: -420 }));
    node.scrollTop = Math.max(0, node.scrollHeight - node.clientHeight - 520);
  });
  await page.waitForTimeout(80);
  const away = await metrics();
  assert.ok(away.distance > 400, 'user upward scrolling should release follow');

  streamedText += `离开底部后的内容。${'不能抢回视口。'.repeat(42)}\n\n`;
  await emitStream(streamedText);
  const stillAway = await metrics();
  assert.ok(Math.abs(stillAway.top - away.top) <= 1, 'streaming must not pull a reader back to the bottom');
  assert.ok(stillAway.height > away.height, 'the transcript should still be growing');

  await page.locator('.chat-scroll').evaluate(node => {
    node.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: 360 }));
    node.scrollTop = node.scrollHeight;
  });
  await page.waitForTimeout(80);
  assert.ok((await metrics()).distance <= 36, 'returning to the bottom should re-arm follow');

  await page.locator('.chat-scroll').evaluate(node => {
    node.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaX: 90, deltaY: 0 }));
  });
  streamedText += `横向手势之后仍应跟随。${'保持贴底。'.repeat(30)}\n\n`;
  await emitStream(streamedText);
  assert.ok((await metrics()).distance <= 36, 'horizontal wheel should not disengage follow at the live edge');

  await page.locator('.chat-scroll').evaluate(node => {
    const nested = document.createElement('div');
    nested.dataset.qaNested = '';
    nested.style.cssText = 'height:44px;overflow:auto';
    nested.innerHTML = '<div style="height:180px"></div>';
    document.querySelector('.assistant-turn-main')?.append(nested);
    nested.scrollTop = 18;
    nested.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: -4 }));
  });
  streamedText += `嵌套滚动区之后仍应跟随。${'保持贴底。'.repeat(30)}\n\n`;
  await emitStream(streamedText);
  assert.ok((await metrics()).distance <= 36, 'a wheel consumed by a nested scroller must preserve follow');

  await page.locator('.sidebar-rail').getByRole('button', { name: '临时对话', exact: true }).click();
  await page.getByRole('textbox', { name: '临时聊天消息', exact: true }).fill('检查临时对话的流式滚动');
  await page.getByRole('button', { name: '发送临时消息', exact: true }).click();
  await page.waitForFunction(() => Boolean(window.__temporaryChatId));
  await verifyLiveThinkingCode('.temporary-scroll', thinking => page.evaluate(text => window.__streamTemporaryThinking(text), thinking));

  assert.deepEqual(errors, []);
  console.log('PASS: live previews follow in regular and temporary chats and expand to show the code; main transcript follows prose, releases on upward gestures, and re-arms at the bottom.');
} finally {
  await browser.close();
}
