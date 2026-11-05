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
        task: '你负责「北京好玩的地方」调研，产出一份可直接用于排行程的中文调研笔记。背景：用户要和家人一起出行（成人为主，能走中等强度路线），想了解北京值得玩的地方，之后会由主 Agent 综合出「一周旅游计划」。你只做北京部分，不要涉及新疆。工作方式：1. 先用 tool_search 搜索并加载 firecrawl 工具，用 firecrawl_search 核实关键事实：景点开放时间、是否需要提前实名预约、门票价格、地铁交通、近期是否有闭馆或限流。至少核实 5 个核心景点。2. 若网络工具不可用或结果不足，就基于你已有的可靠知识写，但必须显式标注「未联网核实」的条目。产出（写入文件）：在仓库根目录创建 旅行计划/北京调研.md。',
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
      avatar: rect('.agent-context-avatar'),
      title: rect('.agent-context-head h2'),
      state: rect('.agent-context-state'),
      brief: rect('.agent-context-brief'),
    };
  })()`);

  assert.equal(layout.toolbarInner.left, layout.column.left, 'toolbar shares the body track');
  assert.equal(layout.toolbarInner.right, layout.column.right, 'toolbar shares the body track');
  assert.ok(layout.toolbarInner.top >= 12, `toolbar keeps clear of the window tabs (${layout.toolbarInner.top})`);
  assert.ok(layout.toolbarInner.bottom > layout.toolbarInner.top + 32, 'toolbar keeps a full control height');
  assert.ok(layout.avatar.right - layout.avatar.left <= 32, `the mark stays small (${layout.avatar.right - layout.avatar.left}px)`);
  assert.ok(layout.avatar.top >= layout.title.top - 4 && layout.avatar.bottom <= layout.title.bottom + 4, 'the mark sits on the title row');
  assert.ok(layout.title.right < layout.state.left, 'state chips stay right of the title on the same row');
  assert.equal(layout.brief.left, layout.column.left, 'the brief spans the full content width');
  assert.equal(layout.brief.right, layout.column.right, 'the brief spans the full content width');
  assert.ok(layout.brief.top > layout.title.bottom, 'the brief sits under the title row');
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

  const task = await page.evaluate(() => {
    const paragraph = document.querySelector('.agent-context-task');
    const toggle = document.querySelector('.agent-context-task-toggle');
    if (!paragraph || !toggle) return null;
    return {
      clamped: paragraph.scrollHeight > paragraph.clientHeight + 1,
      lines: Math.round(paragraph.clientHeight / parseFloat(getComputedStyle(paragraph).lineHeight)),
      toggle: toggle.textContent.trim(),
      expanded: toggle.getAttribute('aria-expanded'),
    };
  });
  assert.ok(task, 'long instructions expose an expand control');
  assert.equal(task.clamped, true, 'the instruction is clamped by default');
  assert.ok(task.lines <= 3, `clamp keeps three lines (${task.lines})`);
  assert.match(task.toggle, /展开完整指令/);

  await page.click('.agent-context-task-toggle');
  await page.waitForTimeout(200);
  const expanded = await page.evaluate(() => {
    const paragraph = document.querySelector('.agent-context-task');
    const toggle = document.querySelector('.agent-context-task-toggle');
    return {
      clamped: paragraph.scrollHeight > paragraph.clientHeight + 1,
      toggle: toggle.textContent.trim(),
      expanded: toggle.getAttribute('aria-expanded'),
    };
  });
  assert.equal(expanded.clamped, false, 'expanding shows the whole instruction');
  assert.equal(expanded.expanded, 'true');
  assert.match(expanded.toggle, /收起指令/);
  await page.click('.agent-context-task-toggle');
  await page.waitForTimeout(200);

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
