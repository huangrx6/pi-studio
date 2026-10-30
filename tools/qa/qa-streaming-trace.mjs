// Visual regression fixtures use actual components, no user data or model requests.
import { chromium } from 'playwright-core';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
const output = new URL('../../.qa/screenshots/streaming-trace/', import.meta.url).pathname;
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1100, height: 760 }, deviceScaleFactor: 2 });
  page.setDefaultTimeout(8000); page.setDefaultNavigationTimeout(10000);
  const errors = []; page.on('pageerror', error => { errors.push(error.message); console.log(error.message); });
  await page.route('**/popover-preview', route => route.fulfill({ contentType: 'text/html', body: `<!doctype html><html><head><meta charset="UTF-8"></head><body style="overflow:auto;height:auto"><div id="fixture"></div><script type="module">
    import RefreshRuntime from '/@react-refresh'; RefreshRuntime.injectIntoGlobalHook(window); window.$RefreshReg$ = () => {}; window.$RefreshSig$ = () => (type) => type; window.__vite_plugin_react_preamble_installed__ = true;
    await import('/src/styles/tokens.css'); await import('/src/styles/palette.css'); await import('/src/app.css');
    const React = (await import('/@fs/${process.cwd()}/node_modules/.vite/deps/react.js')).default;
    const { createRoot } = (await import('/@fs/${process.cwd()}/node_modules/.vite/deps/react-dom_client.js')).default;
    const { AssistantTurnView } = await import('/src/components/ChatMessage.tsx');
    const prior = {role:'assistant',timestamp:1,content:[{type:'toolCall',id:'read',name:'read',arguments:{path:'src/components/ChatMessage.tsx'}},{type:'thinking',thinking:'已经定位轨迹布局差异。'},{type:'toolCall',id:'edit',name:'edit',arguments:{path:'src/app.css'}}]};
    const results = new Map(['read','edit'].map(id => [id,{role:'toolResult',content:[{type:'text',text:'Completed'}]}]));
    let update;
    window.tick = () => update(s => ({...s,text:s.text+' 最新增量内容已经显示在这里。'}));
    window.tool = () => update(s => ({...s,stage:'tool'}));
    window.waiting = () => update(s => ({...s,stage:'waiting'}));
    window.reply = () => update(s => ({...s,stage:'reply'}));
    window.finish = () => update(s => ({...s,busy:false}));
    function Fixture() {
      const [state,setState] = React.useState({stage:'thinking',busy:true,text:'正在梳理布局和交互问题。当前输出会直接展示，收起历史记录也不会隐藏它。'}); update = setState;
      const content = state.stage === 'thinking' ? [{type:'thinking',thinking:state.text}]
        : state.stage === 'tool' ? [{type:'text',text:'接下来检查构建结果。'},{type:'toolCall',id:'build',name:'bash',arguments:{command:'pnpm run build'}}]
        : [{type:'text',text:'已完成调整，实时输出不会藏在历史记录中。'}];
      return React.createElement('main',{style:{maxWidth:900,margin:'60px auto',padding:'0 24px'}},React.createElement(AssistantTurnView,{messages:[prior,{role:'assistant',timestamp:2,streaming:state.busy && state.stage !== 'waiting',content}],toolResults:results,busy:state.busy,stepDisplay:'standard'}));
    }
    createRoot(document.getElementById('fixture')).render(React.createElement(Fixture));
    </script></body></html>` }));
  await page.goto('http://127.0.0.1:5180/popover-preview', { waitUntil: 'domcontentloaded' });
  await page.locator('.run-current').waitFor();
  await page.locator('.activity-sequence').waitFor();
  assert.equal(await page.locator('.activity-sequence .activity-thinking').getAttribute('open'), null);
  await page.locator('.run-current').getByText('思考中',{exact:true}).waitFor();
  await page.locator('.run-current').getByText('推理中',{exact:true}).waitFor();
  await page.evaluate(() => window.tick());
  await page.locator('.run-current .markdown').filter({hasText:'最新增量内容已经显示在这里'}).waitFor();
  assert.equal(await page.locator('.run-current details').count(),0,'thinking is not nested in details');
  await page.locator('.activity-sequence .activity-tool').first().waitFor();
  await page.locator('.activity-sequence .activity-tool-summary').filter({hasText:'src/app.css'}).waitFor();
  const traceAlignment = await page.evaluate(() => {
    const completedIcons = Array.from(document.querySelectorAll('.activity-sequence .activity-tool-icon, .activity-sequence .activity-thinking-icon'));
    const completedText = Array.from(document.querySelectorAll('.activity-sequence .activity-tool-name, .activity-sequence .activity-thinking-label'));
    return {
      icon: completedIcons.map(node => node.getBoundingClientRect().left),
      text: completedText.map(node => node.getBoundingClientRect().left),
    };
  });
  for (const positions of Object.values(traceAlignment)) {
    assert.ok(Math.max(...positions) - Math.min(...positions) <= 0.5,
      `execution trace alignment drifted: ${JSON.stringify(traceAlignment)}`);
  }
  const toolVerticalAlignment = await page.evaluate(() => Array.from(document.querySelectorAll('.activity-sequence .activity-tool')).map(tool => {
    const center = selector => {
      const rect = tool.querySelector(selector).getBoundingClientRect();
      return rect.top + rect.height / 2;
    };
    return {
      summary: center('summary'),
      icon: center('.activity-tool-icon'),
      name: center('.activity-tool-name'),
      status: center('.activity-tool-status'),
      chevron: center('.activity-tool-chevron'),
    };
  }));
  for (const alignment of toolVerticalAlignment) {
    assert.ok(Math.max(...Object.values(alignment)) - Math.min(...Object.values(alignment)) <= 0.5,
      `completed tool row is not vertically centered: ${JSON.stringify(alignment)}`);
  }
  await page.screenshot({path:output+'thinking-light.png',fullPage:true,animations:'disabled'});
  await page.locator('.run-current .markdown').waitFor();
  await page.evaluate(() => window.tool());
  await page.locator('.run-live-status').getByText('正在执行',{exact:true}).waitFor();
  await page.locator('.assistant-response').getByText('接下来检查构建结果。',{exact:true}).waitFor();
  await page.locator('.assistant-turn-main > .activity-tool.is-running .activity-tool-summary').filter({hasText:'pnpm run build'}).waitFor();
  const currentToolVerticalAlignment = await page.locator('.assistant-turn-main > .activity-tool.is-running').evaluate(tool => {
    const center = selector => {
      const rect = tool.querySelector(selector).getBoundingClientRect();
      return rect.top + rect.height / 2;
    };
    return {
      summary: center('summary'),
      icon: center('.activity-tool-icon'),
      name: center('.activity-tool-name'),
      summaryText: center('.activity-tool-summary'),
      status: center('.activity-tool-status'),
      chevron: center('.activity-tool-chevron'),
    };
  });
  assert.ok(
    Math.max(...Object.values(currentToolVerticalAlignment)) - Math.min(...Object.values(currentToolVerticalAlignment)) <= 0.5,
    `running tool row is not vertically centered: ${JSON.stringify(currentToolVerticalAlignment)}`,
  );
  await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
  await page.screenshot({path:output+'tool-dark.png',fullPage:true,animations:'disabled'});
  await page.evaluate(() => window.reply());
  await page.locator('.run-live-status').getByText('正在回复',{exact:true}).waitFor();
  await page.locator('.assistant-response').getByText('已完成调整，实时输出不会藏在历史记录中。').waitFor();
  assert.equal(await page.getByText('已完成',{exact:true}).count(),0);
  await page.evaluate(() => window.waiting());
  await page.locator('.run-live-status').getByText('正在继续处理',{exact:true}).waitFor();
  assert.equal(await page.getByText('已完成',{exact:true}).count(),0);
  await page.evaluate(() => window.finish());
  await page.locator('.run-current').waitFor({state:'detached'});
  await page.getByText('已完成',{exact:true}).waitFor();
  assert.deepEqual(errors, []);
  console.log('PASS: live thinking deltas, compact/collapsed history, visible commentary and tools, reply/wait/completion states, light/dark.');
} finally { await browser.close(); }
