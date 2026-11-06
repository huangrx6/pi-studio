/**
 * Focused browser QA for scrolling a live thinking body while it streams.
 *
 * Run the Vite server first:
 *   pnpm run web
 *   node tools/qa/qa-live-thinking-scroll.mjs
 */
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright-core';

const output = new URL('../../.qa/screenshots/live-thinking-scroll/', import.meta.url).pathname;
await mkdir(output, { recursive: true });

const browser = await chromium.launch({
  executablePath: process.env.CHROME_BIN || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
});
try {
  const page = await browser.newPage({ viewport: { width: 1000, height: 760 }, deviceScaleFactor: 2 });
  page.setDefaultTimeout(8000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));

  await page.route('**/popover-preview', route => route.fulfill({
    contentType: 'text/html',
    body: `<!doctype html><html><head><meta charset="UTF-8"></head><body style="overflow:auto;height:auto"><div id="fixture"></div><script type="module">
      import RefreshRuntime from '/@react-refresh';
      RefreshRuntime.injectIntoGlobalHook(window); window.$RefreshReg$ = () => {}; window.$RefreshSig$ = () => (type) => type;
      window.__vite_plugin_react_preamble_installed__ = true;
      await import('/src/styles/tokens.css'); await import('/src/styles/palette.css'); await import('/src/app.css');
      const React = (await import('/@fs/${process.cwd()}/node_modules/.vite/deps/react.js')).default;
      const { createRoot } = (await import('/@fs/${process.cwd()}/node_modules/.vite/deps/react-dom_client.js')).default;
      const { AssistantTurnView } = await import('/src/features/conversation/ChatMessage.tsx');
      let update;
      const line = '推理正文的连续增量，用来把思考框撑满并保持流式更新。';
      window.tick = count => update(state => ({ ...state, text: state.text + line.repeat(count || 1) }));
      function Fixture() {
        const [state, setState] = React.useState({ text: line });
        update = setState;
        return React.createElement('main', { style: { maxWidth: 860, margin: '40px auto', padding: '0 24px' } },
          React.createElement(AssistantTurnView, {
            messages: [{ role: 'assistant', timestamp: 1, streaming: true, content: [{ type: 'thinking', thinking: state.text }] }],
            toolResults: new Map(),
            busy: true,
            stepDisplay: 'standard',
            stepCollapse: 'after-answer',
          }));
      }
      createRoot(document.getElementById('fixture')).render(React.createElement(Fixture));
    </script></body></html>`,
  }));

  await page.goto(new URL('popover-preview', process.env.PREVIEW_URL || 'http://127.0.0.1:5180/').href, { waitUntil: 'domcontentloaded' });
  const body = page.locator('.activity-thinking.is-live .activity-thinking-body');
  await body.waitFor();

  const metrics = () => body.evaluate(node => ({
    scrollTop: node.scrollTop,
    clientHeight: node.clientHeight,
    scrollHeight: node.scrollHeight,
    distance: Math.max(0, node.scrollHeight - node.clientHeight - node.scrollTop),
    overscroll: getComputedStyle(node).overscrollBehaviorY,
  }));

  // 撑满思考框，让正文成为可滚动区域。
  await page.evaluate(() => window.tick(60));
  await page.waitForFunction(() => {
    const node = document.querySelector('.activity-thinking.is-live .activity-thinking-body');
    return node && node.scrollHeight > node.clientHeight + 120;
  });

  await page.evaluate(() => window.tick(1));
  const pinned = await metrics();
  assert.ok(pinned.distance <= 36, `streaming must pin the newest line: ${JSON.stringify(pinned)}`);
  assert.equal(pinned.overscroll, 'auto', 'the thinking body must let the wheel chain to the transcript');

  // 用户上滚：立即释放跟随，后续增量不得把视线拽回底部。
  await body.evaluate(node => {
    node.dispatchEvent(new WheelEvent('wheel', { deltaY: -120, bubbles: true }));
    node.scrollTop = 40;
    node.dispatchEvent(new Event('scroll'));
  });
  const released = await metrics();
  assert.ok(released.scrollTop <= 60, `wheel-up must leave the reader where they scrolled: ${JSON.stringify(released)}`);

  await page.evaluate(() => window.tick(3));
  const afterDeltas = await metrics();
  assert.ok(
    afterDeltas.scrollTop <= released.scrollTop + 4,
    `new deltas must not yank the reader back: ${JSON.stringify({ released, afterDeltas })}`,
  );

  // 读者自己滚回底部后，恢复跟随。
  await body.evaluate(node => {
    node.scrollTop = node.scrollHeight;
    node.dispatchEvent(new Event('scroll'));
  });
  await page.evaluate(() => window.tick(2));
  const resumed = await metrics();
  assert.ok(resumed.distance <= 36, `returning to the bottom must re-arm following: ${JSON.stringify(resumed)}`);

  await page.screenshot({ path: output + 'live-thinking-scroll.png', fullPage: true, animations: 'disabled' });
  assert.deepEqual(errors, []);
  console.log('PASS: live thinking follows only at the bottom, releases on wheel-up, and re-arms at the bottom.');
} finally {
  await browser.close();
}
