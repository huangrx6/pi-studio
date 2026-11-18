/**
 * Conversation outline regression.
 *
 * Two things the rail must do in a long, paged transcript:
 *  1. clicking a question that is not loaded yet loads up to that entry and scrolls
 *     to it (the jump must ask by Durable entry id, not by message count);
 *  2. the active tick follows the scroll instead of jumping between samples.
 *
 * Run the Vite server first:
 *   pnpm run web
 *   node scripts/qa/qa-outline-context.mjs
 */
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright-core';

const TURNS = 130;
const output = new URL('../../.qa/screenshots/outline-context/', import.meta.url).pathname;
await mkdir(output, { recursive: true });

const browser = await chromium.launch({
  executablePath: process.env.CHROME_BIN || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
});

try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 820 }, deviceScaleFactor: 2 });
  page.setDefaultTimeout(10_000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));

  await page.addInitScript(({ turns }) => {
    const cwd = '/workspace/outline';
    const model = {
      modelRef: 'demo/reasoner',
      label: 'Demo Reasoner',
      thinkingLevel: 'default',
      thinkingLevels: ['default'],
      effectiveThinkingLevel: 'off',
      defaultThinkingLevel: 'off',
    };
    const messages = [];
    // Durable entry ids grow faster than the message count (hidden and summary
    // entries take an id without producing a display message).
    for (let index = 0; index < turns; index += 1) {
      messages.push({
        role: 'user',
        sourceIndex: index * 3 + 1,
        timestamp: index * 2 + 1,
        content: [{ type: 'text', text: `第 ${index + 1} 个问题：验证大纲跳转。` }],
      });
      messages.push({
        role: 'assistant',
        sourceIndex: index * 3 + 2,
        timestamp: index * 2 + 2,
        content: [{ type: 'text', text: `## 回答 ${index + 1}\n\n${'这是用于撑开滚动高度的正文内容。'.repeat(10)}` }],
      });
    }
    const outlineItems = messages
      .filter((message) => message.role === 'user')
      .map((message) => ({
        sourceIndex: message.sourceIndex,
        text: message.content[0].text,
        timestamp: message.timestamp,
      }));
    const summary = {
      id: 'outline-session',
      cwd,
      title: '大纲跳转回归',
      kind: 'conversation',
      goal: '',
      pinned: false,
      archived: false,
      createdAt: Date.now() - 60_000,
      updatedAt: Date.now(),
      messageCount: messages.length,
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
      agent: { cwd, name: 'Outline QA' },
    });
    window.__outlineItems = outlineItems;
    window.__outlineRequests = [];
    const pageFor = ({ turnLimit, before, after, around }) => {
      window.__outlineRequests.push({ turnLimit, before, after, around });
      const indexOfEntry = (id) => messages.findIndex(message => message.sourceIndex === id);
      const size = turnLimit * 2; // Every fixture turn has a question and an answer.
      let end = messages.length;
      if (before) end = indexOfEntry(before.entryId);
      if (after) end = indexOfEntry(after.entryId) + 1 + size;
      if (around !== undefined) end = indexOfEntry(around) + Math.ceil(size / 2);
      const start = Math.max(0, end - size);
      const slice = messages.slice(start, end);
      return {
        messages: slice,
        page: { hasOlder: start > 0, hasNewer: end < messages.length },
        messageStart: slice[0]?.sourceIndex ?? 0,
      };
    };
    window.piApi = new Proxy({
      state: async () => ({ workspaces: [{ cwd, name: 'outline', sessions: [summary] }], cwd, model }),
      models: async () => ({
        models: [{ id: model.modelRef, name: model.label, provider: 'demo', providerName: 'Demo' }],
        enabled: [model.modelRef],
        current: model.modelRef,
        selection: model,
        defaultSelection: model,
      }),
      conversationPage: async (payload = {}) => ({
        ...snapshot(),
        ...pageFor(payload),
        turnDiffs: [],
        requestTraces: [],
      }),
      conversationOutline: async () => ({
        id: summary.id,
        items: outlineItems,
        totalMessages: messages.length,
      }),
      conversationSnapshot: async () => snapshot(),
      subscribeConversation: async () => snapshot(),
      unsubscribeConversation: async () => ({ ok: true }),
      onConversationEvent: () => () => {},
      composerResources: async () => ({ commands: [], skills: [] }),
      subagentSettings: async () => ({ installed: false, user: {}, project: {}, models: [], thinkingLevels: [] }),
      extensionsUi: async () => ({ items: [], errors: [], syncedAt: Date.now(), apiVersion: 1 }),
    }, {
      get: (target, key) => key in target
        ? target[key]
        : String(key).startsWith('on')
          ? () => () => {}
          : async () => undefined,
    });
  }, { turns: TURNS });

  await page.goto(process.env.PREVIEW_URL || 'http://127.0.0.1:5180');
  await page.locator('.workspace-row').first().click();
  await page.locator('.session-row').first().click();
  await page.locator('.chat-scroll').waitFor();
  await page.waitForTimeout(400);
  await page.locator('.outline-tick').first().waitFor();

  // 大纲覆盖所有提问，正文首先加载最近一窗。
  const mountedTurns = await page.locator('.message.user').count();
  assert.ok(mountedTurns > 0 && mountedTurns < TURNS, `only a window of turns is mounted (${mountedTurns}/${TURNS})`);
  assert.equal(await page.locator('.outline-tick').count(), TURNS, 'the rail includes every question');
  assert.equal(await page.locator('.history-loading').count(), 0, 'no incremental loading placeholder exists any more');
  const historyRequests = await page.evaluate(() => window.__outlineRequests.length);
  assert.ok(historyRequests >= 1 && historyRequests <= 2, `opening loads the latest window (${historyRequests} requests)`);

  // The rail is a compact turn navigator: rows keep a stable, short pitch and
  // the whole 44px wide hit area remains clickable.
  const tickGeometry = await page.locator('.outline-tick').evaluateAll((nodes) => nodes.map((node) => {
    const box = node.getBoundingClientRect();
    return { top: Math.round(box.top), width: Math.round(box.width), height: Math.round(box.height) };
  }));
  const tickTops = tickGeometry.map(({ top }) => top);
  assert.deepEqual(tickTops, [...tickTops].sort((left, right) => left - right), 'ticks follow conversation order');
  assert.ok(tickGeometry.every(({ width, height }) => width >= 44 && height >= 8 && height <= 12), `ticks keep a 10px click row: ${JSON.stringify(tickGeometry[0])}`);
  assert.ok(
    tickTops.slice(1).every((top, index) => Math.abs(top - tickTops[index] - 10) <= 1),
    `ticks should use a compact 10px pitch: ${tickTops.join(', ')}`,
  );

  await page.getByRole('button', { name: '打开右侧面板', exact: true }).click();
  await page.getByRole('button', { name: '收起右侧面板', exact: true }).hover();
  const rail = page.getByRole('navigation', { name: '对话大纲' });
  await rail.waitFor();
  const railBox = await rail.boundingBox();
  const column = await page.locator('.chat-scroll .chat-column').boundingBox();
  assert.ok(railBox.x + railBox.width <= column.x + 1, 'the docked outline fits beside the message column');
  const track = await rail.locator('.outline-track').boundingBox();
  const viewport = await page.locator('.chat-scroll').boundingBox();
  assert.ok(track.y >= viewport.y && track.y + track.height <= viewport.y + viewport.height + 1,
    'the ticks stay within the transcript above the composer');

  // Scrolling up with the wheel moves the active tick along the rail.
  const box = await page.locator('.chat-scroll').boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  const actives = [];
  for (let step = 0; step < 4; step += 1) {
    await page.mouse.wheel(0, -620);
    await page.waitForTimeout(380);
    actives.push(await page.locator('.outline-tick.is-active').getAttribute('aria-label'));
  }
  assert.equal(new Set(actives).size >= 3, true, `active tick should travel while scrolling: ${actives.join(' → ')}`);
  await page.screenshot({ path: `${output}scrolled.png`, animations: 'disabled' });

  // Clicking the visible preview card, not only the hairline, jumps to the target.
  await page.locator('.outline-tick').first().hover();
  const preview = page.locator('.outline-preview').first();
  await preview.waitFor();
  assert.equal(await preview.evaluate((node) => getComputedStyle(node).pointerEvents), 'auto');
  assert.match(await preview.innerText(), /第 1 个问题/);
  const previewBox = await preview.boundingBox();
  const pane = await page.locator('.main').boundingBox();
  assert.ok(previewBox.x + previewBox.width <= pane.x + pane.width, 'the preview stays inside the conversation');
  await page.screenshot({ path: `${output}hover-preview.png`, animations: 'disabled' });
  await page.locator('.outline-tick').first().focus();
  await preview.click();
  await page.waitForFunction(() => document.getElementById('chat-turn-1') !== null);
  await page.waitForTimeout(300);
  const target = await page.evaluate(() => {
    const node = document.getElementById('chat-turn-1');
    const view = document.querySelector('.chat-scroll').getBoundingClientRect();
    return { offset: Math.round(node.getBoundingClientRect().top - view.top), text: node.textContent.trim().slice(0, 12) };
  });
  assert.ok(target.offset >= 0 && target.offset < 120, `jumped target sits at the top of the viewport (${target.offset}px)`);
  assert.match(target.text, /第 1 个问题/);
  assert.ok(await page.evaluate(() => window.__outlineRequests.some(request => request.around === 1)),
    'jumping outside the loaded window requests the question by its entry ID');
  assert.equal(await page.locator('.outline-tick.is-active').getAttribute('aria-label'), '跳转到第 1 条提问');

  await page.getByRole('button', { name: '收起右侧面板', exact: true }).click();
  await page.locator('.file-panel').waitFor({ state: 'detached' });
  await page.setViewportSize({ width: 1100, height: 820 });
  await rail.waitFor();

  // 直接点第一条刻度的细线（不经过预览卡）同样要跳到目标。
  await page.locator('.outline-tick').last().click();
  await page.waitForTimeout(400);
  await page.locator('.outline-tick').first().click();
  await page.waitForTimeout(700);
  const railJump = await page.evaluate(() => {
    const node = document.getElementById('chat-turn-1');
    const view = document.querySelector('.chat-scroll').getBoundingClientRect();
    return node ? Math.round(node.getBoundingClientRect().top - view.top) : -1;
  });
  assert.ok(railJump >= 0 && railJump < 120, `clicking the rail itself also lands on the target (${railJump}px)`);

  // 每一个刻度都必须真的跳到自己的提问：这是用户直接反馈的问题。
  const items = await page.evaluate(() => window.__outlineItems);
  for (const [index, item] of items.entries()) {
    await page.locator('.outline-tick').nth(index).click();
    await page.waitForFunction(sourceIndex => {
      const node = document.getElementById(`chat-turn-${sourceIndex}`);
      if (!node?.classList.contains('is-search-hit')) return false;
      const target = node.getBoundingClientRect();
      const view = document.querySelector('.chat-scroll').getBoundingClientRect();
      return target.top >= view.top - 1 && target.bottom <= view.bottom + 1;
    }, item.sourceIndex);
  }

  await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
  await page.locator('.outline-tick').nth(1).hover();
  await page.locator('.outline-preview').waitFor();
  await page.screenshot({ path: `${output}hover-preview-dark.png`, animations: 'disabled' });
  await page.screenshot({ path: `${output}jumped.png`, animations: 'disabled' });

  assert.deepEqual(errors, []);
  console.log(`PASS: the docked and narrow outline previews questions and jumps to all ${TURNS} turns. Screenshots: ${output}`);
} finally {
  await browser.close();
}
