import { chromium } from 'playwright-core';
import { mkdir } from 'node:fs/promises';
import assert from 'node:assert/strict';
const output = new URL('../../.qa/screenshots/diff-conversation/', import.meta.url).pathname;
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
  const session={id:'demo',cwd:'/workspace',title:'修复会话状态',kind:'conversation',goal:'',pinned:false,archived:false,createdAt:Date.now()-60_000,updatedAt:Date.now(),messages,turnDiffs:[{at:6,files:[file],added:4,removed:2}]};
  const listeners=new Set();
  let revision=0;
  window.__interruptIds=[];
  window.emit=({type,payload})=>{revision+=1;for(const fn of listeners)fn({type,payload,conversationId:'demo',revision});};
  const snapshot=()=>({...session,running:!!window.running,requestId:window.running?'running-request':'',compacting:false,inbox:[],tools:[],nestedTools:[],usage:{},agent:{cwd:'/workspace',name:'QA Agent'}});
  window.piApi=new Proxy({state:async()=>({workspaces:[{cwd:'/workspace',name:'Pi Studio',sessions:[session]}],model}),
   conversationPage:async()=>({...snapshot(),messages,turnDiffs:session.turnDiffs,page:{hasOlder:false},messageStart:0}),
   conversationOutline:async()=>({id:'demo',items:[{sourceIndex:0,text:'检查会话运行状态并修复',timestamp:1}],totalMessages:messages.length}),
   conversationSnapshot:async()=>snapshot(),subscribeConversation:async()=>snapshot(),unsubscribeConversation:async()=>({ok:true}),sessionSubagents:async()=>[],
   conversationInterrupt:async id=>{window.__interruptIds.push(id);window.running=false;return {ok:true};},
   onConversationEvent:fn=>{listeners.add(fn);return()=>listeners.delete(fn);},
   modeGet:async()=>({available:true,mode:'smart'}),composerResources:async()=>({commands:[],skills:[]}),extensionsUi:async()=>({items:[],errors:[],syncedAt:Date.now(),apiVersion:1}),
   conversationExtensionUiPreferences:async()=>({version:1,layout:'grid',globalOrder:[],sessionOrders:{}}),
   saveConversationExtensionUiPreferences:async payload=>({version:1,layout:payload.layout||'grid',globalOrder:payload.globalOrder||[],sessionOrders:payload.sessionOrder?{demo:payload.sessionOrder}:{}})},
   {get:(target,key)=>key in target?target[key]:String(key).startsWith('on')?()=>()=>{}:async()=>undefined});
 });
 await page.goto('http://127.0.0.1:5180');
 try {
  await page.locator('.workspace-row').first().click();await page.locator('.session-row').first().click();
 } catch (error) {
  console.error('Page errors:', errors);
  await page.screenshot({path:output+'startup-failure.png',fullPage:true,animations:'disabled'});
  throw error;
 }
 for(const text of ['先检查会话状态来源，确认后台是否仍在执行。','已经定位到状态不同步，接下来补上排队处理。']){
  const prose=page.getByText(text,{exact:true});await prose.waitFor();assert.equal(await prose.evaluate(node=>!!node.closest('details')),false);
 }
 assert.equal(await page.getByText('思考过程',{exact:true}).count(),0);
 assert.ok(await page.locator('.run-history').count()>=2);
 const positions=await page.locator('.assistant-turn-main > .assistant-response').evaluateAll(nodes=>nodes.map(node=>node.getBoundingClientRect().y));
 assert.ok(positions.every((n,i)=>!i||n>positions[i-1]));
 await page.screenshot({path:output+'conversation-light.png',fullPage:true,animations:'disabled'});
 await page.locator('.file-change-item').first().click();
 await page.locator('.changes-view').waitFor();
 await page.waitForFunction(()=>Math.abs(document.querySelector('.file-panel').getBoundingClientRect().width-700)<2);
 const panel=page.locator('.file-panel');
 const before=(await panel.boundingBox()).width;
 const handle=page.getByRole('separator',{name:'调整右侧面板宽度'}),h=await handle.boundingBox();
 await page.mouse.move(h.x+3,h.y+200);await page.mouse.down();await page.mouse.move(h.x-240,h.y+200,{steps:12});await page.mouse.up();
 await page.waitForFunction(width=>document.querySelector('.file-panel').getBoundingClientRect().width>width+180,before);
 assert.ok(Number(await page.evaluate(()=>localStorage.getItem('pi-studio:panel-width')))>before+180);
 await handle.focus();const wide=(await panel.boundingBox()).width;await page.keyboard.press('ArrowRight');
 await page.waitForFunction(width=>document.querySelector('.file-panel').getBoundingClientRect().width<width-20,wide);
 const left=await page.locator('.diff-pane').first().evaluate(node=>({width:node.clientWidth,scroll:node.scrollWidth}));assert.ok(left.scroll>left.width);
 assert.ok(await page.locator('.diff-code mark').count()>0);
 const heights=await page.locator('.diff-pane').evaluateAll(nodes=>nodes.map(node=>node.scrollHeight));assert.equal(heights[0],heights[1]);
 for(const theme of ['light','dark']){
  await page.evaluate(theme=>document.documentElement.dataset.theme=theme,theme);
  await page.screenshot({path:output+'diff-'+theme+'.png',animations:'disabled'});
 }
 await page.getByRole('button',{name:'差异布局',exact:true}).click(); await page.getByRole('menuitemcheckbox',{name:'单列差异',exact:true}).click(); await page.locator('.diff-unified').waitFor();
 await page.getByRole('button',{name:'差异布局',exact:true}).click(); await page.getByRole('menuitemcheckbox',{name:'左右对照',exact:true}).click();
 await page.getByRole('button',{name:'收起右侧面板'}).click();
 await page.evaluate(()=>window.running=true);await page.locator('.session-row').first().click();
 await page.locator('.run-live-status').waitFor();
 assert.equal(await page.locator('.assistant-turn-status').getByText('已完成',{exact:true}).count(),0);
 await page.evaluate(()=>window.emit({type:'run.completed',payload:{inputs:[]}}));await page.locator('.run-live-status').waitFor({state:'detached'});
 // 一个 Durable model run 结束并不代表整轮 Studio 对话结束：后台子智能体仍可能运行，
 // 此时不能提前显示「已完成」或本轮文件变更，且停止按钮必须继续可用。
 await page.evaluate(()=>window.emit({type:'run.started',payload:{inputs:['background'],running:true}}));
 await page.locator('.run-live-status').waitFor();
 assert.equal(await page.locator('.file-change-summary').count(),0);
 assert.equal(await page.getByRole('button',{name:'停止当前任务'}).count(),1);
 await page.evaluate(()=>window.emit({type:'run.completed',payload:{inputs:['background'],running:true}}));
 assert.equal(await page.locator('.run-live-status').count(),1);
 assert.equal(await page.locator('.assistant-turn-status').getByText('已完成',{exact:true}).count(),0);
 assert.equal(await page.locator('.file-change-summary').count(),0);
 await page.evaluate(()=>window.emit({type:'run.completed',payload:{inputs:['background'],running:false}}));
 await page.locator('.run-live-status').waitFor({state:'detached'});
 await page.locator('.file-change-summary').waitFor();
 await page.evaluate(()=>window.emit({type:'run.started',payload:{inputs:['stoppable'],running:true}}));
 await page.getByRole('button',{name:'停止当前任务'}).click();
 await page.waitForFunction(()=>window.__interruptIds.length===1&&window.__interruptIds[0]==='demo');
 await page.locator('.run-live-status').waitFor({state:'detached'});
 assert.deepEqual(errors,[]);
 console.log('PASS: chronological visible prose, separate process groups, split/unified diff, syntax/word highlights, drag and keyboard resize, aggregate live-session recovery and stop.');
} finally {await browser.close();}
