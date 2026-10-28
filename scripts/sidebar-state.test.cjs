const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {updateSidebar}=require('../electron/sidebar-state.cjs');
const {readConfig,writeConfig}=require('../electron/settings-config.cjs');
test('sidebar changes persist, preserve unrelated settings, and are reversible',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'pi-sidebar-'));
 try {
 const file=path.join(dir,'config.json');const original={theme:'dark',modelRef:'provider/model'};
 let config=updateSidebar(original,{kind:'workspace',id:'/project',action:'rename',name:'  Project A  '});
 config=updateSidebar(config,{kind:'workspace',id:'/project',action:'remove'});
 config=updateSidebar(config,{kind:'session',id:'session-a',action:'pin'});
 config=updateSidebar(config,{kind:'session',id:'session-a',action:'archive'});
 config=updateSidebar(config,{kind:'session',id:'session-a',action:'rename',name:'Title'});
 writeConfig(file,config);config=readConfig(file,{});
 assert.deepEqual(config.workspaceMetadata['/project'],{name:'Project A',hidden:true});
 assert.deepEqual(config.sessionMetadata['session-a'],{pinned:true,archived:true,name:'Title'});
 assert.equal(config.theme,'dark');assert.equal(config.modelRef,'provider/model');assert.equal(original.workspaceMetadata,undefined);
 config=updateSidebar(config,{kind:'workspace',id:'/project',action:'restore'});
 config=updateSidebar(config,{kind:'session',id:'session-a',action:'archive'});
 config=updateSidebar(config,{kind:'session',id:'session-a',action:'pin'});
 assert.equal(config.workspaceMetadata['/project'].hidden,false);
 assert.deepEqual(config.sessionMetadata['session-a'],{pinned:false,archived:false,name:'Title'});
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('invalid metadata actions cannot alter state',()=>{
 for(const input of [{kind:'workspace',id:'/project',action:'rename',name:' '},{kind:'session',id:'__proto__',action:'pin'},{kind:'session',id:'s',action:'remove'}]) assert.throws(()=>updateSidebar({},input));
});
test('SDK fork creates a separate history and leaves the source untouched',async()=>{
 const {SessionManager}=await import('@earendil-works/pi-coding-agent');
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'pi-fork-'));
 try {
 const source=path.join(dir,'source.jsonl');
 fs.writeFileSync(source,[{type:'session',version:3,id:'source-session',timestamp:new Date().toISOString(),cwd:dir},{type:'message',id:'entry1',parentId:null,timestamp:new Date().toISOString(),message:{role:'user',content:[{type:'text',text:'fixture history'}],timestamp:Date.now()}}].map(JSON.stringify).join('\n')+'\n');
 const before=fs.readFileSync(source);
 const fork=SessionManager.forkFrom(source,dir,dir);
 fork.appendSessionInfo('Fork title');
 assert.notEqual(fork.getSessionId(),'source-session');assert.notEqual(fork.getSessionFile(),source);
 assert.equal(fork.getHeader().parentSession,source);
 assert.ok(fork.getEntries().some(e=>e.type==='message'&&e.message.content[0].text==='fixture history'));
 assert.ok(fs.readFileSync(source).equals(before));
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
