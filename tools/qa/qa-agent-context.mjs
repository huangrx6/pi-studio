/**
 * Focused browser QA for the subagent transcript page and the image lightbox.
 *
 * Two regressions the user reported directly:
 *   1. The transcript toolbar spanned the whole window and sat flush against the
 *      tabs, while the page body sits on a centred content track. The transcript
 *      also started on the exact pixel row where the meta card ended.
 *   2. The lightbox title rendered under the macOS traffic lights, because the
 *      caption container is pinned to the top-left corner of the window.
 *
 * Run the Vite server first:
 *   pnpm run web
 *   node tools/qa/qa-agent-context.mjs
 */
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright-core';

const output = new URL('../../.qa/screenshots/agent-context/', import.meta.url).pathname;
await mkdir(output, { recursive: true });

/** hiddenInset traffic lights occupy this rectangle of the window. */
const TRAFFIC_LIGHTS = { left: 0, top: 0, right: 80, bottom: 40 };

const browser = await chromium.launch({
  executablePath: process.env.CHROME_BIN || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
});

const rect = (selector) => {
  const element = document.querySelector(selector);
  if (!element) return null;
  const box = element.getBoundingClientRect();
  return {
    left: Math.round(box.left),
    right: Math.round(box.right),
    top: Math.round(box.top),
    bottom: Math.round(box.bottom),
  };
};

try {
  const page = await browser.newPage({ viewport: { width: 1512, height: 940 }, deviceScaleFactor: 2 });
  page.setDefaultTimeout(12000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));

  await page.route('**/agent-context-probe', (route) => route.fulfill({
    contentType: 'text/html',
    body: `<!doctype html><html><head><meta charset="UTF-8"></head><body style="margin:0"><div id="root"></div><script type="module">
      import RefreshRuntime from '/@react-refresh';
      RefreshRuntime.injectIntoGlobalHook(window); window.$RefreshReg$ = () => {}; window.$RefreshSig$ = () => (t) => t;
      window.__vite_plugin_react_preamble_installed__ = true;
      document.documentElement.dataset.theme = 'dark';
      await import('/src/styles/tokens.css'); await import('/src/styles/palette.css'); await import('/src/app.css');
      await import('/src/shell/session-view.css');
      await import('/@fs${process.cwd()}/node_modules/yet-another-react-lightbox/dist/styles.css');
      await import('/@fs${process.cwd()}/node_modules/yet-another-react-lightbox/dist/plugins/captions/captions.css');
      await import('/@fs${process.cwd()}/node_modules/yet-another-react-lightbox/dist/plugins/counter/counter.css');
      await import('/@fs${process.cwd()}/node_modules/yet-another-react-lightbox/dist/plugins/thumbnails/thumbnails.css');
      const React = (await import('/@fs${process.cwd()}/node_modules/.vite/deps/react.js')).default;
      const { createRoot } = (await import('/@fs${process.cwd()}/node_modules/.vite/deps/react-dom_client.js')).default;
      const { SubagentTranscriptView } = await import('/src/features/subagents/SubagentViews.tsx');
      const { ConversationImageGallery } = await import('/src/features/conversation/ConversationImageGallery.tsx');
      const child = {
        key: 'conversation:1', index: 0, name: 'beijing-scout', agent: 'subagent', status: 'completed',
        task: '上一次运行因基础设施错误（database is locked）中断，请重试并完成原任务：输出北京候选景点调研结果（中文 Markdown，1200 字以内紧凑表格），把完整结果作为回答正文返回。',
        model: 'deepseek/deepseek-flash', thinking: 'max', context: 'fresh', isolation: 'worktree',
        tokens: 192000, providerRequests: 24, turnCount: 2, toolCount: 15, durationMs: 105000, hasTranscript: true,
      };
      const transcript = { messages: [
        { role: 'user', content: [{ type: 'text', text: child.task }], timestamp: Date.now() - 200000, sourceIndex: 1 },
        { role: 'assistant', content: [{ type: 'text', text: '好的，我先看一下工作区结构，再整理北京候选景点。' }, { type: 'toolCall', id: 'c1', name: 'ls', arguments: { path: '.' } }], timestamp: Date.now() - 190000, sourceIndex: 2 },
        { role: 'toolResult', toolCallId: 'c1', content: [{ type: 'text', text: '临时内容.md' }], timestamp: Date.now() - 189000, sourceIndex: 3 },
        { role: 'assistant', content: [{ type: 'text', text: '这里是完整的北京候选景点表格与预约要点。' }], timestamp: Date.now() - 60000, sourceIndex: 4 },
      ] };
      const canvas = document.createElement('canvas'); canvas.width = 900; canvas.height = 560;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#1b2430'; ctx.fillRect(0, 0, 900, 560);
      ctx.fillStyle = '#7fa7c9'; ctx.fillRect(40, 40, 820, 480);
      const src = canvas.toDataURL('image/png');
      createRoot(document.getElementById('root')).render(React.createElement('div', { className: 'app', style: { width: '1512px', height: '940px' } },
        React.createElement('div', { style: { width: '1512px', height: '940px', display: 'flex', flexDirection: 'column' } },
          React.createElement(SubagentTranscriptView, {
            child, transcript, loading: false, error: null,
            stepDisplay: 'summary', stepCollapse: 'auto', showCodeView: false,
            onBackMain: () => {}, onOverview: () => {}, onOpenFile: () => {},
          })),
        React.createElement('div', { style: { position: 'absolute', left: '40px', top: '700px' } },
          React.createElement(ConversationImageGallery, { images: [{ src, alt: 'beijing', mimeType: 'image/png' }, { src, alt: 'xinjiang', mimeType: 'image/png' }] }))));
      window.__ready = true;
    </script></body></html>`,
  }));

  await page.goto('http://127.0.0.1:5180/agent-context-probe');
  await page.waitForFunction(() => window.__ready === true, null, { timeout: 20000 });
  await page.waitForTimeout(700);

  const layout = await page.evaluate(`(() => {
    const rect = ${rect.toString()};
    return {
      toolbar: rect('.agent-context-toolbar'),
      toolbarInner: rect('.agent-context-toolbar-inner'),
      column: rect('.agent-context-column'),
      head: rect('.agent-context-head'),
      meta: rect('.agent-context-meta'),
      transcript: rect('.agent-transcript'),
      firstTurn: rect('.agent-transcript .user-bubble'),
    };
  })()`);

  assert.equal(layout.toolbarInner.left, layout.column.left, 'toolbar shares the body track');
  assert.equal(layout.toolbarInner.right, layout.column.right, 'toolbar shares the body track');
  assert.ok(layout.toolbarInner.top >= 12, `toolbar keeps clear of the window tabs (${layout.toolbarInner.top})`);
  assert.ok(layout.toolbarInner.bottom > layout.toolbarInner.top + 32, 'toolbar keeps a full control height');
  assert.equal(layout.head.left, layout.meta.left, 'header and meta share the track');
  assert.equal(layout.head.right, layout.meta.right, 'header and meta share the track');
  assert.ok(
    layout.transcript.top - layout.meta.bottom >= 20,
    `transcript keeps breathing room below the meta card (${layout.transcript.top - layout.meta.bottom}px)`,
  );
  assert.ok(
    layout.firstTurn.top - layout.transcript.top >= 12,
    `first message does not touch the divider (${layout.firstTurn.top - layout.transcript.top}px)`,
  );

  await page.screenshot({ path: `${output}transcript.png` });

  await page.click('.conversation-image-tile');
  await page.waitForSelector('.studio-lightbox .yarl__slide_title', { timeout: 12000 });
  await page.waitForTimeout(700);

  const lightbox = await page.evaluate(`(() => {
    const visible = [...document.querySelectorAll('.yarl__slide_title')]
      .map((element) => element.getBoundingClientRect())
      .filter((box) => box.right > 0 && box.left < window.innerWidth)
      .map((box) => ({
        left: Math.round(box.left),
        right: Math.round(box.right),
        top: Math.round(box.top),
        bottom: Math.round(box.bottom),
      }));
    return { titles: visible };
  })()`);

  assert.equal(lightbox.titles.length, 1, 'exactly one slide title is on screen');
  const title = lightbox.titles[0];
  const overlapsTrafficLights = title.left < TRAFFIC_LIGHTS.right
    && title.right > TRAFFIC_LIGHTS.left
    && title.top < TRAFFIC_LIGHTS.bottom
    && title.bottom > TRAFFIC_LIGHTS.top;
  assert.equal(overlapsTrafficLights, false, `title avoids the traffic lights (${JSON.stringify(title)})`);
  const center = (title.left + title.right) / 2;
  assert.ok(Math.abs(center - 756) <= 6, `title stays centred (${center})`);

  await page.screenshot({ path: `${output}lightbox.png` });
  assert.deepEqual(errors, [], `no page errors: ${errors.join(' | ')}`);
  console.log('agent context QA passed', JSON.stringify({ layout, lightbox }, null, 1));
} finally {
  await browser.close();
}
