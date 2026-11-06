/** Deterministic component races against Vite dev; no IPC, models, or user data.
 * PREVIEW_URL=http://127.0.0.1:5180/ node tools/qa/qa-model-picker-races.mjs
 */
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';

const browser = await chromium.launch({ executablePath: process.env.CHROME_BIN || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 800, height: 700 } });
  page.setDefaultTimeout(8000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/model-picker-fixture', route => route.fulfill({ contentType: 'text/html', body: `<!doctype html><html><head><meta charset="UTF-8"></head><body><div id="fixture"></div><script type="module">
    import RefreshRuntime from '/@react-refresh';
    RefreshRuntime.injectIntoGlobalHook(window); window.$RefreshReg$ = () => {}; window.$RefreshSig$ = () => type => type; window.__vite_plugin_react_preamble_installed__ = true;
    await import('/src/styles/tokens.css'); await import('/src/styles/palette.css'); await import('/src/app.css');
    const React = (await import('/@fs/${process.cwd()}/node_modules/.vite/deps/react.js')).default;
    const {createRoot} = (await import('/@fs/${process.cwd()}/node_modules/.vite/deps/react-dom_client.js')).default;
    const {ModelPicker} = await import('/src/features/models/ModelPicker.tsx');
    const selection = {modelRef:'demo/a',label:'Model A',thinkingLevel:'default',thinkingLevels:['default','high'],effectiveThinkingLevel:'high',defaultThinkingLevel:'high'};
    const catalog = {models:['a','b'].map(id=>({id:'demo/'+id,name:'Model '+id.toUpperCase(),provider:'demo',providerName:'Demo',model:id})),enabled:[],current:'demo/a',selection,defaultSelection:selection};
    window.qa = { saves:[], loads:[], handled:[], control:null };
    function Fixture() {
      const [state,setState] = React.useState({context:'session:a',scope:'session',pending:false,unavailable:false,request:null});
      window.qa.control = patch => setState(value=>({...value,...patch}));
      return React.createElement('div',{style:{position:'absolute',bottom:40,right:40,width:300}},
        React.createElement('input',{id:'outside','aria-label':'外部输入',style:{position:'fixed',top:20,left:20,width:160}}),
        React.createElement(ModelPicker, {
          selection:{...selection,pending:state.pending,unavailable:state.unavailable,unavailableReason:'当前来源已停用，请选择其他模型。'},scope:state.scope,contextKey:state.context,disabled:false,hidden:false,
          loadCatalog:()=>new Promise((resolve,reject)=>window.qa.loads.push({resolve:models=>resolve(models ? {...catalog,models} : catalog),reject})),
          onSelectModel:id=>new Promise((resolve,reject)=>window.qa.saves.push({context:state.context,id,resolve,reject})),
          onSelectThinking:level=>new Promise((resolve,reject)=>window.qa.saves.push({context:state.context,level,resolve,reject})),
          onManage:()=>{}, request:state.request,
          onRequestHandled:()=>{window.qa.handled.push(state.request.id);setState(value=>({...value,request:null}));},
        }));
    }
    createRoot(document.getElementById('fixture')).render(React.createElement(Fixture));
  </script></body></html>` }));
  await page.goto(new URL('model-picker-fixture', process.env.PREVIEW_URL || 'http://127.0.0.1:5180/').href);
  const panel = page.locator('.model-popover');
  const trigger = page.locator('.model-label');
  const modelB = page.getByRole('menuitemradio', { name: 'Model B', exact: true });
  const paint = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  async function resolveLatestCatalog() {
    await page.evaluate(() => window.qa.loads.at(-1).resolve());
    await paint();
  }
  async function openModels() {
    await trigger.click();
    await page.getByRole('menuitem', { name: /切换会话模型|修改默认模型/ }).click();
    await resolveLatestCatalog();
    await modelB.waitFor();
  }

  await openModels();
  await modelB.focus();
  await modelB.press('Enter');
  await paint();
  assert.equal(await modelB.getAttribute('aria-disabled'), 'true');
  assert.equal(await modelB.evaluate(node => document.activeElement === node), true, 'saving preserves the focused option');
  await modelB.evaluate(node => node.click());
  assert.equal(await page.evaluate(() => window.qa.saves.length), 1, 'duplicate clicks do not issue overlapping writes');
  await page.getByRole('textbox', { name: '外部输入' }).click();
  await panel.waitFor({ state: 'detached' });
  await openModels();
  assert.equal(await modelB.getAttribute('aria-disabled'), 'true', 'reopening preserves the in-flight write lock');
  await page.evaluate(() => window.qa.saves[0].resolve());
  await paint();
  assert.equal(await panel.count(), 1, 'old success does not close the reopened menu');
  assert.equal(await page.getByRole('textbox', { name: '搜索模型' }).evaluate(node => document.activeElement === node), true, 'old success does not steal focus');
  assert.equal(await modelB.getAttribute('aria-disabled'), 'false');

  await modelB.click();
  await page.evaluate(() => window.qa.control({ context: 'session:b' }));
  await panel.waitFor({ state: 'detached' });
  await openModels();
  await modelB.click();
  await page.evaluate(() => window.qa.saves[1].reject(new Error('OLD_SESSION_ERROR')));
  await paint();
  assert.equal(await page.getByText('OLD_SESSION_ERROR').count(), 0);
  assert.equal(await modelB.getAttribute('aria-disabled'), 'true', 'old finalizer does not unlock another context');
  await page.evaluate(() => window.qa.saves[2].reject(new Error('CURRENT_SAVE_ERROR')));
  await page.getByRole('alert').filter({ hasText: 'CURRENT_SAVE_ERROR' }).waitFor();
  assert.equal(await modelB.evaluate(node => document.activeElement === node), true, 'save failure keeps option focus for retry');
  await modelB.click();
  await page.evaluate(() => window.qa.saves[3].resolve());
  await panel.waitFor({ state: 'detached' });
  assert.equal(await trigger.evaluate(node => document.activeElement === node), true, 'current success returns focus to the trigger');

  await trigger.click();
  await page.getByRole('menuitem', { name: /切换会话模型/ }).click();
  await page.evaluate(() => window.qa.loads.at(-1).reject(new Error('CATALOG_OFFLINE')));
  await page.getByRole('alert').filter({ hasText: 'CATALOG_OFFLINE' }).waitFor();
  assert.equal(await page.getByText('暂无可用模型', { exact: true }).count(), 0, 'a load error is not an empty catalog');
  await page.getByRole('button', { name: '重新加载', exact: true }).click();
  await resolveLatestCatalog();
  await modelB.waitFor();
  assert.equal(await page.getByText(/CATALOG_OFFLINE/).count(), 0);

  await page.getByRole('textbox', { name: '外部输入' }).click();
  await trigger.click();
  const staleLoad = await page.evaluate(() => window.qa.loads.length - 1);
  await page.getByRole('textbox', { name: '外部输入' }).click();
  await openModels();
  await page.evaluate(index => window.qa.loads[index].resolve([]), staleLoad);
  await paint();
  assert.equal(await modelB.count(), 1, 'late catalog from an earlier opening cannot replace the current list');

  await page.evaluate(() => window.qa.control({ pending: true, unavailable: true, request: { id: 1, view: 'models' } }));
  await page.waitForFunction(() => window.qa.handled.includes(1));
  await page.getByText('只修改这条会话，不会改动新对话默认值', { exact: true }).waitFor();
  await page.getByText('下一轮生效；当前回复继续使用原模型', { exact: true }).waitFor();
  await page.getByRole('alert').filter({ hasText: '当前来源已停用' }).waitFor();
  await page.evaluate(() => window.qa.control({ request: { id: 2, view: 'thinking' } }));
  await page.waitForFunction(() => window.qa.handled.includes(2));
  assert.equal(await page.getByRole('menuitemradio', { name: 'High', exact: true }).isDisabled(), true, 'unavailable models cannot change thinking levels');
  await page.evaluate(() => { window.qa.loads.at(-2).resolve(); window.qa.loads.at(-1).resolve(); });
  await paint();
  assert.deepEqual(await page.evaluate(() => window.qa.handled), [1, 2], 'slash opens are acknowledged once without awaiting catalog loads');
  await page.keyboard.press('Escape');
  await page.locator('.model-popover--main').waitFor();
  await page.keyboard.press('Escape');
  await panel.waitFor({ state: 'detached' });

  await page.evaluate(() => window.qa.control({ context: 'default:workspace', scope: 'default', pending: false, unavailable: false }));
  await openModels();
  await page.getByText('修改后会应用到之后创建的新对话', { exact: true }).waitFor();
  await page.setViewportSize({ width: 420, height: 640 });
  const box = await panel.boundingBox();
  assert.ok(box && box.x >= 0 && box.x + box.width <= 420, 'model picker stays within a narrow viewport');
  assert.deepEqual(errors, []);
  console.log('PASS: model save generations, per-context serialization, focus preservation, catalog recovery, scope/pending/unavailable and slash-request contracts.');
} finally { await browser.close(); }
