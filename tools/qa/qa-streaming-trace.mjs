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
    await import('/@fs/${process.cwd()}/node_modules/yet-another-react-lightbox/dist/styles.css');
    const React = (await import('/@fs/${process.cwd()}/node_modules/.vite/deps/react.js')).default;
    const { createRoot } = (await import('/@fs/${process.cwd()}/node_modules/.vite/deps/react-dom_client.js')).default;
    const { AssistantTurnView } = await import('/src/components/ChatMessage.tsx');
    const prior = {role:'assistant',timestamp:1,content:[{type:'toolCall',id:'read',name:'read',arguments:{path:'src/components/ChatMessage.tsx'}},{type:'thinking',thinking:'已经定位轨迹布局差异。'},{type:'toolCall',id:'edit',name:'edit',arguments:{path:'src/app.css'}}]};
    const results = new Map(['read','edit'].map(id => [id,{role:'toolResult',content:[{type:'text',text:'Completed'}]}]));
    const canvas = document.createElement('canvas'); canvas.width=480; canvas.height=300;
    const ctx = canvas.getContext('2d'); ctx.fillStyle='#192126'; ctx.fillRect(0,0,480,300);
    ctx.fillStyle='#91c4b5'; ctx.font='24px sans-serif'; ctx.fillText('Workspace preview',32,52);
    const png = canvas.toDataURL('image/png').split(',')[1];
    const imageResults = new Map(results);
    for (const [id,count] of [['read',1],['edit',2]]) imageResults.set(id,{role:'toolResult',content:[
      {type:'text',text:'Screenshot captured'},
      ...Array.from({length:count},()=>({type:'image',mimeType:'image/png',data:png}))
    ]});
    let update;
    window.images = () => update(s => ({...s,images:true,long:false}));
    window.tick = () => update(s => ({...s,text:s.text+' 最新增量内容已经显示在这里。'}));
    window.tool = () => update(s => ({...s,stage:'tool'}));
    window.waiting = () => update(s => ({...s,stage:'waiting'}));
    window.reply = () => update(s => ({...s,stage:'reply'}));
    window.longTrace = () => update(s => ({...s,long:true}));
    window.policy = policy => update(s => ({...s,policy}));
    window.resume = () => update(s => ({...s,busy:true}));
    window.finish = () => update(s => ({...s,busy:false}));
    function Fixture() {
      const [state,setState] = React.useState({stage:'thinking',busy:true,text:'正在梳理布局和交互问题。当前输出会直接展示，收起历史记录也不会隐藏它。'}); update = setState;
      const content = state.stage === 'thinking' ? [{type:'thinking',thinking:state.text}]
        : state.stage === 'tool' ? [{type:'text',text:'接下来检查构建结果。'},{type:'toolCall',id:'build',name:'bash',arguments:{command:'pnpm run build'}}]
        : [{type:'text',text:'已完成调整，实时输出不会藏在历史记录中。'}];
      return React.createElement('main',{style:{maxWidth:900,margin:'60px auto',padding:'0 24px'}},React.createElement(AssistantTurnView,{messages:[state.long ? {...prior,content:[...prior.content,...Array.from({length:30},(_,i)=>({type:'toolCall',id:'tool-'+i,name:'bash',arguments:{command:'pnpm run check --workspace package-'+i}}))]} : prior,{role:'assistant',timestamp:2,streaming:state.busy && state.stage !== 'waiting',content}],toolResults:state.images ? imageResults : results,busy:state.busy,stepDisplay:'standard',stepCollapse:state.policy || 'after-answer'}));
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
  await page.locator('.turn-trace-body > .activity-tool.is-running .activity-tool-summary').filter({hasText:'pnpm run build'}).waitFor();
  const currentToolVerticalAlignment = await page.locator('.turn-trace-body > .activity-tool.is-running').evaluate(tool => {
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

  const toggle = page.locator('.turn-trace-toggle');
  await page.waitForFunction(() => document.querySelector('.turn-trace-toggle').getAttribute('aria-expanded') === 'false');
  await page.locator('.assistant-response').getByText('已完成调整，实时输出不会藏在历史记录中。').waitFor();
  await toggle.click();
  assert.equal(await toggle.getAttribute('aria-expanded'), 'true');
  await page.evaluate(() => window.tick());
  assert.equal(await toggle.getAttribute('aria-expanded'), 'true');
  await page.evaluate(() => window.policy('keep-open'));
  await page.evaluate(() => window.resume());
  await page.evaluate(() => window.finish());
  assert.equal(await toggle.getAttribute('aria-expanded'), 'true');
  await page.evaluate(() => window.policy('manual'));
  await toggle.click();
  await page.evaluate(() => window.resume());
  await page.evaluate(() => window.tick());
  await page.evaluate(() => window.finish());
  assert.equal(await toggle.getAttribute('aria-expanded'), 'false', 'manual choice survives run transitions');
  await page.evaluate(() => window.policy('after-answer'));
  await page.evaluate(() => window.resume());
  await page.waitForFunction(() => document.querySelector('.turn-trace-toggle').getAttribute('aria-expanded') === 'true');
  await toggle.click();
  await page.evaluate(() => window.tick());
  assert.equal(await toggle.getAttribute('aria-expanded'), 'false', 'streaming must not reopen a manually collapsed trace');
  await page.evaluate(() => window.finish());
  await page.screenshot({path:output+'trace-collapsed-dark.png',fullPage:true,animations:'disabled'});
  await toggle.click();
  await page.screenshot({path:output+'trace-expanded-dark.png',fullPage:true,animations:'disabled'});

  await page.evaluate(() => window.longTrace());
  await page.locator('.turn-trace-collapse').waitFor();
  await page.setViewportSize({width:980,height:640});
  await page.locator('.turn-trace-collapse').click();
  assert.equal(await toggle.getAttribute('aria-expanded'), 'false');
  assert.ok(await toggle.isVisible());
  await page.locator('.assistant-response').getByText('已完成调整，实时输出不会藏在历史记录中。').waitFor();
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.screenshot({path:output+'long-trace-collapsed.png',fullPage:true,animations:'disabled'});

  await page.evaluate(() => window.images());
  await toggle.click();
  const imageGroups = page.locator('.tool-result-images');
  assert.equal(await imageGroups.count(), 2);
  for (const [id,count] of [['read',1],['edit',2]]) {
    const group = page.locator('.tool-result-images[data-tool-call-id="'+id+'"]');
    assert.equal(await group.locator('.conversation-image-tile').count(),count);
    assert.ok(await group.evaluate(el => el.previousElementSibling?.classList.contains('activity-tool')));
  }
  assert.equal(await page.locator('.activity-sequence-images').count(),0);
  const imageAlignment = await page.evaluate(() => ({
    icons: [...document.querySelectorAll('.activity-sequence .activity-disclosure-icon > svg')].map(el => {
      const { x, width, height } = el.getBoundingClientRect(); return { x, width, height };
    }),
    labels: [...document.querySelectorAll('.activity-sequence .activity-disclosure-title, .tool-result-images-label')].map(el => el.getBoundingClientRect().x),
  }));
  assert.equal(new Set(imageAlignment.icons.map(icon => `${icon.width}x${icon.height}`)).size, 1);
  assert.ok(Math.max(...imageAlignment.icons.map(icon => icon.x)) - Math.min(...imageAlignment.icons.map(icon => icon.x)) < .5);
  assert.ok(Math.max(...imageAlignment.labels) - Math.min(...imageAlignment.labels) < .5);

  const firstGroup = imageGroups.first();
  await firstGroup.locator('button.tool-result-images-toggle').click();
  assert.equal(await firstGroup.locator('.conversation-image-tile').first().isVisible(), false);
  assert.ok(await imageGroups.last().locator('.conversation-image-tile').first().isVisible());
  await firstGroup.locator('button.tool-result-images-toggle').click();
  await page.screenshot({path:output+'step-images-dark.png',fullPage:true,animations:'disabled'});
  await firstGroup.locator('.conversation-image-tile').click();
  await page.getByRole('dialog',{name:'图片预览'}).waitFor();
  assert.equal(await page.locator('.yarl__counter').count(),0,'single-step preview must not include other steps');
  await page.getByRole('button',{name:'关闭图片预览',exact:true}).click();
  await toggle.click();
  assert.equal(await imageGroups.last().locator('.conversation-image-tile').first().isVisible(), false);
  assert.deepEqual(errors, []);
  console.log('PASS: live thinking deltas, compact/collapsed history, visible commentary and tools, reply/wait/completion states, light/dark.');
} finally { await browser.close(); }
