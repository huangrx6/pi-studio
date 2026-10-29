import { chromium } from 'playwright-core';
import { mkdir } from 'node:fs/promises';
import assert from 'node:assert/strict';
const output = new URL('../../.qa/screenshots/temporary-chat/', import.meta.url).pathname;
await mkdir(output,{recursive:true});
const browser=await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
try {
 const page=await browser.newPage({viewport:{width:1500,height:1000},deviceScaleFactor:2}); page.setDefaultTimeout(8000);
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
  window.emit=({type,payload})=>{revision+=1;for(const fn of listeners)fn({type,payload,conversationId:'demo',revision});};
  const conversationSnapshot=()=>({...session,running:!!window.running,requestId:window.running?'running-request':'',compacting:false,inbox:[],tools:[],nestedTools:[],usage:{},agent:{cwd:'/workspace',name:'QA Agent'}});
  const tempListeners=new Set();window.temporaryCalls=[];window.temporaryClosed=[];
  window.finishTemporary=(id,text='临时聊天回复')=>{for(const fn of tempListeners)fn({id,type:'message',message:{role:'assistant',timestamp:200,content:[{type:'text',text}]}});window.tempResolve?.({ok:true});};
  window.piApi=new Proxy({
   onTemporary:fn=>{tempListeners.add(fn);return()=>tempListeners.delete(fn);},
   temporaryModel:async value=>({...model,modelRef:value?.modelRef||model.modelRef,thinkingLevel:value?.thinkingLevel||'default'}),
   models:async()=>({models:[{id:'demo/model',name:'Demo',provider:'demo',providerName:'Demo',supportsImages:true}],enabled:[],current:'demo/model',selection:model,defaultSelection:model}),
   temporaryPrompt:async payload=>{window.temporaryCalls.push(payload);for(const fn of tempListeners)fn({id:payload.id,type:'message',message:{role:'user',timestamp:Date.now(),content:[{type:'text',text:payload.text},...payload.images.map(image=>({...image,type:'image'}))]}});return new Promise(resolve=>window.tempResolve=resolve);},
   temporaryStop:async()=>{window.tempResolve?.({ok:true});},
   temporaryClose:async id=>{window.temporaryClosed.push(id);window.tempResolve?.({ok:true});},
   files:async()=>({path:'/workspace',entries:[]}),
   createConversation:async()=>{throw Error('Temporary chat must not create workspace conversation');},
   saveUpload:async()=>{throw Error('Temporary image must not be saved');},
   state:async()=>({workspaces:[{cwd:'/workspace',name:'Pi Studio',sessions:[session]}],model}),
   conversationPage:async()=>({...conversationSnapshot(),messages,turnDiffs:session.turnDiffs,page:{hasOlder:false},messageStart:0}),
   conversationOutline:async()=>({id:'demo',items:messages.flatMap((message,sourceIndex)=>message.role==='user'?[{sourceIndex,text:message.content?.[0]?.text||'',timestamp:message.timestamp}]:[]),totalMessages:messages.length}),
   conversationSnapshot:async()=>conversationSnapshot(),
   subscribeConversation:async()=>conversationSnapshot(),
   unsubscribeConversation:async()=>({ok:true}),
   sessionSubagents:async()=>[],
   onConversationEvent:fn=>{listeners.add(fn);return()=>listeners.delete(fn);},
   modeGet:async()=>({available:true,mode:'smart'}),composerResources:async()=>({commands:[],skills:[]}),extensionsUi:async()=>({items:[],errors:[],syncedAt:Date.now(),apiVersion:1})},
   {get:(target,key)=>key in target?target[key]:String(key).startsWith('on')?()=>()=>{}:async()=>undefined});
 });
 await page.goto('http://127.0.0.1:5180');
 await page.locator('.workspace-row').first().click();await page.locator('.session-row').first().click();
 await page.locator('.file-change-item').first().click();
 await page.waitForFunction(()=>Math.abs(document.querySelector('.file-panel').getBoundingClientRect().width-700)<2);
 const heights=await page.locator('.sidebar-drag,.chat-header,.panel-tabbar').evaluateAll(nodes=>nodes.map(node=>node.getBoundingClientRect().height));
 assert.equal(new Set(heights).size,1);
 const bottoms=await page.locator('.brand,.chat-tabs,.changes-toolbar').evaluateAll(nodes=>nodes.map(node=>node.getBoundingClientRect().bottom));
 assert.ok(Math.max(...bottoms)-Math.min(...bottoms)<=1);
 assert.equal(await page.getByText('准备就绪',{exact:true}).count(),0);
 await page.screenshot({path:output+'aligned-headers.png',animations:'disabled'});
 await page.getByRole('button',{name:'新标签页',exact:true}).click();
 await page.locator('.panel-tool').filter({hasText:'临时聊天'}).click();
 await page.getByRole('region',{name:'临时聊天',exact:true}).waitFor();
 const tempTab=page.getByRole('tab').filter({hasText:'临时聊天'});
 await page.getByRole('textbox',{name:'临时聊天消息'}).fill('只在内存的消息');
 const png='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jZ1sAAAAASUVORK5CYII=';
 await page.locator('.temporary-composer input[type=file]').setInputFiles({name:'sample.png',mimeType:'image/png',buffer:Buffer.from(png,'base64')});
 await page.locator('.temporary-attachments img').waitFor();
 await page.getByRole('button',{name:'发送临时消息',exact:true}).click();
 await page.locator('.temporary-thinking').waitFor();
 const call=await page.evaluate(()=>window.temporaryCalls[0]);assert.equal(call.images[0].data,png);
 await page.getByRole('tab').filter({has:page.locator('.panel-tab-label',{hasText:/^变更$/})}).click();
 await page.evaluate(id=>window.finishTemporary(id),call.id);
 await tempTab.click();
 await page.locator('.assistant-turn').getByText('临时聊天回复',{exact:true}).waitFor();
 await page.getByRole('textbox',{name:'临时聊天消息'}).fill('再聊一句');
 await page.getByRole('button',{name:'发送临时消息',exact:true}).click();
 await page.getByRole('button',{name:'停止临时回复',exact:true}).click();
 await page.getByRole('button',{name:'发送临时消息',exact:true}).waitFor();
 // Paste and drop stay in memory too.
 await page.getByRole('textbox',{name:'临时聊天消息'}).evaluate((node,png)=>{const bytes=Uint8Array.from(atob(png),char=>char.charCodeAt(0));const data=new DataTransfer();data.items.add(new File([bytes],'pasted.png',{type:'image/png'}));node.dispatchEvent(new ClipboardEvent('paste',{bubbles:true,clipboardData:data}));},png);
 await page.getByRole('button',{name:'移除 pasted.png',exact:true}).waitFor();
 await page.getByRole('region',{name:'临时聊天',exact:true}).evaluate((node,png)=>{const bytes=Uint8Array.from(atob(png),char=>char.charCodeAt(0));const data=new DataTransfer();data.items.add(new File([bytes],'dropped.png',{type:'image/png'}));node.dispatchEvent(new DragEvent('drop',{bubbles:true,dataTransfer:data}));},png);
 await page.getByRole('button',{name:'移除 dropped.png',exact:true}).waitFor();
 await page.getByRole('button',{name:'移除 dropped.png',exact:true}).hover();
 for (const theme of ['light','dark']) {await page.evaluate(theme=>document.documentElement.dataset.theme=theme,theme);await page.screenshot({path:output+'chat-'+theme+'.png',animations:'disabled'});}
 const stored=await page.evaluate(()=>JSON.stringify(localStorage));assert.ok(!stored.includes('只在内存的消息'));assert.ok(!stored.includes(png));
 await page.getByRole('button',{name:'收起右侧面板',exact:true}).click();await page.locator('.file-panel').waitFor({state:'detached'});
 await page.getByRole('button',{name:'打开右侧面板',exact:true}).click();
 await page.getByRole('region',{name:'临时聊天',exact:true}).locator('.assistant-turn').waitFor();
 await tempTab.click({button:'right'});await page.getByRole('menuitem',{name:'关闭标签页',exact:true}).click();
 assert.ok((await page.evaluate(()=>window.temporaryClosed)).includes(call.id));
 await page.reload();await page.getByRole('button',{name:'临时聊天',exact:true}).click();
 await page.getByRole('heading',{name:'聊点什么？'}).waitFor();
 assert.equal(await page.getByRole('region',{name:'临时聊天',exact:true}).locator('.assistant-turn').count(),0);
 assert.deepEqual(errors,[]); assert.equal(await page.getByText('暂时无法完成操作',{exact:true}).count(),0);
 console.log('PASS: unified headers; temporary chat without workspace; memory images (upload/paste/drop), stream, stop, tab switch/hide, close/reload cleanup, no localStorage history.');
} catch(error) { const page=browser.contexts()[0]?.pages()[0]; if(page) await page.screenshot({path:output+'failure.png'}); throw error; } finally {await browser.close();}
