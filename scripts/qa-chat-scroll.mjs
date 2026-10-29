/**
 * Browser regression QA for pinned chat scrolling.
 *
 * Run the Vite server first:
 *   pnpm run web
 *   node scripts/qa-chat-scroll.mjs
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
    updatedAt: Date.now(),
    messageCount: initialMessages.length,
  };
  window.__promptArguments = null;
  window.__promptListeners = [];
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
    session: async () => ({
      ...summary,
      messages: initialMessages,
      hasMore: false,
      running: false,
      compacting: false,
      turnDiffs: [],
    }),
    sessionOutline: async () => ({ items: [], totalMessages: initialMessages.length }),
    composerResources: async () => ({ commands: [], skills: [] }),
    extensionState: async () => ({ statuses: [], footer: '', working: { visible: true, message: '' }, widgets: [] }),
    prompt: args => new Promise(resolve => {
      window.__promptArguments = args;
      window.__resolvePrompt = resolve;
    }),
    onPrompt: listener => {
      window.__promptListeners.push(listener);
      return () => {
        window.__promptListeners = window.__promptListeners.filter(item => item !== listener);
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

function metrics() {
  return page.locator('.chat-scroll').evaluate(node => ({
    top: node.scrollTop,
    height: node.scrollHeight,
    client: node.clientHeight,
    distance: node.scrollHeight - node.clientHeight - node.scrollTop,
  }));
}

async function emitStream(text) {
  await page.evaluate(nextText => {
    const requestId = window.__promptArguments.requestId;
    const message = {
      role: 'assistant',
      timestamp: 9001,
      content: [{ type: 'text', text: nextText }],
    };
    for (const listener of window.__promptListeners) listener({ type: 'message_update', requestId, message });
  }, text);
  await page.waitForTimeout(80);
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
  await page.locator('.composer textarea').fill('测试发送后立即贴底');
  await page.locator('.send-button').click();
  await page.waitForFunction(count => document.querySelectorAll('.message.user').length === count + 1, userCount);
  await page.waitForFunction(() => Boolean(window.__promptArguments));
  await page.waitForTimeout(50);
  assert.ok((await metrics()).distance <= 36, 'the optimistic user message should pin before thinking begins');

  let streamedText = '## 实时回复\n\n';
  for (let index = 0; index < 12; index += 1) {
    streamedText += `第 ${index + 1} 段。${'流式内容持续增长。'.repeat(28)}\n\n`;
    await emitStream(streamedText);
    assert.ok((await metrics()).distance <= 36, `stream update ${index + 1} should keep following`);
  }

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

  assert.deepEqual(errors, []);
  console.log('PASS: immediate send pin, streaming follow, user scroll release, bottom re-arm, no-op and nested wheel handling.');
} finally {
  await browser.close();
}
