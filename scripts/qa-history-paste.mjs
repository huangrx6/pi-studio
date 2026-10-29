/**
 * Focused browser QA for transcript pagination and long-paste attachments.
 *
 * Run the Vite server first:
 *   pnpm run web
 *   node scripts/qa-history-paste.mjs
 */
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright-core';

const output = new URL('../screenshots/history-paste/', import.meta.url).pathname;
await mkdir(output, { recursive: true });

const browser = await chromium.launch({
  executablePath: process.env.CHROME_BIN || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
});
const page = await browser.newPage({ viewport: { width: 1440, height: 920 } });
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
      });
  const sessionSummary = {
    id: 'history-session',
    cwd,
    title: '历史加载与长文本粘贴',
    updatedAt: Date.now(),
    messageCount: totalMessages,
  };
  window.__historyCalls = [];
  window.__savedPastes = [];
  window.__openedFiles = [];

  const historyPayload = limit => ({
    ...sessionSummary,
    messages: allMessages.slice(-limit),
    hasMore: limit < totalMessages,
    running: false,
    compacting: false,
    turnDiffs: [],
  });

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
    }),
    composerResources: async () => ({ commands: [], skills: [] }),
    extensionState: async () => ({
      statuses: [],
      footer: '',
      working: { visible: true, message: '' },
      widgets: [],
    }),
    modeGet: async () => ({ available: false, mode: 'smart' }),
    session: async (_id, limit = 200) => {
      window.__historyCalls.push(limit);
      const payload = historyPayload(limit);
      if (limit <= 200) return payload;
      return new Promise(resolve => {
        window.__resolveHistory = () => resolve(payload);
      });
    },
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
    onPrompt: () => () => {},
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
  await page.locator('.workspace-row').first().evaluate(node => node.click());
  await page.locator('.session-row').first().evaluate(node => node.click());
  await page.locator('.chat-scroll').waitFor();
  await page.waitForFunction(() => window.__historyCalls.length === 1);
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
  assert.equal(await page.evaluate(() => window.__historyCalls.at(-1)), 600);
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
  console.log('PASS: history auto-loads once near the top, rearms only after scrolling back; oversized pasted batches stay isolated and open in the right panel.');
} catch (error) {
  await page.screenshot({ path: `${output}failure.png`, animations: 'disabled' });
  throw error;
} finally {
  await browser.close();
}
