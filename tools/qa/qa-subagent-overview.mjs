/**
 * Focused browser QA for the 子智能体 overview.
 *
 * Proves two things the user reported directly:
 *   1. Every row of the overview shares one content track: the header, the
 *      aggregate strip, the search row and the list start and end on the same
 *      x coordinates instead of drifting apart.
 *   2. The flow view renders a real graph (one root node plus one node per
 *      child, and one edge per child) instead of the retired hand-built axis.
 *
 * Run the Vite server first:
 *   pnpm run web
 *   node tools/qa/qa-subagent-overview.mjs
 */
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright-core';

const output = new URL('../../.qa/screenshots/subagent-overview/', import.meta.url).pathname;
await mkdir(output, { recursive: true });

const browser = await chromium.launch({
  executablePath: process.env.CHROME_BIN || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
});
try {
  const page = await browser.newPage({ viewport: { width: 1512, height: 940 }, deviceScaleFactor: 2 });
  page.setDefaultTimeout(10000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));

  await page.route('**/subagent-overview', (route) => route.fulfill({
    contentType: 'text/html',
    body: `<!doctype html><html><head><meta charset="UTF-8"></head><body style="margin:0;background:#0b0e13"><div id="root"></div><script type="module">
      import RefreshRuntime from '/@react-refresh';
      RefreshRuntime.injectIntoGlobalHook(window); window.$RefreshReg$ = () => {}; window.$RefreshSig$ = () => (type) => type;
      window.__vite_plugin_react_preamble_installed__ = true;
      document.documentElement.dataset.theme = 'dark';
      await import('/src/styles/tokens.css'); await import('/src/styles/palette.css'); await import('/src/app.css');
      await import('/src/shell/session-view.css');
      const React = (await import('/@fs${process.cwd()}/node_modules/.vite/deps/react.js')).default;
      const { createRoot } = (await import('/@fs${process.cwd()}/node_modules/.vite/deps/react-dom_client.js')).default;
      const { SubagentOverview } = await import('/src/features/subagents/SubagentViews.tsx');
      const children = [
        { key: 'conversation:1', index: 0, name: 'beijing-scout', agent: 'subagent', status: 'completed', task: '上一次运行因基础设施错误（database is locked）中断，请重试并完成原任务：输出北京候选景点调研结果（中文 Markdown，1200 字以内紧凑表格），把门票价格、预约要求、建议游玩时长写清楚。', model: 'deepseek/deepseek-flash', isolation: 'worktree', tokens: 192000, providerRequests: 12, turnCount: 6, toolCount: 9, durationMs: 105000, preview: '', hasTranscript: true, startedAt: Date.now() - 105000, updatedAt: Date.now() - 60000 },
        { key: 'conversation:2', index: 1, name: 'xinjiang-scout', agent: 'subagent', status: 'running', task: '你是旅游调研子 Agent，只负责【新疆】。任务：调研新疆“好玩的地方”，产出一份可直接用于排行程的候选清单。', model: 'deepseek/deepseek-flash', isolation: 'worktree', tokens: 2200000, providerRequests: 80, turnCount: 40, toolCount: 60, currentTool: 'web_search', preview: '', hasTranscript: true, startedAt: Date.now() - 420000, updatedAt: Date.now() - 1000 },
        { key: 'conversation:3', index: 2, name: 'gansu-scout', agent: 'subagent', status: 'failed', task: '输出甘肃河西走廊 5 日线路候选。', model: 'deepseek/deepseek-flash', isolation: 'worktree', tokens: 41000, providerRequests: 3, turnCount: 2, toolCount: 1, durationMs: 32000, preview: '', error: 'database is locked', hasTranscript: true, startedAt: Date.now() - 900000, updatedAt: Date.now() - 800000 },
      ];
      const state = { mode: 'list' };
      const root = createRoot(document.getElementById('root'));
      function render() {
        root.render(React.createElement('div', { className: 'app', style: { width: '1512px', height: '940px' } },
          React.createElement('div', { style: { width: '1512px', height: '940px', display: 'flex', flexDirection: 'column' } },
            React.createElement(SubagentOverview, {
              children,
              selection: { label: 'DeepSeek-V4.1-Flash', modelRef: 'deepseek/deepseek-flash' },
              refreshing: false,
              onRefresh: () => {}, onOpenChild: () => {}, onDeleteChild: () => {}, onReplyChild: async () => {},
              onReturnMain: () => {},
              mode: state.mode,
              onModeChange: (mode) => { state.mode = mode; render(); },
            }))));
      }
      render();
      window.__setMode = (mode) => { state.mode = mode; render(); };
      window.__probeReady = true;
    </script></body></html>`,
  }));

  await page.goto('http://127.0.0.1:5180/subagent-overview');
  await page.waitForFunction(() => window.__probeReady === true, null, { timeout: 20000 });
  await page.waitForTimeout(600);

  const rects = await page.evaluate(() => {
    const pick = (selector) => {
      const element = document.querySelector(selector);
      if (!element) return null;
      const box = element.getBoundingClientRect();
      return {
        left: Math.round(box.left),
        right: Math.round(box.right),
        top: Math.round(box.top),
      };
    };
    return {
      header: pick('.agent-overview-head'),
      title: pick('.agent-overview-head > h2'),
      actions: pick('.agent-overview-actions'),
      strip: pick('.agent-fleet-strip'),
      tools: pick('.agent-list-tools'),
      list: pick('.agent-list'),
      stripCell: pick('.agent-fleet-strip > span'),
    };
  });

  assert.ok(rects.strip && rects.tools && rects.list, 'overview rows render');
  for (const key of ['tools', 'list']) {
    assert.equal(rects[key].left, rects.header.left, `${key} starts on the header track`);
    assert.equal(rects[key].right, rects.header.right, `${key} ends on the header track`);
    assert.equal(rects[key].left, rects.strip.left, `${key} shares the strip's left edge`);
    assert.equal(rects[key].right, rects.strip.right, `${key} shares the strip's right edge`);
  }
  assert.equal(rects.actions.right, rects.header.right, 'view controls sit on the right edge');

  await page.screenshot({ path: `${output}list.png` });

  await page.evaluate(() => window.__setMode('formation'));
  await page.waitForSelector('.agent-flow .react-flow__node', { timeout: 15000 });
  await page.waitForTimeout(500);

  const flow = await page.evaluate(() => {
    const nodes = [...document.querySelectorAll('.react-flow__node')];
    const edges = [...document.querySelectorAll('.react-flow__edge')];
    const root = document.querySelector('.react-flow__node[data-id="main"]');
    const members = nodes.filter((node) => node !== root);
    const canvas = document.querySelector('.agent-flow');
    const canvasBox = canvas ? canvas.getBoundingClientRect() : null;
    return {
      nodeCount: nodes.length,
      memberCount: members.length,
      edgeCount: edges.length,
      hasCanvas: Boolean(canvas),
      canvasHeight: canvasBox ? Math.round(canvasBox.height) : 0,
      canvasLeft: canvasBox ? Math.round(canvasBox.left) : 0,
      canvasRight: canvasBox ? Math.round(canvasBox.right) : 0,
      rootLeft: root ? Math.round(root.getBoundingClientRect().left) : 0,
      rootCenter: root
        ? Math.round(root.getBoundingClientRect().top + root.getBoundingClientRect().height / 2)
        : 0,
      memberCenters: members.map((node) => {
        const box = node.getBoundingClientRect();
        return Math.round(box.top + box.height / 2);
      }),
      membersLeft: members.map((node) => Math.round(node.getBoundingClientRect().left)),
      activeEdges: document.querySelectorAll('.react-flow__edge.animated').length,
      order: nodes.map((node) => ({ id: node.dataset.id, top: Math.round(node.getBoundingClientRect().top), label: node.textContent.slice(0, 12) })),
    };
  });

  assert.ok(flow.hasCanvas, 'flow canvas renders');
  assert.equal(flow.canvasLeft, rects.header.left, 'flow canvas starts on the same track');
  assert.equal(flow.canvasRight, rects.header.right, 'flow canvas ends on the same track');
  assert.equal(flow.nodeCount, 4, 'one root node plus three members');
  assert.equal(flow.memberCount, 3, 'every child gets a node');
  assert.equal(flow.edgeCount, 3, 'every child gets an edge');
  assert.equal(flow.activeEdges, 1, 'only the running child animates its edge');
  assert.ok(flow.membersLeft.every((left) => left > flow.rootLeft), 'members sit right of the parent');
  assert.deepEqual(
    flow.order.filter((node) => node.id !== 'main').map((node) => node.id),
    ['conversation:3', 'conversation:2', 'conversation:1'],
    'flow order matches the list sections: attention, active, done',
  );
  assert.equal(new Set(flow.membersLeft).size, 1, 'members share one column');
  assert.ok(flow.canvasHeight <= 560 && flow.canvasHeight >= 320, 'canvas keeps a bounded height');
  const memberCenter = Math.round(
    flow.memberCenters.reduce((sum, value) => sum + value, 0) / flow.memberCenters.length,
  );
  assert.ok(
    Math.abs(flow.rootCenter - memberCenter) <= 2,
    `parent stays vertically centred on its members (${flow.rootCenter} vs ${memberCenter})`,
  );

  await page.screenshot({ path: `${output}flow.png` });
  assert.deepEqual(errors, [], `no page errors: ${errors.join(' | ')}`);
  console.log('subagent overview QA passed', JSON.stringify({ rects, flow }, null, 1));
} finally {
  await browser.close();
}
