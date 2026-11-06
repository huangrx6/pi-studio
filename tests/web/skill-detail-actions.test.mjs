import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import ts from 'typescript';

const source = [
  fs.readFileSync(new URL('../../web/src/shell/useSettingsWorkspace.ts', import.meta.url), 'utf8'),
  fs.readFileSync(new URL('../../web/src/shell/useAppSettings.ts', import.meta.url), 'utf8'),
].join('\n');
const tree = ts.createSourceFile('skill-detail-actions.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const names = new Set(['runResourceWrite', 'invalidateResourceReads', 'invalidateModelRefresh', 'invalidateMcpRefresh', 'modelProjectionOwner', 'reportSkillRefresh', 'acceptSkillResources', 'refreshSavedSkillConfiguration', 'setSkillDetail', 'openSkillDetail', 'closeSkillDetail', 'toggleSkillTrust', 'deleteSkill']);
const functions = [];
function visit(node) {
  if (ts.isFunctionDeclaration(node) && names.has(node.name?.text)) functions.push(node.getText(tree));
  else ts.forEachChild(node, visit);
}
visit(tree); assert.equal(functions.length, names.size);
const code = ts.transpileModule(functions.join('\n') + '\nObject.assign(globalThis, { openSkillDetail, closeSkillDetail, toggleSkillTrust, deleteSkill, refreshSavedSkillConfiguration, runResourceWrite, acceptSkillResources, reportSkillRefresh });', { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
function harness() {
  const writes = [], confirms = [];
  const h = {
    resourceCommitRef: { current: null },
    resourceWriteRef:{current:null},resourcePendingRef:{current:{models:false,mcp:false,skills:false}},editorSaveRef:{current:false},settingsBusy:false,
    modelRefreshRequestRef:{current:0},modelRefreshLockRef:{current:false},mcpRefreshRequestRef:{current:0},mcpRefreshLockRef:{current:false},settingsRequestRef:{current:0},catalogRequestRef:{current:0},extensionRefreshRequestRef:{current:0},extensionRefreshLockRef:{current:false},
    skillRefreshRequestRef:{current:0},skillRefreshLockRef:{current:false},skillRefreshTargetsRef:{current:new Set()},
    modelRevisionRef:{current:new Map()},sessionLoadRef:{current:1},defaultModelWorkspaceRef:{current:'/A'},
    setModelRefreshBusy(){},setMcpRefreshBusy(){},setSkillRefreshBusy(value){h.refreshBusy=value;},setResourceWriteBusy(value){h.busy=value;},
    setSkillRefreshSummary(value){h.refreshSummary=value;},setSkillRefreshError(value){h.refreshError=value;},
    setSettingsData(value){h.snapshot=typeof value==='function'?value(h.snapshot):value;},pushNotification(){},
    workspaceRef: { current: '/A' }, skillDetailRef: { current: null }, skillDetailGenerationRef: { current: 0 },
    setSkillDetailState(value) { h.detail = value; }, setSkillDetailError(value) { h.detailError = value; }, setSettingsError(value) { h.error = value; }, setSettingsBusy(value) { h.busy = value; },
    acceptRuntimeSnapshot(value) { h.snapshot = value; }, errorText: error => error.message,
    actionConfirmation: { confirm: () => new Promise(resolve => confirms.push(resolve)) },
    window: { piApi: Object.fromEntries(['removeSkill', 'setSkillTrusted', 'refreshSkills', 'settings'].map(method => [method, (...args) => new Promise((resolve, reject) => writes.push({ method, args, resolve, reject }))])) },
  };
  vm.runInNewContext(code, h);
  h.controller = {
    runResourceWrite: (...args) => h.runResourceWrite(...args),
    acceptSkillResources: (...args) => h.acceptSkillResources(...args),
  };
  return { h, writes, confirms };
}
const ready = value => ({committed:true,projection:{status:'ready',value}});
const a = { name: 'A', path: '/A/SKILL.md' }, b = { name: 'B', path: '/B/SKILL.md' };
const tick = async () => { await Promise.resolve(); await Promise.resolve(); };

test('late deletion cannot close another skill or a reopened detail', async () => {
  for (const next of [a, b]) {
    const { h, writes, confirms } = harness(); h.openSkillDetail(a);
    const pending = h.deleteSkill(a); confirms[0](true); await tick();
    h.closeSkillDetail(); h.openSkillDetail(next); writes[0].resolve(ready({ skills: [] })); await pending;
    assert.equal(h.detail, next); assert.equal(h.busy, false);
  }
});

test('late trust completion cannot replace a newer detail even with the same path', async () => {
  const { h, writes } = harness(); h.openSkillDetail(a); const old = h.toggleSkillTrust(a, false);
  h.closeSkillDetail(); h.openSkillDetail({ ...a, name: 'reopened' });
  writes[0].resolve(ready({ skills: [{ ...a, trusted: false }] })); await old;
  assert.equal(h.detail.name, 'reopened'); assert.equal(h.detailError, null);
});

test('a scope change during confirmation cancels the write; late old-scope results stay out of settings', async () => {
  const { h, writes, confirms } = harness(); const trust = h.toggleSkillTrust(a, true);
  h.workspaceRef.current = '/B'; confirms[0](true); await trust; assert.equal(writes.length, 0);
  h.resourceWriteRef.current = null; // Workspace ownership effect releases the old confirmation lock.
  h.workspaceRef.current = '/A'; const revoke = h.toggleSkillTrust(a, false);
  h.workspaceRef.current = '/B'; writes[0].resolve(ready({ skills: [a] })); await revoke; assert.equal(h.snapshot, undefined);
});

test('one synchronous mutation lock prevents duplicate confirmation and duplicate writes', async () => {
  const { h, writes, confirms } = harness(); const first = h.deleteSkill(a);
  await h.deleteSkill(a); await h.toggleSkillTrust(a, false); assert.equal(confirms.length, 1); assert.equal(writes.length, 0);
  confirms[0](false); await first;
  const retry = h.toggleSkillTrust(a, false); assert.equal(writes.length, 1);
  writes[0].resolve(ready({ skills: [a] })); await retry; assert.equal(h.resourceWriteRef.current, null);
});

test('current failures stay local but an obsolete detail never receives another skill error', async () => {
  const { h, writes } = harness(); h.openSkillDetail(a); let pending = h.toggleSkillTrust(a, false);
  writes[0].reject(new Error('local')); await pending; assert.equal(h.detailError, 'local');
  pending = h.toggleSkillTrust(a, false); h.openSkillDetail(b);
  writes[1].reject(new Error('A failed')); await pending; assert.equal(h.detailError, null); assert.equal(h.error, 'A failed');
});


test('committed trust failure preserves fact and retries refresh only without changing a replacement detail',async()=>{
 const {h,writes}=harness();h.openSkillDetail(a);const saving=h.toggleSkillTrust(a,false);writes[0].resolve({committed:true,projection:{status:'error',message:'read failed'}});await saving;
 assert.equal(h.detail.trusted,false);assert.equal(h.resourcePendingRef.current.skills,true);assert.match(h.refreshSummary,/撤销信任/);
 await h.toggleSkillTrust(a,false);assert.equal(writes.length,1);
 const read=h.refreshSavedSkillConfiguration();await h.refreshSavedSkillConfiguration();assert.equal(writes.length,2);assert.equal(writes[1].method,'refreshSkills');
 h.openSkillDetail(b);writes[1].resolve({skills:[{...a,trusted:false}],skillErrors:[]});await read;
 assert.equal(h.detail,b);assert.equal(h.resourcePendingRef.current.skills,false);assert.equal(writes.filter(item=>item.method==='setSkillTrusted').length,1);
});

test('committed deletion removes the row and owner detail before projection recovery, without repeating delete',async()=>{
 const {h,writes,confirms}=harness();h.snapshot={skills:[a,b]};h.openSkillDetail(a);const saving=h.deleteSkill(a);confirms[0](true);await tick();writes[0].resolve({committed:true,projection:{status:'error',message:'read failed'}});await saving;
 assert.equal(h.detail,null);assert.equal(h.snapshot.skills.length,1);assert.equal(h.snapshot.skills[0],b);assert.equal(h.resourcePendingRef.current.skills,true);
 const failed=h.refreshSavedSkillConfiguration();writes[1].reject(new Error('read again'));await failed;assert.match(h.refreshError,/read again/);
 const retry=h.refreshSavedSkillConfiguration();writes[2].resolve({skills:[b],skillErrors:[]});await retry;assert.equal(h.resourcePendingRef.current.skills,false);assert.equal(writes.filter(item=>item.method==='removeSkill').length,1);
});
