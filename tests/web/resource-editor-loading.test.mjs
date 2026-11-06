import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import ts from 'typescript';

const source = fs.readFileSync(new URL('../../web/src/shell/useAppSettings.ts', import.meta.url), 'utf8');
const tree = ts.createSourceFile('useAppSettings.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let open;
function visit(node) { if (ts.isFunctionDeclaration(node) && node.name?.text === 'openEditor') open = node.getText(tree); else ts.forEachChild(node, visit); }
visit(tree); assert.ok(open);
const code = ts.transpileModule(open + '\nglobalThis.openEditor = openEditor;', { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
function harness() {
  const calls = [];
  const h = {
    resourceCommitRef: { current: null },
    resourceWriteRef: {current:null},
    editorSaveRef: {current:false}, editorRequestRef:{current:0}, editorScopeRef:{current:''}, editorBaselineRef:{current:null}, editorRecoveryRef:{current:null},
    workspace:'/A', workspaceRef:{current:'/A'}, originalMcpArgsRef:{current:null}, providerModels:{}, settingsData:{customModels:[]},
    emptyCustomModelConfig: () => ({modelId:'',providerId:''}), errorText: e => e.message,
    automaticTokenUnit: () => 'k', tokenInputValue: value => String(value / 1000), DEFAULT_MODEL_THINKING_LEVELS:['off','high'],
    window:{piApi:Object.fromEntries(['providerConfig','mcpConfig'].map(method=>[method,(id)=>new Promise((resolve,reject)=>calls.push({method,id,resolve,reject}))]))},
    refreshProviderModels:id=>new Promise((resolve,reject)=>calls.push({method:'providerModels',id,resolve,reject})),
  };
  for(const name of ['Editor','EditorError','EditorLoading','EditorCommitted','ResourceScope','SkillWorkspace','McpTestResult','McpTesting','ProviderDraft','McpDraft','CustomModel','TokenUnits']) {
    const key=name[0].toLowerCase()+name.slice(1); h['set'+name]=value=>{h[key]=value;};
  }
  vm.runInNewContext(code,h);return{h,calls};
}

test('cold model edit remains loading until catalog resolves, then uses the existing model values',async()=>{
  const {h,calls}=harness();const pending=h.openEditor('model','id-a','gateway');
  assert.equal(h.editorLoading,true);assert.equal(h.customModel.modelId,'');
  calls[0].resolve([{model:'id-a',name:'Existing',contextWindow:128000,maxTokens:8000,thinkingLevels:[],reasoning:false}]);await pending;
  assert.equal(h.editorLoading,false);assert.equal(h.customModel.name,'Existing');assert.equal(h.customModel.contextWindow,'128');
});

test('failed or missing model reads expose error with empty id; explicit reopening retries the read',async()=>{
  const {h,calls}=harness();let pending=h.openEditor('model','id-a','gateway');calls[0].reject(new Error('offline'));await pending;
  assert.equal(h.editorError,'offline');assert.equal(h.editorLoading,false);assert.equal(h.customModel.modelId,'');
  pending=h.openEditor('model','id-a','gateway');assert.equal(h.editorLoading,true);calls[1].resolve([]);await pending;
  assert.match(h.editorError,/模型配置已不可用/);assert.equal(h.customModel.modelId,'');
});

test('late configuration reads ignore changed workspace or a newer editor even before cleanup effects',async()=>{
  for(const mode of ['workspace','new-editor']){
    const {h,calls}=harness();const pending=h.openEditor('provider','old');
    if(mode==='workspace')h.workspaceRef.current='/B';else await h.openEditor('mcp');
    const before=h.providerDraft;calls[0].resolve({providerId:'old',name:'stale'});await pending;
    assert.equal(h.providerDraft,before);assert.equal(h.providerDraft.providerId,'');
  }
});


test('explicit retry bypasses a cached catalog that no longer contains the edited model',async()=>{
  const {h,calls}=harness();h.providerModels.gateway=[];
  await h.openEditor('model','id-a','gateway');assert.equal(calls.length,0);assert.match(h.editorError,/模型配置已不可用/);
  const pending=h.openEditor('model','id-a','gateway',true);assert.equal(calls.length,1);
  calls[0].resolve([{model:'id-a',name:'Restored',contextWindow:128000,maxTokens:8000}]);await pending;
  assert.equal(h.customModel.modelId,'id-a');assert.equal(h.editorError,null);
});
