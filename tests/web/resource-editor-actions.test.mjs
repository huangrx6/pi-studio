import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import ts from 'typescript';

const source = [
  fs.readFileSync(new URL('../../web/src/shell/useAppSettings.ts', import.meta.url), 'utf8'),
  fs.readFileSync(new URL('../../web/src/shell/useSettingsWorkspace.ts', import.meta.url), 'utf8'),
].join('\n');
const tree = ts.createSourceFile('useAppSettings.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const names = new Set(['invalidateResourceReads', 'invalidateMcpRefresh', 'modelProjectionOwner', 'invalidateModelRefresh', 'acceptMcpResources', 'editorOwner', 'discardEditor', 'runEditorWrite', 'finishEditorRefresh', 'retryEditorRefresh', 'testCurrentMcp', 'currentMcpPayload', 'setMcpDraft', 'saveMcp']);
const functions = [];
function visit(node) {
  if (ts.isFunctionDeclaration(node) && names.has(node.name?.text)) functions.push(node.getText(tree));
  else ts.forEachChild(node, visit);
}
visit(tree); assert.equal(functions.length, names.size);
const code = ts.transpileModule(functions.join('\n') + `\nObject.assign(globalThis, { ${[...names].join(', ')} });`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const flush = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };
const draft = () => ({ name: 'server-a', transport: 'stdio', command: 'npx', args: 'arg one\n/path with spaces', cwd: '/A', url: '', description: '', env: 'TOKEN=secret', headers: '', exposure: 'deferred', timeoutSeconds: '60', toolExposure: 'read_*=deferred', clearEnv: false, clearHeaders: false });
function harness() {
  const tests = [], saves = [], snapshots = [];
  const h = {
    setResourceWriteBusy: value => {h.resourceWriteBusy=value;},
    resourceCommitRef: { current: null },
    providerCatalogState: {},
    skillRefreshRequestRef: {current:0}, skillRefreshLockRef: {current:false}, skillRefreshTargetsRef: {current:new Set()}, setSkillRefreshBusy: value => {h.skillRefreshBusy=value;},
    modelRefreshLockRef: { current: false }, modelRefreshRequestRef: { current: 0 }, setModelRefreshBusy: value => { h.modelRefreshBusy = value; },
    resourceWriteRef: { current: null }, resourcePendingRef: { current: { models: false, mcp: false, skills: false } },
    modelRevisionRef: { current: new Map() }, modelWritesRef: { current: new Set() }, sessionLoadRef: { current: 1 }, sessionRef: { current: { id: 'session-a' } }, defaultModelWorkspaceRef: { current: '/A' },
    mcpRefreshRequestRef: { current: 0 }, mcpRefreshLockRef: { current: false }, settingsRequestRef: { current: 0 }, catalogRequestRef: { current: 0 }, extensionRefreshRequestRef: { current: 0 }, extensionRefreshLockRef: { current: false },
    setMcpRefreshBusy: value => { h.mcpRefreshBusy = value; }, setMcpRefreshError: value => { h.mcpRefreshError = value; }, setMcpRefreshSummary: value => { h.mcpRefreshSummary = value; },
    setModelRefreshSummary: value => { h.modelRefreshSummary = value; }, setDefaultModelSelection: value => { h.defaultSelection = value; }, setModelSelection: value => { h.selection = value; },
    editor: { kind: 'mcp', editId: 'server-a' }, editorLoading: false, settingsBusy: false, workspace: '/A',
    workspaceRef: { current: '/A' }, editorScopeRef: { current: '/A' }, editorRequestRef: { current: 1 },
    editorSaveRef: { current: false }, editorRecoveryRef: { current: null }, editorDirtyRef: { current: true }, editorBaselineRef: { current: 'initial' },
    mcpTestRequestRef: { current: 0 }, mcpTestLockRef: { current: false }, originalMcpArgsRef: { current: null },
    mcpDraft: draft(), providerDraft: { apiKey: 'provider-secret' }, mcpDraftRef: { current: null },
    setEditor(value) { h.editor = value; }, setEditorError(value) { h.error = value; }, setEditorSaving(value) { h.saving = value; }, setEditorCommitted(value) { h.committed = value; },
    setMcpTesting(value) { h.testing = value; }, setMcpTestResult(value) { h.result = value; },
    setMcpDraftState(value) { h.mcpDraft = typeof value === 'function' ? value(h.mcpDraft) : value; },
    setProviderDraft(value) { h.providerDraft = typeof value === 'function' ? value(h.providerDraft) : value; },
    setSettingsData(value) { h.settingsData=typeof value==='function'?value(h.settingsData):value; snapshots.push(h.settingsData); },
    acceptRuntimeSnapshot(snapshot) { snapshots.push(snapshot); }, errorText: error => error.message,
    window: { piApi: {
      testMcp(payload) { const pending = deferred(); tests.push({ ...pending, payload }); return pending.promise; },
      addMcp(payload) { const pending = deferred(); saves.push({ ...pending, payload }); return pending.promise; },
    } },
  };
  h.mcpDraftRef.current = h.mcpDraft;
  vm.runInNewContext(code, h);
  const replaceOwner = () => { h.editorRequestRef.current++; h.editor = { kind: 'mcp', editId: 'server-b' }; h.error = null; h.result = null; };
  return { h, tests, saves, snapshots, replaceOwner };
}

test('resource save uses one synchronous write lock and successful refresh closes exactly its owner', async () => {
  const { h } = harness(); const write = deferred(); let writes = 0, reads = 0;
  const action = () => { writes++; return write.promise; };
  const first = h.runEditorWrite(action); await h.runEditorWrite(action); assert.equal(writes, 1); assert.equal(h.saving, true);
  write.resolve(async () => { reads++; }); await first;
  assert.equal(reads, 1); assert.equal(h.editor, null); assert.equal(h.saving, false); assert.equal(h.editorSaveRef.current, false);
  assert.equal(h.providerDraft.apiKey, ''); assert.equal(h.mcpDraft.env, '');
});

test('committed write plus read failure preserves drafts and retries only the read, with one retry at a time', async () => {
  const { h } = harness(); const firstRead = deferred(), retryRead = deferred(); let writes = 0, reads = 0;
  const refresh = () => ++reads === 1 ? firstRead.promise : retryRead.promise;
  const pending = h.runEditorWrite(async () => { writes++; return refresh; }); await flush(); firstRead.reject(new Error('read unavailable')); await pending;
  assert.match(h.error, /保存已完成，但列表刷新失败/); assert.equal(h.committed, true); assert.equal(h.editorDirtyRef.current, false);
  assert.equal(h.mcpDraft.env, 'TOKEN=secret'); assert.equal(h.providerDraft.apiKey, 'provider-secret');
  await h.runEditorWrite(async () => { writes++; return refresh; }); assert.equal(writes, 1);
  const retry = h.retryEditorRefresh(); await h.retryEditorRefresh(); assert.equal(reads, 2); assert.equal(writes, 1);
  retryRead.resolve(); await retry; assert.equal(h.editor, null); assert.equal(h.editorRecoveryRef.current, null);
});

test('uncommitted write failures preserve input and allow a deliberate new save', async () => {
  const { h } = harness(); let writes = 0;
  const action = async () => { writes++; throw new Error('write failed'); };
  await h.runEditorWrite(action); assert.equal(h.error, 'write failed'); assert.equal(h.mcpDraft.env, 'TOKEN=secret'); assert.equal(h.editorRecoveryRef.current, null);
  await h.runEditorWrite(action); assert.equal(writes, 2); assert.equal(h.editorSaveRef.current, false);
});

test('obsolete write and read completions cannot close a replacement editor or publish its error', async () => {
  for (const stage of ['write', 'read']) for (const reject of [false, true]) {
    const { h, replaceOwner } = harness(), hold = deferred(); let reads = 0;
    const pending = h.runEditorWrite(async () => stage === 'write' ? hold.promise : async () => { reads++; await hold.promise; });
    await flush(); replaceOwner(); const next = h.editor;
    if (reject) hold.reject(new Error('obsolete')); else hold.resolve(async () => { reads++; });
    await pending; assert.equal(h.editor, next); assert.equal(h.error, null);
    assert.equal(reads, stage === 'write' ? 0 : 1); assert.equal(h.committed ?? false, stage === 'read');
  }
});

test('workspace changes suppress MCP save projection and editor closing, and obsolete retry starts no read', async () => {
  const { h, saves, snapshots } = harness(); const pending = h.saveMcp(); h.workspaceRef.current = '/B'; h.workspace = '/B';
  saves[0].resolve({ committed: true, projection: { status: 'ready', value: { mcp: [{ name: 'old-workspace-server' }] } } }); await pending;
  assert.equal(snapshots.length, 0); assert.notEqual(h.editor, null); assert.equal(h.committed, undefined);
  let reads = 0; h.editorRecoveryRef.current = async () => { reads++; }; await h.retryEditorRefresh(); assert.equal(reads, 0);
});

test('MCP draft tests take a synchronous lock and preserve exact arguments and credential clear flags', async () => {
  const { h, tests } = harness(); const args = ['arg one', '/path with spaces']; h.originalMcpArgsRef.current = args;
  h.mcpDraft.clearEnv = true;
  const first = h.testCurrentMcp(); await h.testCurrentMcp(); assert.equal(tests.length, 1);
  assert.equal(tests[0].payload.args, args); assert.equal(tests[0].payload.clearEnv, true); assert.equal(tests[0].payload.cwd, '/A');
  tests[0].resolve({ ok: false }); await first; assert.equal(h.result.ok, false); assert.equal(h.testing, false);
});

test('draft edits invalidate old success/error/finally without releasing a newer test lock', async () => {
  for (const reject of [false, true]) {
    const { h, tests } = harness(); const first = h.testCurrentMcp();
    h.setMcpDraft(current => ({ ...current, name: 'changed' })); assert.equal(h.result, null); assert.equal(h.testing, false);
    const second = h.testCurrentMcp(); assert.equal(tests[1].payload.name, 'changed');
    if (reject) tests[0].reject(new Error('old failure')); else tests[0].resolve({ ok: true, old: true });
    await first; assert.equal(h.result, null); assert.equal(h.error, null); assert.equal(h.mcpTestLockRef.current, true); assert.equal(h.testing, true);
    tests[1].resolve({ ok: true, current: true }); await second; assert.equal(h.result.current, true); assert.equal(h.testing, false);
  }
});

test('owner invalidation suppresses old MCP test success and failure; malformed rules make no IPC', async () => {
  for (const reject of [false, true]) {
    const { h, tests, replaceOwner } = harness(); const pending = h.testCurrentMcp(); replaceOwner();
    if (reject) tests[0].reject(new Error('old failure')); else tests[0].resolve({ ok: true });
    await pending; assert.equal(h.result, null); assert.equal(h.error, null);
  }
  const { h, tests } = harness(); h.mcpDraft.toolExposure = 'delete_*=invalid'; await h.testCurrentMcp();
  assert.equal(tests.length, 0); assert.match(h.error, /工具暴露规则格式无效/); assert.equal(h.mcpTestLockRef.current, false);
});


test('leaving an in-flight owner releases the new editor without allowing old finally to unlock it', async () => {
  const {h}=harness();const oldRead=deferred(),newWrite=deferred();
  const old=h.runEditorWrite(async()=>()=>oldRead.promise);await flush();
  h.discardEditor();h.editor={kind:'mcp',editId:'new'};let writes=0;
  const current=h.runEditorWrite(()=>{writes++;return newWrite.promise;});assert.equal(writes,1);assert.equal(h.saving,true);
  oldRead.resolve();await old;assert.equal(h.saving,true);assert.equal(h.editorSaveRef.current,true);
  await h.runEditorWrite(()=>{writes++;return Promise.resolve(async()=>{});});assert.equal(writes,1);
  newWrite.resolve(async()=>{});await current;assert.equal(h.saving,false);assert.equal(h.editor,null);
});

test('obsolete MCP editor commit signals read recovery without applying the old workspace snapshot',async()=>{
 const {h,saves,snapshots}=harness();const save=h.saveMcp();h.workspaceRef.current='/B';h.editorRequestRef.current++;const revision=h.settingsRequestRef.current;
 saves[0].resolve({committed:true,projection:{status:'ready',value:{mcp:[{name:'old-A'}]}}});await save;
 assert.equal(snapshots.length,0);assert.equal(h.resourcePendingRef.current.mcp,true);assert.match(h.mcpRefreshError,/刷新/);assert.ok(h.settingsRequestRef.current>revision);assert.equal(h.resourceCommitRef.current,null);
});
