/**
 * Focused browser QA for scrolling a live thinking body while it streams.
 *
 * Run the Vite server first:
 *   pnpm run web
 *   node scripts/qa/qa-live-thinking-scroll.mjs
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
      await import('/src/styles/tokens.css'); await import('/src/styles/palette.css'); await import('/src/styles/app.css');
      const React = (await import('/@fs/${process.cwd()}/node_modules/.vite/deps/react.js')).default;
      const { createRoot } = (await import('/@fs/${process.cwd()}/node_modules/.vite/deps/react-dom_client.js')).default;
      const { AssistantTurnView } = await import('/src/features/conversation/AssistantTurn.tsx');
      let update;
      window.appendThinking = text => update(previous => previous + text);
      function Fixture() {
        const [text, setText] = React.useState('推理正文随后接一个配置示例。');
        update = setText;
        return React.createElement('main', { style: { maxWidth: 860, margin: '40px auto', padding: '0 24px' } },
          React.createElement(AssistantTurnView, {
            messages: [{ role: 'assistant', timestamp: 1, streaming: true, content: [{ type: 'thinking', thinking: text }] }],
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

  const lines = (start, count) => Array.from({ length: count }, (_, index) => `     - entry-${start + index}\n`).join('');
  const append = text => page.evaluate(delta => window.appendThinking(delta), text);
  const renderedLine = line => body.locator('.markdown-code > pre code').filter({ hasText: `entry-${line}` }).waitFor();
  const waitAtBottom = () => page.waitForFunction(() => {
    const node = document.querySelector('.activity-thinking.is-live .activity-thinking-body');
    return node && node.scrollHeight - node.clientHeight - node.scrollTop <= 1;
  }, undefined, { timeout: 2500 });

  // The new Markdown is rendered after the thinking prop has committed.
  await append('\n\n1. 配置示例\n\n   ```yaml\n   entries:\n' + lines(1, 24));
  await renderedLine(24);
  await waitAtBottom();
  await append(lines(25, 12));
  await renderedLine(36);
  await waitAtBottom();
  const pinned = await metrics();
  assert.ok(pinned.scrollHeight > pinned.clientHeight + 120, 'the code must overflow the capped viewport');
  assert.equal(pinned.overscroll, 'auto', 'the thinking body must let the wheel chain to the transcript');

  // 用户上滚：立即释放跟随，后续增量不得把视线拽回底部。
  await body.evaluate(node => {
    node.dispatchEvent(new WheelEvent('wheel', { deltaY: -120, bubbles: true }));
    node.scrollTop = 40;
    node.dispatchEvent(new Event('scroll'));
  });
  const released = await metrics();
  assert.ok(released.scrollTop <= 60, `wheel-up must leave the reader where they scrolled: ${JSON.stringify(released)}`);

  await append(lines(37, 12));
  await renderedLine(48);
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
  await append(lines(49, 12));
  await renderedLine(60);
  await waitAtBottom();
  const resumed = await metrics();
  assert.ok(resumed.distance <= 36, `returning to the bottom must re-arm following: ${JSON.stringify(resumed)}`);

  await page.screenshot({ path: output + 'live-thinking-scroll.png', fullPage: true, animations: 'disabled' });
  assert.deepEqual(errors, []);
  console.log('PASS: live thinking follows rendered code, releases on wheel-up, and re-arms at the bottom.');
} finally {
  await browser.close();
}
