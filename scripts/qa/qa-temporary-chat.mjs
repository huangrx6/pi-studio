import { chromium } from 'playwright-core';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import metrics from '../../electron/main/capabilities/metrics/index.cjs';
import { serveProductionRenderer } from './fixtures/production-renderer-server.mjs';

async function checkWelcomePosition(canvas) {
  await canvas.locator('.welcome-art').waitFor();
  const offsets = await canvas.evaluate(async element => {
    await document.fonts.ready;
    const pane = element.getBoundingClientRect();
    const art = element.querySelector('.welcome-art').getBoundingClientRect();
    const title = element.querySelector('h1, h2').getBoundingClientRect();
    const composer = element.querySelector('.composer').getBoundingClientRect();
    const layout = element.querySelector('.temporary-chat.is-empty') ?? element;
    const style = getComputedStyle(layout);
    const height = layout.clientHeight - parseFloat(style.paddingBlockStart) - parseFloat(style.paddingBlockEnd);
    return {
      horizontal: [art, title, composer].map(box => (box.left + box.right - pane.left - pane.right) / 2),
      lift: (pane.top + pane.bottom - art.top - composer.bottom) / 2,
      expectedLift: Math.min(height * .07, 56),
    };
  });
  assert.ok(offsets.horizontal.every(offset => Math.abs(offset) <= 1), 'Welcome content is horizontally centred');
  assert.ok(Math.abs(offsets.lift - offsets.expectedLift) <= 1, 'Responsive welcome position: ' + JSON.stringify(offsets));
}

const root = fileURLToPath(new URL('../..', import.meta.url));
const output = path.join(root, '.qa/screenshots/temporary-chat/');
const server = await serveProductionRenderer(root);
await mkdir(output,{recursive:true});
const browser=await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
const errors=[];const blockedRequests=[];
try {
 const page=await browser.newPage({viewport:{width:1500,height:1000},deviceScaleFactor:2}); page.setDefaultTimeout(8000);
 page.on('pageerror',error=>errors.push(error.stack || error.message));
 await page.route('**/*',route=>{const url=route.request().url();if(url.startsWith(`${server.origin}/`)||/^(data|blob):/.test(url))return route.continue();blockedRequests.push(url);return route.abort();});
 // A renderer reload drops its JS heap. Keep the mocked main-process store
 // outside the page so only successful IPC calls can restore its transcript.
 const records = new Map();
 const layouts = new Map();
 const pendingStatusReads = new Map();
 function holdStatusRead(source) {
   const { promise, resolve } = Promise.withResolvers();
   pendingStatusReads.set(source, promise);
   return () => { pendingStatusReads.delete(source); resolve(); };
 }
 const finishServices = holdStatusRead('services');
 const finishQuota = holdStatusRead('quota');
 await page.exposeBinding('waitForStatusRead', (_, source) => pendingStatusReads.get(source));
 await page.exposeBinding('readQaLayout', (_, owner, surface) => layouts.get(owner + '/' + surface) ?? null);
 await page.exposeBinding('writeQaLayout', (_, owner, surface, value) => {layouts.set(owner + '/' + surface,value);});
 await page.exposeBinding('readTemporaryHistory', () => [...records.values()]
   .sort((left, right) => right.updatedAt - left.updatedAt)
   .map(({messages, ...summary}) => summary));
 await page.exposeBinding('readTemporaryRecord', (_, id) => records.get(id) ?? null);
 await page.exposeBinding('saveTemporaryMessage', (_, {id, message, modelRef, thinkingLevel}) => {
   const record = records.get(id) ?? { id, createdAt: message.timestamp,
     title: message.content[0]?.text || '图片', messages: [] };
   Object.assign(record, {updatedAt: message.timestamp});
   if (modelRef) Object.assign(record, {modelRef, thinkingLevel});
   record.messages.push(message);
   records.set(id, record);
 });
 const [manifest] = metrics.manifests;
 const metricItems = manifest.contributes.panels.map((panel, sourceOrder) => ({
   ...panel, id: `builtin:${manifest.id}/${panel.id}`, contributionId: panel.id,
   scope: 'builtin', extensionId: manifest.id, extensionName: manifest.name,
   slot: panel.slot ?? panel.slots[0], sourceOrder,
 }));
 await page.addInitScript(metricItems=>{
  const quotaPlacement=sessionStorage.getItem('qa:quota-placement') || 'statusbar';
  localStorage.setItem("pi-studio:preferences",JSON.stringify({showCodeView:true,theme:"system",
    extensionPlacements:{'user:pi-quota-status/quota-chip':quotaPlacement}}));
  const qaPng='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jZ1sAAAAASUVORK5CYII=';
  const model={modelRef:'demo/model',label:'Demo',quotaProvider:{id:'demo',name:'Demo'},supportsImages:true,thinkingLevel:'default',thinkingLevels:['default'],effectiveThinkingLevel:'off'};
  const alternateModel={modelRef:'alternate/model',label:'Demo Alternate',quotaProvider:{id:'alternate',name:'Alternate'},supportsImages:true,thinkingLevel:'default',thinkingLevels:['default','high'],effectiveThinkingLevel:'high',defaultThinkingLevel:'high'};
  const textModel={modelRef:'plain/text',label:'Demo Text',supportsImages:false,thinkingLevel:'default',thinkingLevels:['default'],effectiveThinkingLevel:'off'};
  const mainModel=sessionStorage.getItem('qa:main-without-quota') ? textModel : model;
  const quotaExtension = { extensionId:'user:pi-quota-status', extensionName:'额度状态', scope:'user', title:'额度状态', icon:'gauge', content:[] };
  const quotaItems = [
    { ...quotaExtension, id:'user:pi-quota-status/quota-chip', contributionId:'quota-chip', slot:'status.chip', details:'quota-detail' },
    { ...quotaExtension, id:'user:pi-quota-status/quota-detail', contributionId:'quota-detail', slot:'status.detail' },
  ];
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
  const conversationSnapshot=()=>({...session,model:mainModel,running:!!window.running,requestId:window.running?'running-request':'',compacting:false,inbox:[],tools:[],nestedTools:[],usage:{},agent:{cwd:'/workspace',name:'QA Agent'}});
  const tempListeners=new Set();window.temporaryCalls=[];window.temporaryModelCalls=[];window.temporaryClosed=[];window.temporaryModelShouldFail=false;
  const replies = new Map();
  window.finishTemporary = async (id, text = '临时聊天回复') => {
    const message = {role: 'assistant', timestamp: Date.now(), content: [{type: 'text', text}]};
    await window.saveTemporaryMessage({id, message});
    for (const fn of tempListeners) fn({id, type:'message', message});
    replies.get(id)?.({ok:true});
    replies.delete(id);
  };
  window.piApi=new Proxy({
   readLayout:(owner,surface)=>window.readQaLayout(owner,surface),
   writeLayout:(owner,surface,value)=>window.writeQaLayout(owner,surface,value),
   onToolWindowAction:fn=>{window.qaToolAction=fn;return()=>{delete window.qaToolAction;};},
   filePreviewAbsolute:async({path})=>({path,name:'notes.md',kind:'text',mimeType:'text/markdown',text:'# Notes',size:7}),
   onTemporary:fn=>{tempListeners.add(fn);return()=>tempListeners.delete(fn);},
   temporaryModel:async value=>{window.temporaryModelCalls.push(value||{});await window.waitForStatusRead('temporary-model');if(window.temporaryModelShouldFail)throw new Error("临时模型暂时不可用");const selected=value?.modelRef===alternateModel.modelRef?alternateModel:value?.modelRef===textModel.modelRef?textModel:model;return {...selected,thinkingLevel:value?.thinkingLevel||selected.thinkingLevel};},
   models:async()=>({models:[model,alternateModel,textModel].map(item=>({id:item.modelRef,name:item.label,provider:item.modelRef.split('/')[0],providerName:item.quotaProvider?.name||'Plain',supportsImages:item.supportsImages})),enabled:[model.modelRef,alternateModel.modelRef,textModel.modelRef],current:model.modelRef,selection:model,defaultSelection:model}),
   providerQuota:async (id,refresh)=>{
     await window.waitForStatusRead('quota');
     if (id !== 'demo' && id !== 'alternate') throw Error('未配置额度的来源不应被查询');
     if (refresh) window.lastQuotaRefresh=id;
     return {status:'ready',metrics:[
       {label:'5 小时已用',value:id==='demo'?'12%':'37%',summary:true},
       {label:'本周已用',value:id==='demo'?'20%':'46%',summary:true},
     ]};
   },
   runtimeServices:async () => {
     window.serviceScans = (window.serviceScans || 0) + 1;
     await window.waitForStatusRead('services');
     return { supported: true, services: [], summary: { total: 0, related: 0 }, scannedAt: Date.now() };
   },
   gitRepositories:async () => [{ id: '.', name: 'Pi Studio' }],
   gitWorkspaceStatus:async () => {
     await window.waitForStatusRead('git');
     return { available: true, branch: 'main', dirty: { total: 0, staged: 0, unstaged: 0, untracked: 0 },
       worktree: { isWorktree: false }, worktrees: [] };
   },
   openExtensionDataView:async ({ sourceId }) => {
     await window.waitForStatusRead('metrics');
     return { subscriptionId: crypto.randomUUID(), snapshot: { sourceId, revision: 1, updatedAt: Date.now(), content: [] } };
   },
   temporaryHistory: () => window.readTemporaryHistory(),
   temporaryRead: id => window.readTemporaryRecord(id),
   temporaryPrompt: async payload => {
     window.temporaryCalls.push(payload);
     const {id, text, images, modelRef, thinkingLevel} = payload;
     const completion = new Promise(resolve => replies.set(id, resolve));
     const message = {role: 'user', timestamp: Date.now(), content: [{type: 'text', text},
       ...images.map(image => ({type: 'image', data: image.data, mimeType: image.mimeType}))]};
     await window.saveTemporaryMessage({id, message, modelRef, thinkingLevel});
     for (const fn of tempListeners) fn({id, type:'message', message});
     return completion;
   },
   temporaryStop: async id => { replies.get(id)?.({ok:true}); replies.delete(id); },
   temporaryClose: async id => { window.temporaryClosed.push(id); replies.get(id)?.({ok:true}); replies.delete(id); },
   pickAttachments:async()=>({attachments:[{id:'composer-image',kind:'image',name:'composer.png',mime:'image/png',bytes:68,data:qaPng}]}),
   files:async()=>({path:'/workspace',entries:[]}),
   createConversation:async()=>{throw Error('Temporary chat must not create workspace conversation');},
   saveUpload:async()=>{throw Error('Temporary image must not be saved');},
   state:async()=>({cwd:'/workspace',workspaces:[{cwd:'/workspace',name:'Pi Studio',sessions:[session]}],model:mainModel}),
   conversationPage:async()=>({...conversationSnapshot(),messages,turnDiffs:session.turnDiffs,page:{hasOlder:false},messageStart:0}),
   conversationOutline:async()=>({id:'demo',items:messages.flatMap((message,sourceIndex)=>message.role==='user'?[{sourceIndex,text:message.content?.[0]?.text||'',timestamp:message.timestamp}]:[]),totalMessages:messages.length}),
   conversationSnapshot:async()=>conversationSnapshot(),
   subscribeConversation:async()=>conversationSnapshot(),
   unsubscribeConversation:async()=>({ok:true}),
   sessionSubagents:async()=>[],
   onConversationEvent:fn=>{listeners.add(fn);return()=>listeners.delete(fn);},
   modeGet:async()=>({available:true,mode:'smart'}),composerResources:async()=>({commands:[],skills:[]}),extensionsUi:async()=>({items:[...quotaItems,...metricItems],errors:[],syncedAt:Date.now(),apiVersion:1}),
   conversationExtensionUiPreferences:async()=>({version:1,globalOrder:[]}),
   saveConversationExtensionUiPreferences:async value=>({version:1,globalOrder:value?.globalOrder||[]})},
   {get:(target,key)=>key in target?target[key]:String(key).startsWith('on')?()=>()=>{}:async()=>undefined});
 },metricItems);
 await page.goto(server.origin);
 await page.locator('#launch-screen').waitFor({state:'detached'});
 const statusBar=page.getByRole('contentinfo',{name:'状态栏'});
 const statusSpinner=statusBar.getByRole('status',{name:'正在加载状态栏'});
 const quotaChip=statusBar.getByRole('button',{name:'打开 额度状态 详情'});
 const tools=statusBar.getByRole('button',{name:'打开工具面板'});
 async function checkPendingStatus() {
   await statusSpinner.waitFor();
   assert.equal(await statusBar.getByRole('button').count(),0,'all controls wait for the last initial read');
   assert.equal(await statusBar.getByRole('status').count(),1);
 }
 await checkPendingStatus();
 const pendingBar = await statusBar.boundingBox();
 const spinnerBox = await statusSpinner.boundingBox();
 assert.ok(pendingBar.x + pendingBar.width - spinnerBox.x - spinnerBox.width < 24);
 finishServices();
 await statusBar.locator('.runtime-status-trigger[aria-busy="false"]').waitFor({state:'attached'});
 await checkPendingStatus();
 finishQuota();
 await quotaChip.getByText('5 小时已用 12%').waitFor();
 assert.ok(await tools.isVisible());
 assert.equal(await statusSpinner.isVisible(),false);
 assert.equal((await statusBar.boundingBox()).height,pendingBar.height);
 const finishRefresh = holdStatusRead('services');
 const scans = await page.evaluate(() => window.serviceScans);
 await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
 await page.waitForFunction(previous => window.serviceScans > previous, scans);
 assert.ok(await tools.isVisible() && await quotaChip.isVisible(), 'background reads keep both sides visible');
 finishRefresh();
 const draftCanvas=page.locator('main.is-new-conversation');
 await checkWelcomePosition(draftCanvas);
 await page.emulateMedia({colorScheme:'dark'});
 await page.waitForFunction(()=>document.documentElement.dataset.theme==='dark');
 await page.screenshot({path:output+'new-conversation.png',animations:'disabled',scale:'css'});
 await page.emulateMedia({colorScheme:null});
 await page.getByRole('button',{name:'打开右侧面板',exact:true}).click();
 await page.locator('.file-panel.is-open').waitFor();
 await checkWelcomePosition(draftCanvas);
 await page.getByRole('button',{name:'收起右侧面板',exact:true}).click();
 await page.setViewportSize({width:980,height:640});
 await checkWelcomePosition(draftCanvas);
 await page.setViewportSize({width:1500,height:1000});
 const finishGit = holdStatusRead('git');
 const finishMetrics = holdStatusRead('metrics');
 await page.locator('.workspace-row').first().click();await page.locator('.session-row').first().click();
 await statusBar.locator('.extension-data-view[aria-busy="true"]').waitFor({state:'attached'});
 await checkPendingStatus();
 finishGit();
 await statusBar.getByText('main',{exact:true}).waitFor({state:'attached'});
 await checkPendingStatus();
 finishMetrics();
 await statusBar.getByText('等待首次模型请求',{exact:true}).waitFor();
 await quotaChip.getByText('5 小时已用 12%').waitFor();
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
 const mainRail=page.getByRole('navigation',{name:'主导航'});
 const primary=mainRail.getByRole('button',{name:'对话',exact:true});
 const tempEntry=mainRail.getByRole('button',{name:'临时对话',exact:true});
 const canvas=page.getByRole('main',{name:'临时对话',exact:true});
 const temporaryTabs=page.getByRole('tablist',{name:'当前会话标签',exact:true});
 const savedTab=temporaryTabs.getByRole('tab',{name:'带图片的临时提问',exact:true,selected:true});
 const welcomeHeading=canvas.getByRole('heading',{name:'和路过的念头聊一会儿。',exact:true});
 const openPrimary=async()=>{
   await primary.click();
   await page.locator('.session-row').first().click();
 };
 await page.evaluate(()=>{window.temporaryModelShouldFail=true;});
 const finishTemporaryModel = holdStatusRead('temporary-model');
 await tempEntry.click();
 await canvas.getByRole('region',{name:'临时聊天',exact:true}).waitFor();
 await checkPendingStatus();
 finishTemporaryModel();
 assert.equal(await temporaryTabs.count(),0);
 await page.locator('.temporary-composer-dock .composer-feedback').getByText(/临时模型暂时不可用/).waitFor();
 await tools.waitFor();
 assert.equal(await statusSpinner.isVisible(),false,'a failed model read releases the rest of the status bar');
 const temporaryInput=page.getByRole('textbox',{name:'临时聊天消息'});
 await temporaryInput.fill('模型恢复后应保留');
 assert.equal(await page.getByRole('button',{name:'发送临时消息',exact:true}).isDisabled(),true,'missing model must not expose a send action');
 await temporaryInput.evaluate(node=>{
   node.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',isComposing:true,bubbles:true,cancelable:true}));
   node.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',keyCode:229,bubbles:true,cancelable:true}));
 });
 assert.equal(await page.evaluate(()=>window.temporaryCalls.length),0,'IME-owned Enter must not submit');
 await page.evaluate(()=>{window.temporaryModelShouldFail=false;});
 await page.locator('.temporary-composer .model-label').click();
 const tempModelPopover=page.locator('.temporary-chat .model-popover');
 await tempModelPopover.waitFor();
 assert.equal(await tempModelPopover.evaluate(node=>{const rect=node.getBoundingClientRect();return document.elementFromPoint(rect.left+rect.width/2,rect.top+8)?.closest('.model-popover')===node;}),true,'temporary model picker must not be clipped by the composer');
 await page.getByRole('menuitem',{name:/切换会话模型/}).click();
 await page.getByRole('menuitemradio',{name:'Demo Alternate',exact:true}).click();
 await page.locator('.temporary-composer .model-label').filter({hasText:'Demo Alternate'}).waitFor();
 const modelCalls=await page.evaluate(()=>window.temporaryModelCalls);
 assert.ok(modelCalls.length>=1);
 assert.equal(modelCalls.at(-1).modelRef,'alternate/model');
 await quotaChip.getByText('5 小时已用 37%').waitFor();
 await quotaChip.click();
 const quotaDetail=statusBar.getByRole('dialog',{name:'额度状态'});
 await quotaDetail.getByText('37%',{exact:true}).waitFor();
 await page.keyboard.press('Escape');
 await quotaDetail.waitFor({state:'detached'});
 assert.equal(modelCalls.at(-1).thinkingLevel,undefined);
 assert.equal(modelCalls.filter(call=>!call.modelRef).length,1,'temporary model initialization must be issued once');
 await page.screenshot({path:output+'temporary-model-picker.png',animations:'disabled'});
 await page.locator('.temporary-composer .model-label').click();
 await page.getByRole('menuitem',{name:/切换会话模型/}).click();
 await page.getByRole('menuitemradio',{name:'Demo Text',exact:true}).click();
 await page.locator('.temporary-composer .model-label').filter({hasText:'Demo Text'}).waitFor();
 await quotaChip.waitFor({state:'detached'});
 await page.locator('.temporary-composer input[type=file]').setInputFiles({name:'blocked.png',mimeType:'image/png',buffer:Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jZ1sAAAAASUVORK5CYII=','base64')});
 const capabilityFeedback=page.locator('.temporary-composer-dock .composer-feedback');
 await capabilityFeedback.getByText(/不支持图片输入/).waitFor();
 assert.equal(await page.locator('.temporary-attachments img').count(),0,'text-only models must reject temporary images before rendering');
 await page.screenshot({path:output+'temporary-image-capability-warning.png',animations:'disabled'});
 await page.locator('.temporary-composer .model-label').click();
 await page.getByRole('menuitem',{name:/切换会话模型/}).click();
 await page.getByRole('menuitemradio',{name:'Demo Alternate',exact:true}).click();
 await page.locator('.temporary-composer .model-label').filter({hasText:'Demo Alternate'}).waitFor();
 await temporaryInput.fill('带图片的临时提问');
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
 assert.equal(await temporaryTabs.count(),0,'text and image drafts do not open a conversation tab');
 await page.evaluate(async()=>{
   const {temporaryId}=await window.readQaLayout('studio','navigation');
   window.qaToolAction({kind:'file',ownerKey:'temporary:'+temporaryId,path:'/workspace/notes.md'});
 });
 await temporaryTabs.getByRole('tab',{name:'notes.md',selected:true}).waitFor();
 await page.getByRole('button',{name:'新建临时对话',exact:true}).click();
 await temporaryInput.waitFor();
 assert.equal(await temporaryInput.inputValue(),'带图片的临时提问');
 assert.deepEqual(await temporaryTabs.getByRole('tab').allTextContents(),['notes.md']);
 await page.getByRole('button',{name:'发送临时消息',exact:true}).click();
 const liveStatus=page.locator('.temporary-messages .narrative-live-status');
 await liveStatus.getByText('Pi 正在处理', {exact:true}).waitFor();
 await savedTab.waitFor();
 assert.deepEqual(await temporaryTabs.getByRole('tab').allTextContents(),['带图片的临时提问','notes.md']);
 assert.match(await liveStatus.locator('.narrative-live-duration').innerText(), /^用时 \d+秒$/);
 const call=await page.evaluate(()=>window.temporaryCalls[0]);assert.equal(call.images[0].data,png);
 assert.equal(call.modelRef,'alternate/model');assert.equal(call.thinkingLevel,'default');
 await openPrimary();
 await quotaChip.getByText('5 小时已用 12%').waitFor();
 await page.evaluate(id=>window.finishTemporary(id),call.id);
 await tempEntry.click();
 await page.locator('.assistant-turn').getByText('临时聊天回复',{exact:true}).waitFor();
 await liveStatus.waitFor({state:'detached'});
 await temporaryInput.fill('再聊一句');
 await page.getByRole('button',{name:'发送临时消息',exact:true}).click();
 await page.getByRole('button',{name:'停止临时回复',exact:true}).click();
 await page.getByRole('button',{name:'发送临时消息',exact:true}).waitFor();
 await liveStatus.waitFor({state:'detached'});
 // Unsent image and text attachments remain in the renderer draft.
 await temporaryInput.evaluate((node,png)=>{const bytes=Uint8Array.from(atob(png),char=>char.charCodeAt(0));const data=new DataTransfer();data.setData('text/plain','混合粘贴保留文字');data.items.add(new File([bytes],'pasted.png',{type:'image/png'}));node.dispatchEvent(new ClipboardEvent('paste',{bubbles:true,cancelable:true,clipboardData:data}));},png);
 await page.getByRole('button',{name:'移除 pasted.png',exact:true}).waitFor();
 assert.match(await temporaryInput.inputValue(),/混合粘贴保留文字/);
 await page.getByRole('region',{name:'临时聊天',exact:true}).evaluate((node,png)=>{const bytes=Uint8Array.from(atob(png),char=>char.charCodeAt(0));const data=new DataTransfer();data.items.add(new File([bytes],'dropped.png',{type:'image/png'}));node.dispatchEvent(new DragEvent('drop',{bubbles:true,dataTransfer:data}));},png);
 await page.getByRole('button',{name:'移除 dropped.png',exact:true}).waitFor();
 await page.getByRole('button',{name:'移除 dropped.png',exact:true}).hover();
 for (const theme of ['light','dark']) {await page.evaluate(theme=>document.documentElement.dataset.theme=theme,theme);await page.screenshot({path:output+'chat-'+theme+'.png',animations:'disabled'});}
 const stored=await page.evaluate(()=>JSON.stringify(localStorage));assert.ok(!stored.includes('带图片的临时提问'));assert.ok(!stored.includes(png));
 await openPrimary();
 await tempEntry.click();
 await canvas.getByText('临时聊天回复',{exact:true}).waitFor();
 assert.match(await temporaryInput.inputValue(),/混合粘贴保留文字/);
 await page.getByRole('button',{name:'移除 dropped.png',exact:true}).waitFor();
 await page.emulateMedia({colorScheme:'dark'});
 await page.waitForFunction(async id=>{
   const navigation=await window.readQaLayout('studio','navigation');
   return navigation?.section==='temporary' && navigation.temporaryId===id;
 }, call.id);
 await page.reload();
 await canvas.getByText('临时聊天回复',{exact:true}).waitFor();
 await savedTab.waitFor();
 await canvas.locator('.model-label').getByText('Demo Alternate').waitFor();
 await quotaChip.getByText('5 小时已用 37%').waitFor();
 await page.getByRole('button',{name:'新建临时对话',exact:true}).click();
 await welcomeHeading.waitFor();
 assert.equal(await temporaryTabs.count(),0,'a new draft does not inherit the previous tab');
 assert.equal((await canvas.locator('.temporary-welcome').innerText()).trim(),await welcomeHeading.innerText());
 await checkWelcomePosition(canvas);
 await page.setViewportSize({width:980,height:640});
 await checkWelcomePosition(canvas);
 await page.setViewportSize({width:1500,height:1000});
 await quotaChip.getByText('5 小时已用 12%').waitFor();
 assert.equal(await canvas.locator('.assistant-turn').count(),0);
 await page.screenshot({path:output+'new-temporary-chat.png',animations:'disabled',scale:'css'});
 const historyRow = page.getByRole('button',{name:'带图片的临时提问',exact:true});
 await historyRow.click();
 await canvas.getByText('临时聊天回复',{exact:true}).waitFor();
 await savedTab.waitFor();
 await canvas.locator('.model-label').filter({hasText:'Demo Alternate'}).waitFor();
 await quotaChip.getByText('5 小时已用 37%').waitFor();
 await quotaChip.click();
 await quotaDetail.getByText('37%',{exact:true}).waitFor();
 await quotaDetail.getByRole('button',{name:'刷新额度'}).click();
 assert.equal(await page.evaluate(()=>window.lastQuotaRefresh),'alternate');
 await page.keyboard.press('Escape');
 await canvas.getByText('再聊一句',{exact:true}).waitFor();
 assert.equal(records.get(call.id).messages[0].content[1].data, png);
 await canvas.getByRole('textbox',{name:'临时聊天消息'}).fill('重启后继续');
 await canvas.getByRole('button',{name:'发送临时消息',exact:true}).click();
 await page.waitForFunction(() => window.temporaryCalls.length === 1);
 assert.equal((await page.evaluate(() => window.temporaryCalls[0])).id, call.id);
 await page.evaluate(id=>window.finishTemporary(id, '继续回复'),call.id);
 await canvas.getByText('继续回复',{exact:true}).waitFor();
 assert.equal(records.size, 1);
 await page.getByRole('button',{name:'新建临时对话',exact:true}).click();
 await welcomeHeading.waitFor();
 await quotaChip.getByText('5 小时已用 12%').waitFor();
 await canvas.locator('.model-label').click();
 await page.getByRole('menuitem',{name:/切换会话模型/}).click();
 await page.getByRole('menuitemradio',{name:'Demo Text',exact:true}).click();
 await canvas.locator('.model-label').getByText('Demo Text').waitFor();
 await quotaChip.waitFor({state:'detached'});
 assert.equal(await canvas.locator('.assistant-turn').count(),0);
 await historyRow.click();
 await canvas.getByText('继续回复',{exact:true}).waitFor();
 await quotaChip.getByText('5 小时已用 37%').waitFor();
 await page.screenshot({path:output+'restored-temporary-chat.png',animations:'disabled'});
 await page.getByRole('button',{name:'对话',exact:true}).click();
 await quotaChip.getByText('5 小时已用 12%').waitFor();
 assert.equal(await historyRow.count(),0);
 await page.evaluate(()=>sessionStorage.setItem('qa:main-without-quota','1'));
 for (const placement of ['statusbar','hidden']) {
   await openPrimary();
   await page.waitForFunction(async()=> (await window.readQaLayout('studio','navigation'))?.section==='conversations');
   await page.evaluate(value=>sessionStorage.setItem('qa:quota-placement',value),placement);
   await page.reload();
   await page.locator('.model-label').getByText('Demo Text').waitFor();
   assert.equal(await quotaChip.count(),0);
   await tempEntry.click();
   await historyRow.click();
   await canvas.locator('.model-label').getByText('Demo Alternate').waitFor();
   if (placement==='statusbar') await quotaChip.getByText('5 小时已用 37%').waitFor();
   else assert.equal(await quotaChip.count(),0);
 }
 assert.deepEqual(errors,[]); assert.deepEqual(blockedRequests,[]); assert.equal(await page.getByText('暂时无法完成操作',{exact:true}).count(),0);
 console.log('PASS: atomic status bar loading, background refresh, temporary drafts, first-message tabs, file switching, history, model selection, streaming, reload, and provider-specific quota.');
} catch(error) { const page=browser.contexts()[0]?.pages()[0]; if(page) {await page.screenshot({path:output+'failure.png'});console.error('browser diagnostics:',errors);console.error('body:',(await page.locator('body').innerText()).slice(0,1200));} throw error; } finally {await browser.close();await server.close();}
