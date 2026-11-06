import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import ts from 'typescript';

// Execute the actual App closures; only React state/refs and IPC are supplied by the harness.
const source = fs.readFileSync(new URL('../../web/src/shell/useAppSettings.ts', import.meta.url), 'utf8');
const tree = ts.createSourceFile('useAppSettings.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const names = new Set(['toggleProvider', 'deleteProvider', 'deleteCustomModel', 'importProviderModels', 'toggleMcp', 'deleteMcp', 'setEnabled', 'invalidateProviderCatalog', 'runResourceWrite', 'invalidateResourceReads', 'invalidateModelRefresh', 'invalidateMcpRefresh', 'modelProjectionOwner', 'acceptModelResources', 'acceptMcpResources', 'refreshSavedModelConfiguration', 'refreshSavedMcpConfiguration', 'runEditorWrite', 'editorOwner', 'finishEditorRefresh', 'writeModelSelection', 'saveDefaultSelection', 'selectDefaultModel', 'selectDefaultThinking']);
const functions = [];
function visit(node) { if (ts.isFunctionDeclaration(node) && names.has(node.name?.text)) functions.push(node.getText(tree)); else ts.forEachChild(node, visit); }
visit(tree); assert.equal(functions.length, names.size);
const code = ts.transpileModule(functions.join('\n') + `\nObject.assign(globalThis, {${[...names].join(',')}});`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
const deferred = () => { let resolve, reject; const promise = new Promise((a,b) => { resolve=a; reject=b; }); return {promise, resolve, reject}; };
const tick = async () => { for (let i=0;i<8;i++) await Promise.resolve(); };
const selection = id => ({modelRef:id,label:id});
const projection = id => ({settings:{revision:id,enabledModels:[id]},models:{models:[id],enabled:[id],selection:selection(id),defaultSelection:selection(id)}});
const ready = value => ({committed:true,projection:{status:'ready',value}});
const committedError = {committed:true,projection:{status:'error',message:'projection unavailable'}};
function harness() {
  const calls=[], notices=[], confirms=[];
  const h = {
    resourceCommitRef: { current: null },
    skillRefreshRequestRef: {current:0}, skillRefreshLockRef: {current:false}, skillRefreshTargetsRef: {current:new Set()}, setSkillRefreshBusy: value => {h.skillRefreshBusy=value;}, workspace:'/A',workspaceRef:{current:'/A'}, resourceWriteRef:{current:null},resourcePendingRef:{current:{models:false,mcp:false,skills:false}},settingsBusy:false,
    editor:{kind:'provider'},editorLoading:false,editorSaveRef:{current:false},editorRecoveryRef:{current:null},editorDirtyRef:{current:true},editorRequestRef:{current:1},editorScopeRef:{current:'/A'},
    modelRefreshRequestRef:{current:0},modelRefreshLockRef:{current:false},mcpRefreshRequestRef:{current:0},mcpRefreshLockRef:{current:false},settingsRequestRef:{current:0},catalogRequestRef:{current:0},extensionRefreshRequestRef:{current:0},extensionRefreshLockRef:{current:false},
    modelRevisionRef:{current:new Map()},modelWritesRef:{current:new Set()},modelWriteResultsRef:{current:new Map()},sessionLoadRef:{current:1},sessionRef:{current:null},defaultModelWorkspaceRef:{current:'/A'},turnActiveRef:{current:false},transcriptCacheRef:{current:new Map()},
    providerDiscoveryRequestsRef:{current:new Map()},providerCatalogRequestsRef:{current:new Map()},providerModels:{},providerCatalogState:{},defaultModelSelection:selection('initial'),modelSelection:selection('initial'),
    actionConfirmation:{confirm(options){const d=deferred();confirms.push({...d,options});return d.promise;}},
    errorText:error=>error.message,pushNotification:(...args)=>notices.push(args),acceptRuntimeSnapshot:value=>{h.settingsData=value;},
    discardEditor:()=>{h.editor=null;h.editorRequestRef.current++;h.editorSaveRef.current=false;h.editorRecoveryRef.current=null;h.editorSaving=false;},
    window:{piApi:Object.fromEntries(['setEnabledModels','setProviderEnabled','removeProvider','removeCustomModel','importProviderModels','setMcpEnabled','removeMcp','refreshModels','refreshMcp','setDefaultModel','setDefaultThinkingLevel','conversationConfigure'].map(method=>[method,(...args)=>{const d=deferred();calls.push({...d,method,args});return d.promise;}]))},
  };
  for(const field of ['ResourceWriteBusy','SettingsError','ModelRefreshSummary','ModelRefreshError','ModelRefreshBusy','McpRefreshSummary','McpRefreshError','McpRefreshBusy','SettingsData','Models','EnabledModels','DefaultModelSelection','ModelSelection','ProviderModels','ProviderDiscovery','ProviderCatalogState','ExpandedProvider','EditorSaving','EditorError','EditorCommitted','DefaultModelBusy']) {const key=field[0].toLowerCase()+field.slice(1);h['set'+field]=value=>{h[key]=typeof value==='function'?value(h[key]):value;};}
  vm.runInNewContext(code,h);return {h,calls,notices,confirms};
}
function operation(h, domain, d, overrides={}) {return {summary:`${domain} committed`,write:()=>d.promise,apply:domain==='models'?h.acceptModelResources:h.acceptMcpResources,...overrides};}

test('one synchronous resource lock spans confirmation across domains; cancel performs no write',async()=>{
 const {h,confirms}=harness();const d=deferred();let writes=0;
 const options=operation(h,'models',d,{confirm:{title:'Delete?'},write:()=>{writes++;return d.promise;}});
 const first=h.runResourceWrite('models',options);await h.runResourceWrite('mcp',options);assert.equal(confirms.length,1);assert.equal(writes,0);
 await h.runEditorWrite(async()=>{writes++;return async()=>{};});assert.equal(writes,0);
 confirms[0].resolve(false);await first;assert.equal(writes,0);assert.equal(h.resourceWriteRef.current,null);assert.equal(h.resourceWriteBusy,false);
 const second=h.runResourceWrite('models',options);confirms[1].resolve(true);await tick();assert.equal(writes,1);d.resolve(ready(projection('new')));await second;assert.equal(h.settingsData.revision,'new');
});

test('uncommitted resource rejection is an error without success fact and allows deliberate retry',async()=>{
 const {h,notices}=harness();let writes=0;
 const options={summary:'deleted',write:async()=>{writes++;throw new Error('write rejected');},apply:()=>assert.fail('must not project')};
 await h.runResourceWrite('models',options);assert.equal(h.settingsError,'write rejected');assert.equal(h.resourcePendingRef.current.models,false);assert.equal(notices.length,0);
 await h.runResourceWrite('models',options);assert.equal(writes,2);
});

for(const domain of ['models','mcp']) test(`${domain} committed projection failure blocks stale writes and recovery only reads through failure/success`,async()=>{
 const {h,calls,notices}=harness(),d=deferred();let writes=0,optimistic=0;
 const options=operation(h,domain,d,{write:()=>{writes++;return d.promise;},onCommitted:()=>optimistic++});
 const save=h.runResourceWrite(domain,options);await h.runResourceWrite(domain,options);assert.equal(writes,1);d.resolve(committedError);await save;
 assert.equal(optimistic,1);assert.equal(h.resourcePendingRef.current[domain],true);assert.equal(h[domain==='models'?'modelRefreshSummary':'mcpRefreshSummary'],`${domain} committed`);assert.equal(notices.length,0);
 await h.runResourceWrite(domain,options);assert.equal(writes,1);
 const refresh=domain==='models'?h.refreshSavedModelConfiguration:h.refreshSavedMcpConfiguration;
 const first=refresh();await refresh();assert.equal(calls.length,1);calls[0].reject(new Error('read still unavailable'));await first;assert.equal(h.resourcePendingRef.current[domain],true);
 const second=refresh();calls[1].resolve(domain==='models'?projection('recovered'):{revision:'recovered'});await second;
 assert.equal(h.settingsData.revision,'recovered');assert.equal(h.resourcePendingRef.current[domain],false);assert.equal(writes,1);assert.equal(calls[0].args[0],'/A');
});

test('exception applying an already committed result reports read recovery, never write failure',async()=>{
 const {h}=harness();await h.runResourceWrite('models',{summary:'deleted',write:async()=>ready(projection('x')),apply:()=>{throw new Error('render projection failed');}});
 assert.equal(h.resourcePendingRef.current.models,true);assert.match(h.modelRefreshError,/操作已完成/);assert.equal(h.settingsError,null);
});

test('pending physical resource write survives scope transfer and blocks both list and editor writes until settled',async()=>{
 for(const rejects of [false,true]) {const {h}=harness(),old=deferred();let secondWrites=0;const first=h.runResourceWrite('models',operation(h,'models',old));
  h.workspaceRef.current='/B';h.resourceWriteRef.current=null; // Workspace ownership effect releases only the old UI owner.
  await h.runResourceWrite('mcp',{summary:'new',write:async()=>{secondWrites++;return ready({mcp:[]});},apply:h.acceptMcpResources});
  await h.runEditorWrite(async()=>{secondWrites++;return async()=>{};});assert.equal(secondWrites,0);assert.notEqual(h.resourceCommitRef.current,null);
  rejects?old.reject(new Error('old')):old.resolve(committedError);await first;assert.equal(h.resourceCommitRef.current,null);assert.equal(h.settingsData,undefined);assert.equal(h.resourceWriteBusy,false);
  assert.equal(h.resourcePendingRef.current.models,!rejects);if(!rejects)assert.match(h.modelRefreshError,/刷新当前模型/);
  await h.runResourceWrite('mcp',{summary:'new',write:async()=>{secondWrites++;return ready({mcp:[]});},apply:h.acceptMcpResources});assert.equal(secondWrites,1);
 }
});

for(const domain of ['models','mcp']) test(`${domain} old manual recovery cannot overwrite a newer editor completion or its busy state`,async()=>{
 for(const rejects of [false,true]){const {h,calls}=harness();const refresh=domain==='models'?h.refreshSavedModelConfiguration:h.refreshSavedMcpConfiguration;const old=refresh();const write=deferred();
  const saving=h.runEditorWrite(()=>write.promise);assert.equal(h[domain==='models'?'modelRefreshBusy':'mcpRefreshBusy'],false);
  const before=selection('new');write.resolve(async()=>{h.settingsData={revision:'editor-new'};h.defaultModelSelection=before;});await saving;
  rejects?calls[0].reject(new Error('obsolete')):calls[0].resolve(domain==='models'?projection('old'):{revision:'old'});await old;
  assert.equal(h.settingsData.revision,'editor-new');assert.equal(h.defaultModelSelection,before);assert.equal(h[domain==='models'?'modelRefreshError':'mcpRefreshError'],undefined);
 }
});

test('late resource projection updates catalog but cannot replace a newer explicit default selection',async()=>{
 for(const defaultsComplete of [false,true]){const {h,calls}=harness(),d=deferred();const resource=h.runResourceWrite('models',operation(h,'models',d));const selected=h.selectDefaultModel('chosen');
  if(defaultsComplete){calls[0].resolve(selection('chosen'));await selected;}
  d.resolve(ready(projection('old-default')));await resource;assert.equal(h.models[0],'old-default');assert.notEqual(h.defaultModelSelection.modelRef,'old-default');
  if(!defaultsComplete){calls[0].resolve(selection('chosen'));await selected;}assert.equal(h.defaultModelSelection.modelRef,'chosen');assert.equal(h.modelSelection.modelRef,'chosen');
 }
});

test('settings default writes deduplicate same scope, never configure active session, and ignore stale workspace errors',async()=>{
 const {h,calls}=harness();h.sessionRef.current={id:'session-a'};h.modelSelection=selection('session-model');
 const first=h.selectDefaultModel('default-a');await h.selectDefaultThinking('high');assert.equal(calls.length,1);assert.equal(calls[0].method,'setDefaultModel');
 calls[0].resolve(selection('default-a'));await first;assert.equal(h.defaultModelSelection.modelRef,'default-a');assert.equal(h.modelSelection.modelRef,'session-model');
 const stale=h.selectDefaultThinking('high');h.workspaceRef.current='/B';const current=h.selectDefaultModel('default-b');calls[1].reject(new Error('old error'));await stale;assert.equal(h.settingsError,null);assert.equal(h.defaultModelBusy,true);
 calls[2].resolve(selection('default-b'));await current;assert.equal(h.defaultModelSelection.modelRef,'default-b');assert.equal(h.defaultModelBusy,false);assert.equal(h.modelSelection.modelRef,'session-model');
});

test('a resource projection cannot rewrite the composer selection after conversation generation changes',async()=>{
 const {h}=harness(),d=deferred();const pending=h.runResourceWrite('models',operation(h,'models',d));h.sessionLoadRef.current++;h.modelSelection=selection('new-composer');d.resolve(ready(projection('default')));await pending;
 assert.equal(h.defaultModelSelection.modelRef,'default');assert.equal(h.modelSelection.modelRef,'new-composer');
});


test('committed model and provider deletion immediately remove stale rows and invalidate the catalog',async()=>{
 for(const kind of ['model','provider']) { const {h,calls,confirms}=harness();const model={id:'p/m',provider:'p',model:'m',name:'Model',origin:'configured'};const provider={id:'p',name:'Provider',models:1};
  h.settingsData={providers:[provider]};h.models=[model];h.enabledModels=['p/m'];h.providerModels={p:[model]};h.providerDiscovery={p:{selected:['m']}};h.expandedProvider='p';
  const action=kind==='model'?h.deleteCustomModel('p',model):h.deleteProvider(provider);confirms[0].resolve(true);await tick();calls[0].resolve(committedError);await action;
  assert.equal(h.models.length,0);assert.equal(h.enabledModels.length,0);assert.equal(h.providerModels.p,undefined);assert.equal(h.expandedProvider,null);assert.equal(h.resourcePendingRef.current.models,true);
  if(kind==='provider')assert.equal(h.settingsData.providers.length,0);
 }
});

test('committed model import clears selected discoveries and source toggle collapses invalidated catalog',async()=>{
 const {h,calls}=harness();h.providerModels={p:[{id:'p/m'}]};h.providerDiscovery={p:{selected:['new']}};h.expandedProvider='p';
 const importing=h.importProviderModels('p',[{id:'new',name:'New'}]);calls[0].resolve(committedError);await importing;
 assert.equal(h.providerDiscovery.p,undefined);assert.equal(h.providerModels.p,undefined);assert.equal(h.expandedProvider,null);assert.equal(h.modelRefreshSummary,'已添加 1 个模型');
 const next=harness();next.h.settingsData={providers:[{id:'p',enabled:true}]};next.h.providerModels={p:[]};next.h.expandedProvider='p';
 const toggle=next.h.toggleProvider({id:'p',name:'Provider'},false);next.calls[0].resolve(committedError);await toggle;
 assert.equal(next.h.settingsData.providers[0].enabled,false);assert.equal(next.h.providerModels.p,undefined);assert.equal(next.h.expandedProvider,null,'invalidated catalog must not remain stuck loading');
});

test('committed MCP toggle/delete preserve exact local completion while refresh is unavailable',async()=>{
 const {h,calls,confirms}=harness();h.settingsData={mcp:[{name:'server',enabled:true}]};const toggle=h.toggleMcp('server',false);calls[0].resolve(committedError);await toggle;
 assert.equal(h.settingsData.mcp[0].enabled,false);assert.equal(h.resourcePendingRef.current.mcp,true);await h.deleteMcp('server');assert.equal(confirms.length,0,'stale row cannot delete again');
 const next=harness();next.h.settingsData={mcp:[{name:'server',enabled:true}]};const deletion=next.h.deleteMcp('server');next.confirms[0].resolve(true);await tick();next.calls[0].resolve(committedError);await deletion;
 assert.equal(next.h.settingsData.mcp.length,0);assert.match(next.h.mcpRefreshSummary,/已删除/);
});

test('model/MCP projections merge only their domain and cannot restore unrelated stale resources',()=>{
 const {h}=harness();h.settingsData={providers:[{id:'new-provider'}],customModels:[],enabledModels:['new-model'],mcp:[{name:'new-mcp'}],skills:[{name:'new-skill'}]};
 const value=projection('model-update');value.settings.providers=[{id:'updated-provider'}];value.settings.mcp=[{name:'old-mcp'}];value.settings.skills=[{name:'old-skill'}];
 h.acceptModelResources(value,h.modelProjectionOwner());assert.equal(h.settingsData.providers[0].id,'updated-provider');assert.equal(h.settingsData.mcp[0].name,'new-mcp');assert.equal(h.settingsData.skills[0].name,'new-skill');
 h.acceptMcpResources({providers:[{id:'obsolete-provider'}],mcp:[{name:'updated-mcp'}],skills:[{name:'obsolete-skill'}]});assert.equal(h.settingsData.providers[0].id,'updated-provider');assert.equal(h.settingsData.mcp[0].name,'updated-mcp');assert.equal(h.settingsData.skills[0].name,'new-skill');
});


test('pending editor IPC cannot start a second write after its UI owner is discarded',async()=>{
 const {h}=harness(),old=deferred();let writes=0;const saving=h.runEditorWrite(()=>old.promise);
 h.discardEditor();h.workspaceRef.current='/B';h.editorScopeRef.current='/B';h.editor={kind:'mcp'};
 await h.runEditorWrite(async()=>{writes++;return async()=>{};});await h.runResourceWrite('mcp',{summary:'new',write:async()=>{writes++;return ready({mcp:[]});},apply:h.acceptMcpResources});assert.equal(writes,0);
 old.resolve(async()=>assert.fail('obsolete recovery must not execute'));await saving;assert.equal(h.resourceCommitRef.current,null);
 await h.runEditorWrite(async()=>{writes++;return async()=>{};});assert.equal(writes,1);
});
