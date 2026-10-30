import { chromium } from 'playwright-core';
import { mkdir } from 'node:fs/promises';
import assert from 'node:assert/strict';
const output = new URL('../../.qa/screenshots/changes-workbench/', import.meta.url).pathname;
await mkdir(output,{recursive:true});
const browser=await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
try {
 const page=await browser.newPage({viewport:{width:1500,height:1000}}); page.setDefaultTimeout(8000);
 const errors=[];page.on('pageerror',error=>errors.push(error.message));
 await page.addInitScript(()=>{
  localStorage.setItem("pi-studio:preferences",JSON.stringify({showCodeView:true}));
  const model={modelRef:'demo/model',label:'Demo',thinkingLevel:'default',thinkingLevels:['default'],effectiveThinkingLevel:'off'};
  const file={path:'/workspace/src/session.ts',label:'src/session.ts',status:'modified',added:4,removed:2,patch:'--- a/src/session.ts\n+++ b/src/session.ts\n@@ -35,4 +35,6 @@\n const session = getSession();\n-if (session.running) return;\n+if (session.running) {\n+  await session.followUp(message);\n+  return;\n+}\n await session.prompt(message);\n // '+ 'Long line '.repeat(18)+'\n@@ -92,1 +94,1 @@\n-const done = false;\n+const done = true;\n'};
  const messages=[{role:'user',timestamp:1,content:[{type:'text',text:'检查会话运行状态并修复'}]},
   {role:'assistant',timestamp:2,content:[{type:'thinking',thinking:'先检查状态来源。'},{type:'text',text:'先检查会话状态来源，确认后台是否仍在执行。'},{type:'toolCall',id:'read',name:'read',arguments:{path:'src/session.ts'}}]},
   {role:'toolResult',timestamp:3,toolCallId:'read',content:[{type:'text',text:'done'}]},
   {role:'assistant',timestamp:4,content:[{type:'thinking',thinking:'把新的消息交给队列处理。'},{type:'text',text:'已经定位到状态不同步，接下来补上排队处理。'},{type:'toolCall',id:'edit',name:'edit',arguments:{path:'src/session.ts'}}]},
   {role:'toolResult',timestamp:5,toolCallId:'edit',content:[{type:'text',text:'done'}]},
   {role:'assistant',timestamp:6,content:[{type:'text',text:'## 已完成\n\n恢复真实运行状态，并修复新消息排队。'}]}];
  const session={id:'demo',cwd:'/workspace',title:'修复会话状态',kind:'conversation',goal:'',pinned:false,archived:false,createdAt:Date.now()-60_000,updatedAt:Date.now(),messages,turnDiffs:[{at:5,files:[{...file,label:'old.ts'}],totalAdded:4,totalRemoved:2},{at:6,files:[file,{...file,path:'/workspace/readme.md',label:'readme.md',patch:'@@ -1,1 +1,2 @@\n-# Old\n+# New\n+Hello\n'},{...file,path:'/workspace/other.ts',label:'other.ts'}],totalAdded:12,totalRemoved:6,snapshot:{root:'/workspace',before:'a',after:'b'}}]};
  const listeners=new Set();
  let revision=0;
  window.emit=({type,payload})=>{revision+=1;for(const fn of listeners)fn({type,payload,conversationId:'demo',revision});};
  const snapshot=()=>({...session,running:false,requestId:'',compacting:false,inbox:[],tools:[],nestedTools:[],usage:{},agent:{cwd:'/workspace',name:'QA Agent'}});
  window.piApi=new Proxy({state:async()=>({workspaces:[{cwd:'/workspace',name:'Pi Studio',sessions:[session]}],model}),
   conversationPage:async()=>({...snapshot(),messages,turnDiffs:session.turnDiffs,page:{hasOlder:false},messageStart:0}),
   conversationOutline:async()=>({id:'demo',items:[{sourceIndex:0,text:'检查会话运行状态并修复',timestamp:1}],totalMessages:messages.length}),
   conversationSnapshot:async()=>snapshot(),subscribeConversation:async()=>snapshot(),unsubscribeConversation:async()=>({ok:true}),sessionSubagents:async()=>[],
   onConversationEvent:fn=>{listeners.add(fn);return()=>listeners.delete(fn);},
   turnDiffFile:async(payload)=>{window.diffRequests=(window.diffRequests||[]).concat(payload);return session.turnDiffs[1].files.find(file=>file.path===payload.path);},fileAbsolute:async path=>({path,text:'sample',size:6,binary:false}),fileActions:async()=>({apps:[{name:'Visual Studio Code',path:'/Applications/Code.app'}]}),openWith:async payload=>{window.openedWith=payload;},
   modeGet:async()=>({available:true,mode:'smart'}),composerResources:async()=>({commands:[],skills:[]}),extensionsUi:async()=>({items:[],errors:[],syncedAt:Date.now(),apiVersion:1})},
   {get:(target,key)=>key in target?target[key]:String(key).startsWith('on')?()=>()=>{}:async()=>undefined});
 });
 await page.goto('http://127.0.0.1:5180');
 await page.locator('.workspace-row').first().click(); await page.locator('.session-row').first().click();
 await page.getByRole('button',{name:'查看变更',exact:true}).click();
 await page.locator('.changes-view').waitFor();
 assert.equal(await page.locator('.changes-file').count(),3);
 assert.equal(await page.locator('.changes-file-toggle[aria-expanded=true]').count(),0);
 await page.getByRole('button',{name:'展开全部差异',exact:true}).click();
 assert.equal(await page.locator('.diff-view.is-embedded').count(),3);
 await page.waitForFunction(()=>Math.abs(document.querySelector('.file-panel').getBoundingClientRect().width-700)<2);
 await page.getByRole('button',{name:'折叠全部差异',exact:true}).click();
 await page.getByRole('button',{name:'跳转到文件',exact:true}).click();
 await page.getByRole('textbox',{name:'搜索本轮文件'}).fill('session');
 await page.locator('.changes-jump button').click();
 assert.equal(await page.locator('.changes-file-toggle[aria-expanded=true]').count(),1);
 await page.getByRole('button',{name:'差异布局',exact:true}).click();
 await page.getByRole('menuitemcheckbox',{name:'左右对照',exact:true}).click();
 await page.getByRole('button',{name:'自动换行',exact:true}).click();
 await page.locator('.diff-paired').waitFor();
 const pairHeights=await page.locator('.diff-pair').evaluateAll(rows=>rows.every(row=>row.children[0].getBoundingClientRect().height===row.children[1].getBoundingClientRect().height));
 assert.ok(pairHeights);
 await page.getByRole('button',{name:'差异选项',exact:true}).click();
 await page.getByRole('menuitemcheckbox',{name:'词级差异',exact:true}).click();
 assert.equal(await page.locator('.diff-code mark').count(),0);
 await page.getByRole('button',{name:'差异选项',exact:true}).click();
 await page.getByRole('menuitemcheckbox',{name:'加载完整文件',exact:true}).click();
 await page.waitForFunction(()=>window.diffRequests?.some(request=>request.full));
 await page.getByRole('button',{name:'差异选项',exact:true}).click();
 await page.getByRole('menuitemcheckbox',{name:'忽略空白字符差异',exact:true}).click();
 await page.waitForFunction(()=>window.diffRequests?.some(request=>request.ignoreWhitespace));
 await page.getByRole('button',{name:'显示变更文件列表',exact:true}).click();
 await page.getByRole('navigation',{name:'变更文件列表'}).getByRole('button',{name:'readme.md',exact:true}).click();
 await page.getByRole('button',{name:'差异选项',exact:true}).click();
 await page.getByRole('menuitemcheckbox',{name:'渲染 Markdown 预览',exact:true}).click();
 await page.locator('.changes-markdown h1').waitFor();
 await page.getByRole('button',{name:'src/session.ts 文件操作',exact:true}).click();
 await page.getByRole('menuitem',{name:'在编辑器中打开',exact:true}).click();
 await page.getByRole('menuitem',{name:'Visual Studio Code',exact:true}).click();
 await page.waitForFunction(()=>window.openedWith?.appPath==='/Applications/Code.app');
 await page.getByRole('button',{name:'刷新变更',exact:true}).click();
 const roundSelect=page.getByLabel('选择变更轮次');
 await roundSelect.click();
 await page.getByRole('option').nth(1).click();
 assert.equal(await page.locator('.changes-file').count(),1);
 await roundSelect.click();
 await page.getByRole('option').nth(0).click();
 await page.getByRole('button',{name:'展开全部差异',exact:true}).click();
 await page.getByRole('button',{name:'显示变更文件列表',exact:true}).click();
 for (const theme of ['light','dark']) {
  await page.evaluate(theme=>document.documentElement.dataset.theme=theme,theme);
  await page.screenshot({path:output+theme+'.png',animations:'disabled'});
 }
 // Each file opens separately only when explicitly requested; context menu operates on clicked tab.
 const review=page.locator('.panel-tab').filter({has:page.locator('.panel-tab-label',{hasText:/^变更$/})});
 for (const name of ['src/session.ts','readme.md','other.ts']) {
  await page.getByRole('button',{name:`在新标签页打开 ${name}`,exact:true}).click();
  await review.click();
 }
 assert.equal(await page.locator('.panel-tab').count(),5);
 const sessionTab=page.locator('.panel-tab').filter({hasText:'session.ts'});
 await sessionTab.click({button:'right'});
 await page.getByRole('menuitem',{name:'关闭右侧标签页',exact:true}).click();
 assert.equal(await page.locator('.panel-tab').count(),3);
 await sessionTab.click({button:'right'});
 await page.getByRole('menuitem',{name:'关闭左侧标签页',exact:true}).click();
 assert.equal(await page.locator('.panel-tab').count(),1);
 await page.locator('.file-change-summary > header button').click();
 await page.getByRole('button',{name:'在新标签页打开 other.ts',exact:true}).click();
 await review.click({button:'right'});
 await page.getByRole('menuitem',{name:'关闭其他标签页',exact:true}).click();
 assert.equal(await page.locator('.panel-tab').count(),1);
 assert.equal(await review.getAttribute('aria-selected'),'true');
 await review.click({button:'right'});
 await page.getByRole('menuitem',{name:'关闭所有标签页',exact:true}).click();
 await page.locator('.file-panel').waitFor({state:'detached'});
 await page.locator('.file-change-summary > header button').click();
 await page.locator('.changes-view').waitFor();
 assert.equal(await page.locator('.panel-tab').count(),1);
 const handle=page.getByRole('separator',{name:'调整右侧面板宽度'});
 await handle.focus(); for(let i=0;i<10;i++) await page.keyboard.press('ArrowRight');
 await page.waitForFunction(()=>document.querySelector('.file-panel').getBoundingClientRect().width<330);
 await page.getByRole('button',{name:'展开全部差异',exact:true}).click();
 await page.locator('.diff-unified').first().waitFor();
 assert.equal(await page.locator('.changes-toolbar').evaluate(node=>node.scrollWidth>node.clientWidth),false);
 await page.getByRole('button',{name:'差异布局',exact:true}).click();
 await page.keyboard.press('Escape'); assert.equal(await page.getByRole('menu').count(),0);
 await page.screenshot({path:output+'narrow.png',animations:'disabled'});
 assert.deepEqual(errors,[]);
 console.log('PASS: round list, expand/collapse, jump, wrap alignment, layouts, full snapshot, options, preview, editor, refresh, history, separate tabs and all bulk close modes.');
} catch(error) { const page=browser.contexts()[0]?.pages()[0]; if(page) { await page.screenshot({path:output+'failure.png'}); console.log(await page.locator('.file-panel, .changes-toolbar, .changes-scroll').evaluateAll(nodes=>nodes.map(node=>({cls:node.className,rect:node.getBoundingClientRect().toJSON()})))); } throw error; } finally {await browser.close();}
