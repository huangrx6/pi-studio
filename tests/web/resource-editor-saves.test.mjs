import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import ts from 'typescript';

const source = fs.readFileSync(new URL('../../web/src/shell/useAppSettings.ts', import.meta.url), 'utf8');
const tree = ts.createSourceFile('useAppSettings.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const names = new Set(['reportSkillRefresh', 'acceptSkillResources', 'invalidateResourceReads', 'invalidateMcpRefresh', 'modelProjectionOwner', 'saveProvider', 'saveCustomModel', 'importSkillResource', 'runEditorWrite', 'editorOwner', 'finishEditorRefresh', 'retryEditorRefresh', 'modelEditorRecovery', 'acceptModelResources', 'refreshSavedModelConfiguration', 'invalidateModelRefresh']);
const functions = [];
function visit(node) {
  if (ts.isFunctionDeclaration(node) && names.has(node.name?.text)) functions.push(node.getText(tree));
  else ts.forEachChild(node, visit);
}
visit(tree); assert.equal(functions.length, names.size);
const code = ts.transpileModule(functions.join('\n') + '\nObject.assign(globalThis, { saveProvider, saveCustomModel, importSkillResource, retryEditorRefresh, refreshSavedModelConfiguration });', { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
const ready = (settings = {enabledModels: []}, models = {models: [], enabled: []}) => ({ committed: true, projection: {status: 'ready', value: {settings, models}} });
const tick = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
function harness(kind = 'provider') {
  const calls = [], applied = [], notices = [];
  const h = {
    setResourceWriteBusy: value => {h.resourceWriteBusy=value;},
    resourceCommitRef: { current: null },
    skillRefreshRequestRef: {current:0}, skillRefreshLockRef: {current:false}, skillRefreshTargetsRef: {current:new Set()}, setSkillRefreshBusy: value => {h.skillRefreshBusy=value;},
    resourceWriteRef: { current: null }, resourcePendingRef: { current: { models: false, mcp: false, skills: false } },
    modelRevisionRef: { current: new Map() }, modelWritesRef: { current: new Set() }, sessionLoadRef: { current: 1 }, sessionRef: { current: { id: 'session-a' } }, defaultModelWorkspaceRef: { current: '/A' },
    mcpRefreshRequestRef: { current: 0 }, mcpRefreshLockRef: { current: false }, settingsRequestRef: { current: 0 }, catalogRequestRef: { current: 0 }, extensionRefreshRequestRef: { current: 0 }, extensionRefreshLockRef: { current: false },
    setMcpRefreshBusy: value => { h.mcpRefreshBusy = value; }, setMcpRefreshError: value => { h.mcpRefreshError = value; }, setMcpRefreshSummary: value => { h.mcpRefreshSummary = value; },
    setModelRefreshSummary: value => { h.modelRefreshSummary = value; }, setDefaultModelSelection: value => { h.defaultSelection = value; }, setModelSelection: value => { h.selection = value; },
    editor: { kind }, editorLoading: false, settingsBusy: false,
    modelRefreshLockRef: {current:false}, modelRefreshRequestRef:{current:0},
    setModelRefreshBusy: value => { h.modelRefreshBusy = value; }, setModelRefreshError: value => { h.modelRefreshError = value; },
    editorSaveRef: { current: false }, editorRequestRef: { current: 1 }, editorRecoveryRef: { current: null }, editorDirtyRef: { current: true },
    editorScopeRef: { current: '/A' }, workspaceRef: { current: '/A' }, workspace: '/A',
    providerDraft: { providerId: 'gateway', apiKey: 'typed-but-not-logged', name: 'Gateway' },
    providerModels: {}, providerDiscovery: {}, providerCatalogState: {}, providerCatalogRequestsRef: { current: new Map() },
    customModel: { providerId: 'gateway', modelId: 'model-a', reasoning: false, thinkingLevels: [], contextWindow: 128, maxTokens: 8 },
    tokenUnits: { contextWindow: 'k', maxTokens: 'k' }, tokenInputAsInteger: n => Number(n) * 1000,
    skillWorkspace: '/B', workspaces: [{ cwd: '/B', name: 'Project B' }],
    setEditorSaving: value => { h.saving = value; }, setEditorError: value => { h.error = value; }, setEditorCommitted: value => { h.committed = value; },
    setSettingsData: value => { h.settingsData=typeof value === 'function' ? value(h.settingsData) : value; applied.push(['settings', h.settingsData]); }, setModels: value => applied.push(['models', value]), setEnabledModels: value => applied.push(['enabled', value]),
    pushNotification: (...args) => notices.push(args), setSkillRefreshSummary: value => {h.skillRefreshSummary=value;}, setSkillRefreshError: value => {h.skillRefreshError=value;},
    setExpandedProvider: value => { h.expanded = value; }, setModelQuery() {},
    acceptRuntimeSnapshot: (value, notice) => applied.push(['snapshot', value, notice]),
    discardEditor: () => { h.closed = (h.closed || 0) + 1; h.editorRequestRef.current++; h.editorRecoveryRef.current = null; h.editorSaveRef.current = false; h.saving = false; },
    errorText: error => error.message,
    window: { piApi: Object.fromEntries(['addProvider','addCustomModel','addSkill','providerModels','models','settings','refreshModels','refreshSkills'].map(method => [method, (...args) => new Promise((resolve,reject) => calls.push({method,args,resolve,reject}))])) },
  };
  for (const name of ['ProviderDraft','ProviderModels','ProviderDiscovery','ProviderCatalogState']) {
    const field = name[0].toLowerCase() + name.slice(1);
    h['set'+name] = value => { h[field] = typeof value === 'function' ? value(h[field]) : value; };
  }
  vm.runInNewContext(code, h); return { h, calls, applied, notices };
}

test('provider save success followed by catalog failure retains committed state and retries only catalog', async () => {
  const { h, calls, applied } = harness(); const saving = h.saveProvider(); await h.saveProvider(); assert.equal(calls.length, 1);
  calls[0].resolve(ready({ saved: true }, { models: ['new'], enabled: ['new'] })); await tick();
  assert.equal(h.providerDraft.apiKey, ''); assert.equal(calls[1].method, 'providerModels');
  calls[1].reject(new Error('catalog offline')); await saving;
  assert.equal(h.committed, true); assert.match(h.error, /保存已完成/); assert.equal(h.closed, undefined); assert.equal(applied.length, 3);
  const retry = h.retryEditorRefresh(); assert.equal(calls[2].method, 'providerModels'); calls[2].resolve({ models: ['reloaded'] }); await retry;
  assert.equal(h.closed, 1); assert.equal(h.expanded, 'gateway'); assert.equal(calls.filter(c => c.method === 'addProvider').length, 1);
});

test('model save keeps entered values through read failure; retry never repeats model write', async () => {
  const { h, calls } = harness('model'); const saving = h.saveCustomModel();
  calls[0].resolve(ready({ enabledModels: ['gateway/model-a'] })); await tick();
  assert.equal(calls[1].method, 'providerModels');
  calls[1].reject(new Error('catalog failed')); await saving;
  assert.equal(h.customModel.modelId, 'model-a'); assert.equal(h.committed, true);
  const retry = h.retryEditorRefresh(); calls[2].resolve({models: ['model-a']}); await retry;
  assert.equal(calls.filter(c => c.method === 'addCustomModel').length, 1); assert.equal(h.closed, 1);
});

test('project skill import to another workspace refreshes current settings; failure retries read only', async () => {
  const { h, calls, applied, notices } = harness('skill'); const saving = h.importSkillResource('project');
  assert.equal(calls[0].args[0].cwd, '/B'); calls[0].resolve({committed:true,projection:{status:'ready',value:{scope:'B',skills:[],skillErrors:[]}}}); await tick();
  assert.equal(calls[1].args[0], '/A'); calls[1].reject(new Error('read failed')); await saving; assert.equal(applied.length, 0);
  const retry = h.retryEditorRefresh(); calls[2].resolve({ scope: 'A' }); await retry;
  assert.equal(applied[0][1].scope, 'A'); assert.match(notices[0][0], /Project B/); assert.equal(calls.filter(c => c.method === 'addSkill').length, 1);
});

test('cancelled folder selection is not a committed write and leaves editor available', async () => {
  const { h, calls } = harness('skill'); const saving = h.importSkillResource('project'); calls[0].resolve(undefined); await saving;
  assert.equal(h.committed, undefined); assert.equal(h.closed, undefined); assert.equal(h.saving, false);
});

test('late provider writes and late model reads cannot apply after owner or workspace changes', async () => {
  const provider = harness(); const saving = provider.h.saveProvider(); provider.h.workspaceRef.current = '/B';
  provider.calls[0].resolve(ready()); await saving;
  assert.equal(provider.applied.length, 0); assert.equal(provider.calls.length, 1); assert.equal(provider.h.closed, undefined);
  const model = harness('model'); const modelSaving = model.h.saveCustomModel(); model.calls[0].resolve(ready()); await tick();
  const before = model.applied.length; model.h.editorRequestRef.current++;
  model.calls[1].resolve({models:['stale']}); await modelSaving;
  assert.equal(model.applied.length, before); assert.equal(model.h.closed, undefined);
});


test('IPC-internal post-commit failure is not retried until requested, and recovery never repeats config or key writes', async () => {
  for (const kind of ['provider', 'model']) {
    const {h,calls} = harness(kind); const save = kind === 'provider' ? h.saveProvider() : h.saveCustomModel();
    calls[0].resolve({committed:true,projection:{status:'error',message:'运行时刷新失败'}}); await save;
    assert.equal(calls.length,1); assert.equal(h.committed,true); assert.match(h.error,/保存已完成/);
    assert.equal(h.modelRefreshError,'运行时刷新失败');
    if(kind==='provider') assert.equal(h.providerDraft.apiKey,'');
    const first = h.retryEditorRefresh(); await h.retryEditorRefresh(); assert.equal(calls[1].method,'refreshModels');
    calls[1].reject(new Error('still offline')); await first; assert.equal(h.committed,true);
    const retry = h.retryEditorRefresh(); calls[2].resolve(ready().projection.value); await tick();
    assert.equal(calls[3].method,'providerModels');calls[3].resolve({models:[]});await retry;
    assert.equal(h.modelRefreshError,null);assert.equal(h.closed,1);
    assert.equal(calls.filter(c=>c.method.startsWith('add')).length,1);
  }
});

test('models-page recovery deduplicates clicks and applies only the current workspace request', async () => {
  const {h,calls,applied} = harness(); h.modelRefreshError='pending';
  const read=h.refreshSavedModelConfiguration();await h.refreshSavedModelConfiguration();assert.equal(calls.length,1);
  assert.equal(calls[0].method,'refreshModels');calls[0].resolve(ready().projection.value);await read;
  assert.equal(h.modelRefreshError,null);assert.equal(h.modelRefreshBusy,false);assert.equal(applied.length,3);
  const old=h.refreshSavedModelConfiguration();h.workspaceRef.current='/B';calls[1].resolve(ready().projection.value);await old;
  assert.equal(applied.length,3);assert.equal(calls.filter(c=>c.method.startsWith('add')).length,0);
});


test('a new model save invalidates an older manual recovery and its late success or failure', async () => {
  for (const kind of ['provider', 'model']) {
    for (const fails of [false, true]) {
      const {h,calls,applied} = harness(kind);
      const old = h.refreshSavedModelConfiguration();
      const saving = kind === 'provider' ? h.saveProvider() : h.saveCustomModel();
      assert.equal(h.modelRefreshBusy, false);
      calls[1].resolve(ready({revision:'new',enabledModels:[]}, {models:['new'],enabled:[]}));
      await tick(); calls[2].resolve({models:['new']}); await saving;
      const before = applied.length;
      if (fails) calls[0].reject(new Error('obsolete refresh failure'));
      else calls[0].resolve(ready({revision:'old'}, {models:['old']}).projection.value);
      await old;
      assert.equal(applied.length, before);
      assert.equal(h.modelRefreshError, null);
      assert.equal(h.providerModels.gateway[0], 'new');
      assert.equal(calls.filter(c => c.method.startsWith('add')).length, 1);
    }
  }
});


test('cross-workspace skill committed error refreshes target before current projection and never recopies files',async()=>{
 const {h,calls}=harness('skill');const saving=h.importSkillResource('project');calls[0].resolve({committed:true,projection:{status:'error',message:'target refresh unavailable'}});await saving;
 assert.equal(h.committed,true);assert.equal(h.skillRefreshTargetsRef.current.has('/B'),true);assert.equal(calls.length,1);
 const failed=h.retryEditorRefresh();assert.equal(calls[1].method,'refreshSkills');assert.equal(calls[1].args[0],'/B');calls[1].reject(new Error('still unavailable'));await failed;assert.equal(calls.length,2);
 const current=h.retryEditorRefresh();calls[2].resolve({skills:[],skillErrors:[]});await tick();assert.equal(calls[3].method,'settings');assert.equal(calls[3].args[0],'/A');calls[3].reject(new Error('current read failed'));await current;
 const retry=h.retryEditorRefresh();assert.equal(calls[4].method,'settings','successful target read is reused; only failed current projection repeats');calls[4].resolve({skills:[{name:'current'}],skillErrors:[]});await retry;
 assert.equal(h.settingsData.skills[0].name,'current');assert.equal(h.resourcePendingRef.current.skills,false);assert.equal(h.closed,1);assert.equal(calls.filter(call=>call.method==='addSkill').length,1);
});

test('obsolete editor commits request current-page recovery without publishing their old projections',async()=>{
 for(const kind of ['provider','model','skill']) {
  const {h,calls,applied}=harness(kind);const save=kind==='provider'?h.saveProvider():kind==='model'?h.saveCustomModel():h.importSkillResource('project');
  h.workspaceRef.current='/C';h.editorRequestRef.current++;const revision=h.settingsRequestRef.current;
  calls[0].resolve(kind==='skill'?{committed:true,projection:{status:'error',message:'old target failed'}}:ready({providers:[{id:'old'}],enabledModels:[]}));await save;
  assert.equal(applied.length,0);assert.equal(h.closed,undefined);assert.ok(h.settingsRequestRef.current>revision);assert.equal(h.resourceCommitRef.current,null);
  if(kind==='skill'){assert.equal(h.resourcePendingRef.current.skills,true);assert.equal(h.skillRefreshTargetsRef.current.has('/B'),true);}
  else {assert.equal(h.resourcePendingRef.current.models,true);assert.match(h.modelRefreshError,/刷新/);}
 }
});
