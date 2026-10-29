const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
function fixture() {
  const created = [], prompts = [], loaders = []; let finish;
  const model = { provider:'demo',id:'vision',input:['text','image'] };
  const pi = {
    SettingsManager:{inMemory:settings=>({memory:true,settings})}, SessionManager:{inMemory:cwd=>({cwd,memory:true})},
    DefaultResourceLoader:class { constructor(options) { loaders.push(options); } async reload() {} },
    async createAgentSession(options) {
      const session = {messages:[],disposed:false,options,listener:null,
        subscribe(fn) { this.listener=fn;return()=>{this.listener=null;}; },
        async setModel() {}, setThinkingLevel() {},
        async prompt(text, args) { prompts.push({text,args}); this.listener({type:'message_start',message:{role:'user',timestamp:1,content:[]}}); await new Promise(resolve=>finish=resolve); },
        async abort(){finish?.();}, dispose(){this.disposed=true;},
      }; created.push(session);return {session};
    },
  };
  const module = { exports:{} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../electron/services/temporary-chat.cjs'),'utf8'), {
    module, exports:module.exports, setTimeout,clearTimeout,process,
    require:name=>name==='../core/state.cjs'?{piModule:()=>pi,getRuntime:async()=>({getModel:()=>model}),getModelRef:()=> 'demo/vision',agentDir:()=>'/unused-agent'}:
      name==='./models.cjs'?{modelInfoFor:()=>({modelRef:'demo/vision',thinkingLevels:['default','off','high'],thinkingLevel:'default',defaultThinkingLevel:'off'})}:
      name==='../core/serialize.cjs'?{serializeMessage:value=>value}:require(name),
  });
  return {...module.exports,created,prompts,loaders,model,finish:()=>finish?.()};
}
const payload={id:'temporary-1',text:'hello',images:[{data:'aGVsbG8=',mimeType:'image/png'}]};
const tick=()=>new Promise(resolve=>setImmediate(resolve));
test('temporary chats reuse isolated memory session, accept images, stop and dispose on close',async()=>{
 const api=fixture(),events=[];
 const run=api.temporaryPrompt(1,payload,event=>events.push(event)); await tick();
 assert.equal(api.created.length,1);
 const options=api.created[0].options;
 assert.equal(options.sessionManager.memory,true);assert.equal(options.settingsManager.memory,true);
 assert.equal(options.noTools,'all');assert.equal(options.tools.length,0);
 assert.equal(api.loaders[0].noContextFiles,true);assert.equal(api.loaders[0].noExtensions,true);
 assert.equal(api.prompts[0].args.images[0].data,payload.images[0].data);
 await assert.rejects(api.temporaryPrompt(1,payload,()=>{}),/等待当前回复/);
 api.finish();await run;
 assert.equal(events.at(-1).type,'done');assert.equal(api.created[0].listener,null);
 const follow=api.temporaryPrompt(1,{...payload,text:'follow up'},()=>{});await tick();
 assert.equal(api.created.length,1);await api.stopTemporary(1,payload.id);await follow;
 await api.closeTemporary(1,payload.id);assert.equal(api.created[0].disposed,true);
 const fresh=api.temporaryPrompt(1,payload,()=>{});await tick();assert.equal(api.created.length,2);
 api.closeOwner(1);await fresh;
});
test('temporary image validation and model capability errors happen before prompting',async()=>{
 const api=fixture();
 assert.throws(()=>api.validateInput({...payload,images:Array(9).fill(payload.images[0])}),/8/);
 assert.throws(()=>api.validateInput({...payload,images:[{data:'<invalid>',mimeType:'image/png'}]}),/格式/);
 assert.throws(()=>api.validateInput({...payload,text:'',images:[]}),/消息/);
 api.model.input=['text'];await assert.rejects(api.temporaryPrompt(2,payload,()=>{}),/不支持图片/);
 assert.equal(api.created.length,0);assert.equal(api.prompts.length,0);
});
test('actual Pi memory managers and isolated loader do not create conversation files',async()=>{
 const {SessionManager,SettingsManager,DefaultResourceLoader,createAgentSession,ModelRuntime}=await import('@earendil-works/pi-coding-agent');
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'pi-memory-test-'));
 let session;
 try {
  const settings=SettingsManager.inMemory({cacheWarming:'off'});
  const manager=SessionManager.inMemory(dir);
  manager.appendMessage({role:'user',content:[{type:'text',text:'temporary'},{type:'image',data:'aGVsbG8=',mimeType:'image/png'}],timestamp:1});
  settings.setDefaultModelAndProvider('demo','test');
  const loader=new DefaultResourceLoader({cwd:dir,agentDir:dir,settingsManager:settings,noExtensions:true,noSkills:true,noPromptTemplates:true,noThemes:true,noContextFiles:true,disabledBuiltinExtensions:['mcp'],systemPrompt:'Temporary chat'});
  await loader.reload();
  const runtime = await ModelRuntime.create({authPath:path.join(dir,'auth.json'),modelsPath:path.join(dir,'models.json'),allowModelNetwork:false,refreshOnCreate:false});
  const existingFiles=fs.readdirSync(dir);
  ({session}=await createAgentSession({cwd:dir,agentDir:dir,model:runtime.getModels()[0],modelRuntime:runtime,settingsManager:settings,sessionManager:manager,resourceLoader:loader,noTools:'all',tools:[]}));
  assert.equal(session.getActiveToolNames().length,0);
  assert.deepEqual(fs.readdirSync(dir),existingFiles);
  assert.equal(manager.getSessionFile(),undefined);assert.equal(manager.buildSessionContext().messages.length,1);
  assert.deepEqual(fs.readdirSync(dir),existingFiles);assert.equal(loader.getExtensions().extensions.length,0);assert.equal(loader.getAgentsFiles().agentsFiles.length,0);
 }finally{session?.dispose();fs.rmSync(dir,{recursive:true,force:true});}
});
