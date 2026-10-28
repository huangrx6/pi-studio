// Visual regression fixtures use actual components, no user data or model requests.
import { chromium } from 'playwright-core';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
const output = new URL('../screenshots/chat-review/', import.meta.url).pathname;
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1100, height: 760 } });
  page.setDefaultTimeout(8000); page.setDefaultNavigationTimeout(10000);
  const errors = []; page.on('pageerror', error => { errors.push(error.message); console.log(error.message); });
  await page.route('**/popover-preview', route => route.fulfill({ contentType: 'text/html', body: `<!doctype html><html><head><meta charset="UTF-8"></head><body style="overflow:auto;height:auto"><div id="fixture"></div><script type="module">
    import RefreshRuntime from '/@react-refresh'; RefreshRuntime.injectIntoGlobalHook(window); window.$RefreshReg$ = () => {}; window.$RefreshSig$ = () => (type) => type; window.__vite_plugin_react_preamble_installed__ = true;
    await import('/src/styles/tokens.css'); await import('/src/styles/palette.css'); await import('/src/app.css');
    const React = (await import('/@fs/${process.cwd()}/node_modules/.vite/deps/react.js')).default;
    const { createRoot } = (await import('/@fs/${process.cwd()}/node_modules/.vite/deps/react-dom_client.js')).default;
    const { AssistantTurnView } = await import('/src/components/ChatMessage.tsx');
    const tools = ['read', 'edit', 'edit', 'write', 'edit', 'edit'];
    const messages = [{role:'assistant', timestamp:1, content:[
      {type:'thinking',thinking:'先检查组件，再统一布局和字体。'},
      {type:'text',text:'我会调整变更摘要的位置，并简化轨迹图标。'},
      ...tools.map((name,index) => ({type:'toolCall',id:String(index),name,arguments:{path:'src/component-'+index+'.tsx',content:'export const ready = true;'}})),
      {type:'text',text:'## 调整完成\\n\\n正文与标题现在使用同一套字体，通过字号和字重区分层级。\\n\\n文件变更在回答结束后展示，可以展开查看每次修改。'.split('\\n').join(String.fromCharCode(10))}
    ]}];
    const results = new Map(tools.map((name,index) => [String(index),{role:'toolResult',content:[{type:'text',text:'Completed'}],details:name==='edit'?{patch:'--- a/file.ts\\n+++ b/file.ts\\n@@ -1 +1 @@\\n-before\\n+after'.split('\\n').join(String.fromCharCode(10))}:undefined}]));
    let changeBusy;
    window.finish = () => changeBusy(false);
    function Fixture() { const [busy,setBusy] = React.useState(true); changeBusy = setBusy; return React.createElement('main', {style:{maxWidth:900,margin:'30px auto',padding:'0 24px'}},React.createElement(AssistantTurnView,{messages,toolResults:results,busy,showCodeView:true,cwd:'/project',stepDisplay:'detailed'})); }
    createRoot(document.getElementById('fixture')).render(React.createElement(Fixture));
    </script></body></html>` }));
  await page.goto('http://127.0.0.1:5180/popover-preview', { waitUntil: 'domcontentloaded' });
  await page.locator('.assistant-response').waitFor();
  assert.equal(await page.locator('.file-change-summary').count(), 0, 'no card before the round ends');
  await page.evaluate(() => window.finish());
  const card = page.getByRole('region', { name: '本轮文件变更' }); await card.waitFor();
  assert.equal(await page.locator('.file-change-item').count(), 3);
  assert.ok((await card.boundingBox()).y > (await page.locator('.assistant-response').boundingBox()).y);
  assert.equal(await card.getByText('src/component-0.tsx', {exact:true}).count(), 0, 'read-only paths excluded');
  const fonts = await page.locator('.assistant-response .markdown').evaluate(node => [getComputedStyle(node.querySelector('h2')).fontFamily, getComputedStyle(node.querySelector('p')).fontFamily]);
  assert.equal(fonts[0], fonts[1]);
  const icon = await page.locator('.run-history .activity-tool').first().evaluate(node => ({border:getComputedStyle(node).borderWidth,shadow:getComputedStyle(node).boxShadow}));
  assert.equal(icon.border, '0px'); assert.equal(icon.shadow, 'none');
  await page.screenshot({path:output+'light.png',fullPage:true,animations:'disabled'});
  await page.getByRole('button',{name:'再显示 2 个文件'}).click();
  assert.equal(await page.locator('.file-change-item').count(),5);
  await page.getByRole('button',{name:'查看变更',exact:true}).click();
  await page.getByText('写入内容 · 未提供修改前快照').waitFor();
  await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
  await page.screenshot({path:output+'dark-review.png',fullPage:true,animations:'disabled'});
  assert.deepEqual(errors, []);
  console.log('PASS: completed-round placement, successful mutations only, file expansion, diff review, unified fonts and lightweight timeline.');
} finally { await browser.close(); }
