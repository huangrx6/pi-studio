/** Isolated component interactions; synthetic file APIs, no user files or model requests. */
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'vite';
import { chromium } from 'playwright-core';
const output = new URL('../../.qa/message-disclosures/', import.meta.url).pathname;
await mkdir(output, { recursive: true });
const server = await createServer({ server: { host: '127.0.0.1', port: 5191, strictPort: false }, logLevel: 'error' });
await server.listen();
const origin = server.resolvedUrls.local[0];
const browser = await chromium.launch({ executablePath: process.env.CHROME_BIN || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
const errors = [];
try {
  const page = await browser.newPage({ viewport: { width: 1120, height: 850 }, reducedMotion: 'reduce' });
  page.setDefaultTimeout(12000);
  page.on('pageerror', error => { errors.push(error.message); console.error(error.message); });
  await page.route('**/disclosure-check', route => route.fulfill({ contentType: 'text/html', body: `<!doctype html><html><head><meta charset="UTF-8"></head><body><div id="root"></div><script type="module">
    import RefreshRuntime from '/@react-refresh';
    RefreshRuntime.injectIntoGlobalHook(window);
    window.$RefreshReg$ = () => {}; window.$RefreshSig$ = () => type => type; window.__vite_plugin_react_preamble_installed__ = true;
    const React = (await import('/@fs/${process.cwd()}/node_modules/.vite/deps/react.js')).default;
    const { createRoot } = (await import('/@fs/${process.cwd()}/node_modules/.vite/deps/react-dom_client.js')).default;
    await import('/src/styles/tokens.css'); await import('/src/styles/palette.css'); await import('/src/styles/app.css');
    const { ChatMessageView } = await import('/src/features/conversation/ChatMessage.tsx');
    const { TraceDetail } = await import('/src/features/conversation/TraceDetail.tsx');
    const { TodoHistory } = await import('/src/features/conversation/TodoHistory.tsx');
    const { useAppWorkbenchController } = await import('/src/shell/right-panel/useAppWorkbench.ts');
    window.calls = []; window.failMenu = false;
    window.piApi = new Proxy({
      turnDiffAbsoluteFile: async () => { throw Error('文件不在当前会话的变更记录中'); },
      filePreview: async (cwd, path) => { if (path.includes('outside')) throw Error('not found'); return { path, name: 'README.md', size: 20, kind: 'text', mimeType: 'text/markdown', text: '预览始终保留' }; },
      filePreviewAbsolute: async ({path}) => ({ path, name: 'outside.md', size: 20, kind: 'text', mimeType: 'text/markdown', text: '预览始终保留' }),
      fileActions: async input => { window.calls.push(input); if (window.failMenu) throw Error('暂时无法读取应用列表'); if (input.source === 'diff') throw Error('文件不在当前会话的变更记录中'); return { apps: [{name:'Editor',path:'/mock/editor'}] }; },
      conversationTodoHistory: async () => ({items:[{planId:'p1',title:'文档品牌统一：README 与 docs 标题和正文更新，保持清晰易读，检查所有项目文件',scope:'session',tasks:[{id:'1',subject:'核对文档',status:'completed'}]}]}),
    }, { get: (target,key) => key in target ? target[key] : String(key).startsWith('on') ? () => () => {} : async () => ({}) });
    const h = React.createElement;
    const long = Array.from({length:18}, (_,i) => '阶段 '+(i+1)+'：整理文档和项目资源，检查界面在不同宽度下的阅读体验。').join('\\n');
    const request = {requestId:'r1',conversationId:'qa',stats:{messageCount:4,estimatedChars:10000,toolDefinitionCount:0},messages:['system','system','toolResult','assistant'].map((role,index)=>({role,index,content:[{type:'text',text: ('这里是完整内容，支持按需展开。 /very-long-path/'+ 'abc'.repeat(100)+'\\n').repeat(8)}],truncated:index===2}))};
    function Files(){const workspaceRef=React.useRef('/qa/workspace');const sessionRef=React.useRef({id:'qa',cwd:'/qa/workspace'});const c=useAppWorkbenchController({workspace:workspaceRef.current,workspaceRef,sessionId:'qa',sessionRef,sidebarCollapsed:false,setError:()=>{}}); window.controller=c;
      return h('section',{className:'qa-files'},h('button',{onClick:()=>c.openFile('/qa/workspace/README.md','qa','diff')},'打开文件'),h('button',{onClick:()=>c.openFile('/qa/outside.md','qa','diff')},'打开外部文件'),h('p',null,c.file?.text),h('button',{onClick:()=>c.showFileActions()},'文件操作'),h('p',{className:'qa-file-error'},c.fileError),h('p',{className:'qa-menu-error'},c.fileAppsError),h('span',{className:'qa-apps'},c.fileApps.map(a=>a.name).join(',')));}
    createRoot(document.getElementById('root')).render(h('main',{className:'qa-layout'},h('div',null,h('h2',null,'用户消息'),h(ChatMessageView,{message:{role:'user',content:[{type:'text',text:long}],timestamp:1000}}),h(ChatMessageView,{message:{role:'user',content:[{type:'text',text:'简短消息无需折叠。'}]}}),h('h2',null,'历史清单'),h(TodoHistory,{sessionId:'qa'}),h(Files)),h(TraceDetail,{item:{id:'r',kind:'model',status:'done',label:'模型调用',request},index:0,count:1,initialFocus:0,onMove:()=>{},onClose:()=>{}})));
  </script><style>body{margin:0;background:var(--bg);color:var(--text);font-family:var(--font)}.qa-layout{padding:28px;display:grid;grid-template-columns:minmax(0,1fr) 360px;gap:32px}.qa-layout>div{min-width:0}.qa-layout .conversation-trace-detail{width:100%;height:740px;border:1px solid var(--border);border-radius:12px}.qa-layout .user-bubble{max-width:100%}.qa-files{margin-top:24px;padding:16px;border:1px solid var(--border);border-radius:8px}.qa-files button{padding:8px}.qa-layout h2{font-size:16px;margin:16px 0}.qa-layout .todo-history{max-width:340px}@media(max-width:700px){.qa-layout{grid-template-columns:minmax(0,1fr);padding:16px}}</style></body></html>` }));
  await page.goto(origin + 'disclosure-check');
  console.log('Fixture loaded');
  const toggle = page.getByRole('button', { name: '展开更多', exact: true });
  await toggle.waitFor();
  assert.equal(await toggle.count(), 1);
  const viewport = page.locator('.user-text-viewport').first();
  const measure = () => viewport.evaluate(node => ({ height: node.clientHeight, line: parseFloat(getComputedStyle(node).lineHeight), full: node.firstChild.clientHeight }));
  let size = await measure(); assert.ok(size.height <= size.line * 5 + 1 && size.full > size.height);
  await toggle.click(); size = await measure(); assert.ok(size.height > size.line * 5);
  await page.getByRole('button', { name: '收起', exact: true }).click(); size = await measure(); assert.ok(size.height <= size.line * 5 + 1);
  await page.getByRole('tab', { name: '系统提示词', exact: true }).click();
  assert.equal(await page.locator('.request-message').count(), 2);
  await page.locator('.request-message summary').first().focus(); await page.keyboard.press('Enter');
  await page.locator('.request-message-body').waitFor();
  assert.ok(await page.locator('.request-message-body pre').first().evaluate(n => n.scrollWidth <= n.clientWidth + 1));
  assert.equal(await page.locator('.request-message summary').first().evaluate(n => getComputedStyle(n).listStyleType), 'none');
  await page.locator('.request-message summary').first().click();
  const title = page.locator('.todo-history strong');
  assert.equal(await title.evaluate(n => getComputedStyle(n).whiteSpace), 'nowrap');
  assert.ok(await title.evaluate(n => n.scrollWidth > n.clientWidth));
  await page.getByRole('button', {name:'打开文件',exact:true}).click();
  await page.getByText('预览始终保留', {exact:true}).waitFor();
  await page.getByRole('button', {name:'文件操作',exact:true}).click();
  await page.locator('.qa-apps').filter({hasText:'Editor'}).waitFor();
  assert.deepEqual(await page.evaluate(()=>window.calls.at(-1)), {cwd:'/qa/workspace',path:'README.md',source:'workspace',sessionId:'qa'});
  await page.getByRole('button', {name:'文件操作',exact:true}).click();
  await page.evaluate(()=>{window.failMenu=true;});
  await page.getByRole('button', {name:'文件操作',exact:true}).click();
  await page.locator('.qa-menu-error').filter({hasText:'暂时无法读取应用列表'}).waitFor();
  assert.equal(await page.locator('.qa-file-error').textContent(), '');
  await page.getByText('预览始终保留', {exact:true}).waitFor();
  await page.evaluate(()=>{window.failMenu=false;});
  await page.getByRole('button', {name:'打开外部文件',exact:true}).click();
  await page.waitForFunction(()=>window.controller.file?.actionSource==='external');
  await page.getByRole('button', {name:'文件操作',exact:true}).click();
  await page.locator('.qa-apps').filter({hasText:'Editor'}).waitFor();
  assert.equal(await page.evaluate(()=>window.calls.at(-1).source), 'external');
  for (const theme of ['light','dark']) {
    await page.evaluate(theme=>document.documentElement.dataset.theme=theme,theme);
    await page.screenshot({path:output+theme+'.png'});
  }
  await page.getByRole('tab',{name:'上下文',exact:true}).click();
  await page.locator('.request-message summary').first().click();
  await page.setViewportSize({width:560,height:1000});
  await page.screenshot({path:output+'narrow.png'});
  assert.ok(await page.locator('.trace-detail-content').evaluate(n=>n.scrollWidth<=n.clientWidth+1));
  size = await measure(); assert.ok(size.height <= size.line * 5 + 1);
  assert.deepEqual(errors, []);
  await writeFile(output+'result.json',JSON.stringify({checks:['five lines, expand/collapse, short message, responsive sizing','keyboard trace disclosure, wrapped full content, no duplicate marker or horizontal overflow','single-line history title','workspace/external preview fallback retains action source; menu failure preserves preview'],errors},null,2));
  console.log('Message disclosure and file fallback QA passed');
} finally { await browser.close(); await server.close(); }
