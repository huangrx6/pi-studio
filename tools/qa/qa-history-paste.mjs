/**
 * Focused browser QA for transcript pagination and long-paste attachments.
 *
 * Run the Vite server first:
 *   pnpm run web
 *   node tools/qa/qa-history-paste.mjs
 */
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright-core';

const output = new URL('../../.qa/screenshots/history-paste/', import.meta.url).pathname;
await mkdir(output, { recursive: true });

const browser = await chromium.launch({
  executablePath: process.env.CHROME_BIN || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
});
const page = await browser.newPage({ viewport: { width: 1440, height: 920 }, deviceScaleFactor: 2 });
page.setDefaultTimeout(10_000);
const errors = [];
page.on('pageerror', error => errors.push(error.message));

await page.addInitScript(() => {
  const cwd = '/workspace/pi-studio';
  const totalMessages = 450;
  const model = {
    modelRef: 'demo/reasoner',
    label: 'Demo Reasoner',
    thinkingLevel: 'default',
    thinkingLevels: ['default', 'low', 'high'],
    effectiveThinkingLevel: 'high',
    defaultThinkingLevel: 'high',
  };
  const allMessages = Array.from({ length: totalMessages }, (_, index) => index % 2 === 0
    ? {
        role: 'user',
        timestamp: index + 1,
        content: [{ type: 'text', text: `第 ${index / 2 + 1} 个问题：检查这段会话的滚动位置和内容顺序。` }],
      }
    : {
        role: 'assistant',
        timestamp: index + 1,
        content: [{ type: 'text', text: `第 ${(index + 1) / 2} 个回答\n\n这里是一段用于形成真实滚动高度的回复内容。` }],
      }).map((message, sourceIndex) => ({ ...message, sourceIndex }));
  const outlineItems = allMessages.flatMap((message, sourceIndex) => message.role === 'user'
    ? [{ sourceIndex, text: message.content[0].text, timestamp: message.timestamp }]
    : []);
  const sessionSummary = {
    id: 'history-session',
    cwd,
    title: '历史加载与长文本粘贴',
    kind: 'conversation',
    goal: '',
    pinned: false,
    archived: false,
    createdAt: Date.now() - 3_600_000,
    updatedAt: Date.now(),
    messageCount: totalMessages,
  };
  window.__historyCalls = [];
  window.__outlineCalls = 0;
  window.__savedPastes = [];
  window.__openedFiles = [];

  const historyPayload = (limit, cursor) => {
    const end = cursor ? Number(cursor.replace('cursor-', '')) : totalMessages;
    const start = Math.max(0, end - limit);
    return {
      ...sessionSummary,
      model,
      messages: allMessages.slice(start, end),
      page: {
        hasOlder: start > 0,
        nextCursor: start > 0 ? `cursor-${start}` : undefined,
      },
      messageStart: start,
      running: false,
      requestId: '',
      compacting: false,
      turnDiffs: [],
      inbox: [],
      tools: [],
      nestedTools: [],
      usage: {},
      agent: { cwd, name: 'QA Agent' },
    };
  };

  const api = {
    state: async () => ({
      workspaces: [{ cwd, name: 'pi-studio', sessions: [sessionSummary] }],
      cwd,
      model,
    }),
    models: async () => ({
      models: [{ id: 'demo/reasoner', name: 'Demo Reasoner', provider: 'demo', providerName: 'Demo', supportsImages: true }],
      enabled: ['demo/reasoner'],
      current: model.modelRef,
      selection: model,
      defaultSelection: model,
    }),
    composerResources: async () => ({ commands: [], skills: [] }),
    extensionsUi: async () => ({ items: [], errors: [], syncedAt: Date.now(), apiVersion: 1 }),
    modeGet: async () => ({ available: false, mode: 'smart' }),
    conversationPage: async ({ limit = 200, cursor } = {}) => {
      window.__historyCalls.push({ limit, cursor });
      const payload = historyPayload(limit, cursor);
      if (!cursor && limit <= 200) return payload;
      return new Promise(resolve => {
        window.__resolveHistory = () => resolve(payload);
      });
    },
    conversationOutline: async id => {
      window.__outlineCalls += 1;
      return { id, items: outlineItems, totalMessages };
    },
    conversationSnapshot: async () => ({
      ...sessionSummary,
      model,
      running: false,
      requestId: '',
      compacting: false,
      inbox: [],
      tools: [],
      nestedTools: [],
      usage: {},
      agent: { cwd, name: 'QA Agent' },
    }),
    subscribeConversation: async () => ({
      ...sessionSummary,
      model,
      running: false,
      requestId: '',
      compacting: false,
      inbox: [],
      tools: [],
      nestedTools: [],
      usage: {},
      agent: { cwd, name: 'QA Agent' },
    }),
    unsubscribeConversation: async () => ({ ok: true }),
    sessionSubagents: async () => [],
    onConversationEvent: () => () => {},
    saveAttachment: async ({ sessionId, text }) => {
      const path = '/var/tmp/pi-studio-long-paste.txt';
      window.__savedPastes.push({ sessionId, text });
      return {
        name: 'long-paste.txt',
        path,
        bytes: new TextEncoder().encode(text).length,
        lines: text.split('\n').length,
        kind: 'text',
        mime: 'text/plain',
        marker: '[[pi-studio-attachment:qa]]',
        notice: '原始内容已保存为附件。',
        promptText: `原始内容已保存为附件。\n\n[[pi-studio-attachment:qa]]`,
      };
    },
    fileAbsolute: async path => {
      const saved = window.__savedPastes.at(-1)?.text || '';
      window.__openedFiles.push(path);
      return { path, size: new TextEncoder().encode(saved).length, binary: false, text: saved };
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

async function scrollTranscript(top) {
  await page.locator('.chat-scroll').evaluate((node, nextTop) => {
    node.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    node.scrollTop = nextTop;
    node.dispatchEvent(new Event('scroll', { bubbles: true }));
  }, top);
}

async function assertOutlineFits() {
  const metrics = await page.locator('.outline-track').evaluate(track => {
    const bounds = track.getBoundingClientRect();
    const ticks = Array.from(track.querySelectorAll('.outline-tick'), tick => {
      const rect = tick.getBoundingClientRect();
      return { top: rect.top, bottom: rect.bottom };
    });
    return { top: bounds.top, bottom: bounds.bottom, ticks };
  });
  assert.ok(metrics.ticks.length <= 12, `outline rendered ${metrics.ticks.length} ticks`);
  assert.ok(metrics.ticks.every(tick => tick.top >= metrics.top && tick.bottom <= metrics.bottom),
    'outline ticks must stay inside the conversation rail');
}

try {
  await page.goto(process.env.PREVIEW_URL || 'http://127.0.0.1:5180');

  async function openHistorySession() {
    await page.locator('.workspace-row').first().waitFor();
    if (await page.locator('.session-row').count() === 0) {
      await page.locator('.workspace-row').first().evaluate(node => node.click());
    }
    await page.locator('.session-row').first().evaluate(node => node.click());
    await page.locator('.chat-scroll').waitFor();
    await page.waitForFunction(() => window.__historyCalls.length === 1 && window.__outlineCalls === 1);
  }

  // 内容窗口只取最近 200 条，右侧仍覆盖全部 225 个提问；最早提问可直接跨页跳转。
  await openHistorySession();
  assert.equal(await page.locator('.message.user').count(), 100, 'content should stay in the 200-message window');
  assert.equal(await page.locator('.outline-tick').count(), 12, 'outline should remain visually bounded');
  assert.equal(await page.locator('.outline-tick').first().getAttribute('aria-label'), '跳转到第 1 条提问');
  assert.equal(await page.locator('.outline-tick').last().getAttribute('aria-label'), '跳转到第 225 条提问');
  await page.locator('.outline-tick').first().click();
  await page.waitForFunction(() => window.__historyCalls.length === 2);
  assert.equal(await page.evaluate(() => window.__historyCalls.at(-1).limit), 450, 'jump should load from the target question');
  await page.evaluate(() => window.__resolveHistory());
  await page.locator('#chat-turn-0').waitFor();
  await page.waitForFunction(() => {
    const container = document.querySelector('.chat-scroll');
    const target = document.querySelector('#chat-turn-0');
    if (!container || !target) return false;
    const containerRect = container.getBoundingClientRect();
    const targetRect = target.getBoundingClientRect();
    return targetRect.top >= containerRect.top - 1 && targetRect.top <= containerRect.top + 40;
  });
  assert.equal(await page.locator('.message.user').count(), 225);
  await page.screenshot({ path: `${output}outline-cross-page-jump.png`, animations: 'disabled' });

  // 重新载入模拟，继续验证独立的历史向上分页。
  await page.reload();
  await page.locator('.chat-scroll').waitFor();
  await page.waitForFunction(() => window.__historyCalls.length >= 1 && window.__outlineCalls >= 1);
  assert.equal(await page.evaluate(() => window.__historyCalls.length), 1);
  await assertOutlineFits();
  await page.screenshot({ path: `${output}outline-compact.png`, animations: 'disabled' });

  assert.equal(await page.getByText('加载更多', { exact: true }).count(), 0);
  await scrollTranscript(100);
  await page.waitForFunction(() => window.__historyCalls.length === 2);
  await page.locator('.history-loading').waitFor();
  assert.equal((await page.locator('.history-loading').innerText()).trim(), '');

  await scrollTranscript(0);
  await scrollTranscript(0);
  await page.waitForTimeout(80);
  assert.equal(await page.evaluate(() => window.__historyCalls.length), 2, 'in-flight top scrolling must not request twice');
  await page.screenshot({ path: `${output}history-loading.png`, animations: 'disabled' });

  await page.evaluate(() => window.__resolveHistory());
  await page.locator('.history-loading').waitFor({ state: 'detached' });
  await scrollTranscript(0);
  await page.waitForTimeout(80);
  assert.equal(await page.evaluate(() => window.__historyCalls.length), 2, 'disarmed top must not request again');

  await scrollTranscript(600);
  await scrollTranscript(100);
  await page.waitForFunction(() => window.__historyCalls.length === 3);
  // 第二轮仍按游标取前面 200 条，直到第三条页面覆盖剩余 50 条。
  assert.deepEqual(
    await page.evaluate(() => window.__historyCalls.at(-1)),
    { limit: 200, cursor: 'cursor-50' },
  );
  await assertOutlineFits();
  await page.evaluate(() => window.__resolveHistory());
  await page.locator('.history-loading').waitFor({ state: 'detached' });
  await assertOutlineFits();
  await scrollTranscript(0);
  await scrollTranscript(0);
  await page.waitForTimeout(80);
  assert.equal(await page.evaluate(() => window.__historyCalls.length), 3, 'finished history must stay settled at the top');

  const composer = page.getByRole('textbox', { name: '发送给 Pi 的消息' });
  await composer.fill('typed-');
  const pasted = 'P'.repeat(11_996);
  await composer.evaluate((node, text) => {
    node.focus();
    node.setSelectionRange(node.value.length, node.value.length);
    const data = new DataTransfer();
    data.setData('text/plain', text);
    node.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: data }));
  }, pasted);
  await page.waitForFunction(() => window.__savedPastes.length === 1);
  assert.equal(await composer.inputValue(), 'typed-');
  assert.equal(await page.evaluate(() => window.__savedPastes[0].text), pasted);

  const attachment = page.getByRole('button', { name: '在右侧面板查看 long-paste.txt' });
  await attachment.waitFor();
  await attachment.locator('.attachment-open-cue').waitFor();
  await attachment.click();
  await page.locator('.file-code').waitFor();
  assert.match(await page.locator('.file-code').innerText(), /PPPP/);
  assert.deepEqual(await page.evaluate(() => window.__openedFiles), ['/var/tmp/pi-studio-long-paste.txt']);

  for (const theme of ['light', 'dark']) {
    await page.evaluate(next => { document.documentElement.dataset.theme = next; }, theme);
    await page.screenshot({ path: `${output}${theme}.png`, animations: 'disabled' });
  }

  assert.deepEqual(errors, []);
  console.log('PASS: the full outline can jump across the 200-message window, history auto-loads once near the top, and oversized pasted batches stay isolated.');
} catch (error) {
  await page.screenshot({ path: `${output}failure.png`, animations: 'disabled' });
  throw error;
} finally {
  await browser.close();
}
