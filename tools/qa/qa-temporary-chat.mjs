import { chromium } from 'playwright-core';
import { mkdir } from 'node:fs/promises';
import assert from 'node:assert/strict';
const output = new URL('../../.qa/screenshots/temporary-chat/', import.meta.url).pathname;
await mkdir(output,{recursive:true});
const browser=await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
const errors=[];
try {
 const page=await browser.newPage({viewport:{width:1500,height:1000},deviceScaleFactor:2}); page.setDefaultTimeout(8000);
 page.on('pageerror',error=>errors.push(error.message));
 await page.addInitScript(()=>{
  localStorage.setItem("pi-studio:preferences",JSON.stringify({showCodeView:true}));
  const qaPng='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jZ1sAAAAASUVORK5CYII=';
  const model={modelRef:'demo/model',label:'Demo',supportsImages:true,thinkingLevel:'default',thinkingLevels:['default'],effectiveThinkingLevel:'off'};
  const alternateModel={modelRef:'demo/alternate',label:'Demo Alternate',supportsImages:true,thinkingLevel:'default',thinkingLevels:['default','high'],effectiveThinkingLevel:'high',defaultThinkingLevel:'high'};
  const textModel={modelRef:'demo/text',label:'Demo Text',supportsImages:false,thinkingLevel:'default',thinkingLevels:['default'],effectiveThinkingLevel:'off'};
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
  const tempListeners=new Set();window.temporaryCalls=[];window.temporaryModelCalls=[];window.temporaryClosed=[];
  window.finishTemporary=(id,text='临时聊天回复')=>{for(const fn of tempListeners)fn({id,type:'message',message:{role:'assistant',timestamp:200,content:[{type:'text',text}]}});window.tempResolve?.({ok:true});};
  window.piApi=new Proxy({
   onTemporary:fn=>{tempListeners.add(fn);return()=>tempListeners.delete(fn);},
   temporaryModel:async value=>{window.temporaryModelCalls.push(value||{});const selected=value?.modelRef==='demo/alternate'?alternateModel:value?.modelRef==='demo/text'?textModel:model;return {...selected,thinkingLevel:value?.thinkingLevel||selected.thinkingLevel};},
   models:async()=>({models:[{id:'demo/model',name:'Demo',provider:'demo',providerName:'Demo',supportsImages:true},{id:'demo/alternate',name:'Demo Alternate',provider:'demo',providerName:'Demo',supportsImages:true},{id:'demo/text',name:'Demo Text',provider:'demo',providerName:'Demo',supportsImages:false}],enabled:['demo/model','demo/alternate','demo/text'],current:'demo/model',selection:model,defaultSelection:model}),
   temporaryPrompt:async payload=>{window.temporaryCalls.push(payload);for(const fn of tempListeners)fn({id:payload.id,type:'message',message:{role:'user',timestamp:Date.now(),content:[{type:'text',text:payload.text},...payload.images.map(image=>({...image,type:'image'}))]}});return new Promise(resolve=>window.tempResolve=resolve);},
   temporaryStop:async()=>{window.tempResolve?.({ok:true});},
   temporaryClose:async id=>{window.temporaryClosed.push(id);window.tempResolve?.({ok:true});},
   pickAttachments:async()=>({attachments:[{id:'composer-image',kind:'image',name:'composer.png',mime:'image/png',bytes:68,data:qaPng}]}),
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
   modeGet:async()=>({available:true,mode:'smart'}),composerResources:async()=>({commands:[],skills:[]}),extensionsUi:async()=>({items:[],errors:[],syncedAt:Date.now(),apiVersion:1}),
   conversationExtensionUiPreferences:async()=>({version:1,layout:'grid',globalOrder:[],sessionOrders:{}}),
   saveConversationExtensionUiPreferences:async value=>({version:1,layout:value?.layout||'grid',globalOrder:value?.globalOrder||[],sessionOrders:{}})},
   {get:(target,key)=>key in target?target[key]:String(key).startsWith('on')?()=>()=>{}:async()=>undefined});
 });
 await page.goto('http://127.0.0.1:5180');
 await page.locator('.workspace-row').first().click();await page.locator('.session-row').first().click();
 await page.getByRole('button',{name:'添加图片或文件',exact:true}).click();
 const composerImage=page.locator('.composer-attachments .composer-image-preview-trigger');
 await composerImage.waitFor();
 await composerImage.click();
 const composerPreview=page.getByRole('dialog',{name:'图片预览'});
 await composerPreview.waitFor();
 assert.equal(await composerPreview.getByRole('navigation',{name:'图片缩略图'}).count(),0,'single image preview omits the thumbnail rail');
 assert.equal(await composerPreview.getByRole('button',{name:/上一张|下一张/}).count(),0,'single image preview omits carousel navigation');
 await page.screenshot({path:output+'composer-image-preview.png',animations:'disabled'});
 await page.keyboard.press('Escape');
 await composerPreview.waitFor({state:'detached'});
 await composerImage.press('Enter');
 await composerPreview.waitFor();
 await page.keyboard.press('Escape');
 await page.getByRole('button',{name:'移除 composer.png',exact:true}).click();
 assert.equal(await composerImage.count(),0,'removing a composer image also closes and dismisses its card');
 assert.equal(await composerPreview.count(),0,'remove control never opens the preview');
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
 await page.locator('.temporary-composer .model-label').click();
 const tempModelPopover=page.locator('.temporary-chat .model-popover');
 await tempModelPopover.waitFor();
 assert.equal(await tempModelPopover.evaluate(node=>{const rect=node.getBoundingClientRect();return document.elementFromPoint(rect.left+rect.width/2,rect.top+8)?.closest('.model-popover')===node;}),true,'temporary model picker must not be clipped by the composer');
 await page.getByRole('menuitem',{name:/切换会话模型/}).click();
 await page.getByRole('menuitemradio',{name:'Demo Alternate',exact:true}).click();
 await page.locator('.temporary-composer .model-label').filter({hasText:'Demo Alternate'}).waitFor();
 const modelCalls=await page.evaluate(()=>window.temporaryModelCalls);
 assert.ok(modelCalls.length>=1);
 assert.equal(modelCalls.at(-1).modelRef,'demo/alternate');
 assert.equal(modelCalls.at(-1).thinkingLevel,undefined);
 assert.equal(modelCalls.filter(call=>!call.modelRef).length,1,'temporary model initialization must be issued once');
 await page.screenshot({path:output+'temporary-model-picker.png',animations:'disabled'});
 await page.locator('.temporary-composer .model-label').click();
 await page.getByRole('menuitem',{name:/切换会话模型/}).click();
 await page.getByRole('menuitemradio',{name:'Demo Text',exact:true}).click();
 await page.locator('.temporary-composer .model-label').filter({hasText:'Demo Text'}).waitFor();
 await page.locator('.temporary-composer input[type=file]').setInputFiles({name:'blocked.png',mimeType:'image/png',buffer:Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jZ1sAAAAASUVORK5CYII=','base64')});
 const capabilityFeedback=page.locator('.temporary-composer-dock .composer-feedback');
 await capabilityFeedback.getByText(/不支持图片输入/).waitFor();
 assert.equal(await page.locator('.temporary-attachments img').count(),0,'text-only models must reject temporary images before rendering');
 await page.screenshot({path:output+'temporary-image-capability-warning.png',animations:'disabled'});
 await page.locator('.temporary-composer .model-label').click();
 await page.getByRole('menuitem',{name:/切换会话模型/}).click();
 await page.getByRole('menuitemradio',{name:'Demo Alternate',exact:true}).click();
 await page.locator('.temporary-composer .model-label').filter({hasText:'Demo Alternate'}).waitFor();
 await page.getByRole('textbox',{name:'临时聊天消息'}).fill('只在内存的消息');
 const png='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jZ1sAAAAASUVORK5CYII=';
 await page.locator('.temporary-composer input[type=file]').setInputFiles({name:'sample.png',mimeType:'image/png',buffer:Buffer.from(png,'base64')});
 await page.locator('.temporary-attachments img').waitFor();
 const temporaryImage=page.locator('.temporary-attachments .composer-image-preview-trigger');
 await temporaryImage.click();
 const temporaryPreview=page.getByRole('dialog',{name:'图片预览'});
 await temporaryPreview.waitFor();
 await page.screenshot({path:output+'temporary-composer-image-preview.png',animations:'disabled'});
 await page.keyboard.press('Escape');
 await temporaryPreview.waitFor({state:'detached'});
 await temporaryImage.press('Space');
 await temporaryPreview.waitFor();
 await page.keyboard.press('Escape');
 await page.getByRole('button',{name:'移除 sample.png',exact:true}).click();
 assert.equal(await page.locator('.temporary-attachments img').count(),0,'temporary image cards keep remove separate from preview');
 assert.equal(await temporaryPreview.count(),0,'temporary remove control never opens the preview');
 await page.locator('.temporary-composer input[type=file]').setInputFiles({name:'sample.png',mimeType:'image/png',buffer:Buffer.from(png,'base64')});
 await page.locator('.temporary-attachments img').waitFor();
 await page.getByRole('button',{name:'发送临时消息',exact:true}).click();
 await page.locator('.temporary-thinking').waitFor();
 const call=await page.evaluate(()=>window.temporaryCalls[0]);assert.equal(call.images[0].data,png);
 assert.equal(call.modelRef,'demo/alternate');assert.equal(call.thinkingLevel,'default');
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
} catch(error) { const page=browser.contexts()[0]?.pages()[0]; if(page) {await page.screenshot({path:output+'failure.png'});console.error('browser diagnostics:',errors);console.error('body:',(await page.locator('body').innerText()).slice(0,1200));} throw error; } finally {await browser.close();}
