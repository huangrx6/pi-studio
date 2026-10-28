// Visual regression fixtures use actual components, no user data or model requests.
import { chromium } from 'playwright-core';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
const output = new URL('../screenshots/popovers/', import.meta.url).pathname;
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1100, height: 760 } });
  page.setDefaultTimeout(8000); page.setDefaultNavigationTimeout(10000);
  const errors = []; page.on('pageerror', error => { errors.push(error.message); console.log(error.message); });
  await page.route('**/popover-preview', route => route.fulfill({ contentType: 'text/html', body: `<!doctype html><html><head><meta charset="UTF-8"></head><body><div id="fixture"></div><script type="module">
    import RefreshRuntime from '/@react-refresh'; RefreshRuntime.injectIntoGlobalHook(window); window.$RefreshReg$ = () => {}; window.$RefreshSig$ = () => (type) => type; window.__vite_plugin_react_preamble_installed__ = true;
    await import('/src/styles/tokens.css'); await import('/src/styles/palette.css'); await import('/src/app.css');
    const React = (await import('/@fs/${process.cwd()}/node_modules/.vite/deps/react.js')).default;
    const { createRoot } = (await import('/@fs/${process.cwd()}/node_modules/.vite/deps/react-dom_client.js')).default;
    const { Select } = await import('/src/components/Select.tsx');
    const { ExtensionFooter } = await import('/src/components/ExtensionFooter.tsx');
    const cells = text => Array.from(text, text => ({ text, width: /[\\u3000-\\uffff]/u.test(text) ? 2 : 1 }));
    let listener, view = { lines: [cells('◴ 17 轮 109 步 · 92 tok/s     ▱ 15M tok · 缓存命中 96%     ◔ 29%     ···')], interactive: true, overlay: null };
    const panels = [
      ['会话统计', ['模型用时    29 分 34 秒','工具用时    9 分 15 秒','首 Token 平均    3.6 秒','输出速度    92 tok/s','已排除 1 次失败或取消']],
      ['Token 用量 15,236,918 tok', ['缓存命中    96%','未缓存输入    605,782 tok','缓存读取    14,503,936 tok','输出    127,200 tok','费用    $3.5830']],
      ['上下文', ['上下文已用    29.1%','────','已用    291,346 tok','剩余    708,654 tok','容量    1,000,000 tok']],
      ['更多', ['状态    完全访问权限','额度    ⚡DeepSeek balance: ¥267.53','诊断    LSP Inactive','────','模型    deepseek-flash','提供方    deepseek · max']]
    ];
    window.openPanel = index => { const [title, rows] = panels[index]; view = { ...view, overlay: { title, lines: rows.map(cells), rowTypes: rows.map(row => row === '────' ? 'rule' : 'text'), col: index * 20, row: 0, width: 70, contentWidth: 68, close: { row: 2, col: 64 }, offset: { row: 5, col: 1 } } }; listener?.({sessionId:'demo',view,text:''}); };
    window.piApi = { extensionState: async () => ({ view, footer:'',statuses:[] }), onExtensionFooter: callback => { listener = callback; return () => {}; }, footerAction: async input => { if (input.type === 'close' || input.target === 'overlay' && input.type === 'click') view = { ...view, overlay:null }; return view; } };
    function Fixture() { const [mode,setMode] = React.useState('full'); return React.createElement('div', { style: { position:'absolute', bottom:40,left:40,right:40,maxWidth:900,margin:'auto' } },
      React.createElement('div', { className:'composer',style:{padding:20,height:160,display:'flex',alignItems:'end',marginBottom:12} }, React.createElement('div',{className:'composer-mode'},React.createElement(Select,{label:'权限模式',value:mode,onChange:setMode,options:[{value:'ask',label:'请求批准',description:'编辑文件或联网前询问'},{value:'smart',label:'帮我批准',description:'仅对风险操作请求批准'},{value:'full',label:'完全权限',description:'不再询问，直接执行'}]}))),
      React.createElement(ExtensionFooter,{sessionId:'demo'})); }
    createRoot(document.getElementById('fixture')).render(React.createElement(Fixture));
    </script></body></html>` }));
  await page.goto('http://127.0.0.1:5180/popover-preview', { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', {name:'权限模式'}).click();
  const menu = page.getByRole('listbox');
  assert.ok((await menu.boundingBox()).width >= 280);
  for (const label of ['请求批准','帮我批准','完全权限']) await page.getByRole('option', {name: new RegExp('^' + label)}).waitFor();
  await page.screenshot({animations: 'disabled', path: `${output}permissions-light.png`});
  await page.keyboard.press('Escape');
  for (let index = 0; index < 4; index++) {
    await page.evaluate(index => window.openPanel(index), index);
    const panel = page.getByRole('dialog'); await panel.waitFor();
    const box = await panel.boundingBox();
    assert.ok(box.width <= 362 && box.height < 340, JSON.stringify(box));
    assert.ok(box.x >= 0 && box.x + box.width <= 1100);
    const values = await page.locator('.popover-detail-value').evaluateAll(nodes => nodes.map(node => ({ overflow: node.scrollWidth > node.clientWidth + 1, font: getComputedStyle(node).fontFamily })));
    assert.ok(values.every(value => !value.overflow));
    await page.screenshot({animations: 'disabled', path: `${output}details-${index}-light.png`});
    await page.getByRole('button',{name:'关闭扩展详情'}).click(); await panel.waitFor({state:'detached'});
  }
  await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
  await page.evaluate(() => window.openPanel(3));
  await page.screenshot({animations: 'disabled', path: `${output}details-dark.png`});
  await page.keyboard.press('Escape');
  await page.setViewportSize({ width: 390, height: 720 });
  await page.getByRole('button', {name:'权限模式'}).click();
  let box = await menu.boundingBox(); assert.ok(box.x >= 8 && box.x + box.width <= 382);
  await page.keyboard.press('Escape');
  await page.evaluate(() => window.openPanel(3));
  box = await page.getByRole('dialog').boundingBox(); assert.ok(box.x >= 0 && box.x + box.width <= 390);
  assert.deepEqual(errors, []);
  console.log('PASS: permissions, all four detail panels, close/Escape, light/dark, narrow viewport.');
} finally { await browser.close(); }
