import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import ts from 'typescript';
import { createPanelFileCache, panelFileKey } from '../../web/src/shell/right-panel/panel-file-cache.ts';
const source = fs.readFileSync(new URL('../../web/src/shell/right-panel/useAppWorkbench.ts', import.meta.url), 'utf8');
const tree = ts.createSourceFile('useAppWorkbench.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const names = new Set(['setPanelTabs', 'setActivePanelTabId', 'loadWorkspacePreview', 'loadFileToTab', 'activatePanelTab', 'openFile', 'disposePanelTab', 'closePanelTab', 'loadTree']);
const functions = [];
function visit(node) {
  if (ts.isFunctionDeclaration(node) && names.has(node.name?.text)) functions.push(node.getText(tree));
  else if (ts.isVariableStatement(node)) {
    for (const declaration of node.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name) && names.has(declaration.name.text)) functions.push(node.getText(tree));
    }
  }
  else ts.forEachChild(node, visit);
}
visit(tree); assert.equal(functions.length, names.size);
const code = ts.transpileModule(functions.join('\n') + '\nObject.assign(globalThis, { openFile, activatePanelTab, closePanelTab, loadTree });', { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
function harness() {
  const reads = [], directories = [];
  const h = {
    panelFileKey, fileCacheRef: { current: createPanelFileCache() }, fileReadRef: { current: 0 },
    workspaceRef: { current: '/A' }, sessionRef: { current: { id: 'A', cwd: '/A' } },
    panelTabsRef: { current: [] }, activePanelTabIdRef: { current: '' }, treeRequestRef: { current: 0 },
    filesOpen: true, setPanelTabsState() {}, setActivePanelTabIdState() {},
    setPanelEntered() {}, setPanelSplit() {}, setFileMenuOpen() {}, setFileApps() {},
    setFile(value) { h.file = value; }, setFileBusy(value) { h.busy = value; }, setFileError(value) { h.error = value; },
    setTreePath(value) { h.treePath = value; }, setEntries(value) { h.entries = value; },
    setTreeBusy(value) { h.treeBusy = value; }, setTreeError(value) { h.treeError = value; }, setTreeOwner(value) { h.treeOwner = value; },
    errorText: error => error.message,
    window: { piApi: {
      filePreview(cwd, path) { return new Promise((resolve, reject) => reads.push({ cwd, path, resolve, reject })); },
      files(cwd, path) { return new Promise((resolve, reject) => directories.push({ cwd, path, resolve, reject })); },
    } },
  };
  vm.runInNewContext(code, h);
  const reply = (index, text) => reads[index].resolve({ path: reads[index].path, kind: 'text', size: text.length, text });
  return { h, reads, reply, directories };
}

test('workspace file identity is retained through navigation; late A cannot replace B preview', async () => {
  const { h, reads, reply } = harness();
  const a = h.openFile('same.txt', undefined, 'workspace'); const tabA = h.panelTabsRef.current[0];
  h.workspaceRef.current = '/B'; h.sessionRef.current = { id: 'B', cwd: '/B' };
  const b = h.openFile('same.txt', undefined, 'workspace');
  assert.equal(h.panelTabsRef.current.length, 2);
  reply(1, 'B data'); await b; reply(0, 'A data'); await a;
  assert.equal(h.file.text, 'B data'); assert.equal(h.busy, false);
  h.activatePanelTab(tabA); assert.equal(h.file.text, 'A data'); assert.equal(reads.length, 2);
  assert.equal(tabA.cwd, '/A');
});

test('closing then reopening an in-flight file discards old data without affecting the new request', async () => {
  const { h, reads, reply } = harness();
  const old = h.openFile('same.txt', undefined, 'workspace'); const id = h.activePanelTabIdRef.current;
  h.closePanelTab(id); assert.equal(h.fileCacheRef.current.pending, 0);
  const current = h.openFile('same.txt', undefined, 'workspace');
  reply(0, 'closed data'); await old;
  assert.equal(h.file, null); assert.equal(h.busy, true);
  reply(1, 'new data'); await current; assert.equal(h.file.text, 'new data');
  h.closePanelTab(id); assert.equal(h.fileCacheRef.current.size, 0); assert.equal(h.file, null);
  const reopen = h.openFile('same.txt', undefined, 'workspace'); assert.equal(reads.length, 3);
  reply(2, 'reread'); await reopen;
});

test('inactive file errors never replace a selected preview or its loading state', async () => {
  const { h, reads, reply } = harness();
  const a = h.openFile('a.txt', undefined, 'workspace');
  const b = h.openFile('b.txt', undefined, 'workspace');
  reads[0].reject(new Error('A unavailable')); await a;
  assert.equal(h.error, null); assert.equal(h.busy, true);
  reply(1, 'B'); await b; assert.equal(h.file.text, 'B');
});

test('directory requests are separate from preview state and ignore old scopes and old paths', async () => {
  const { h, directories } = harness();
  const a = h.loadTree('a'); h.workspaceRef.current = '/B'; const b = h.loadTree('b');
  directories[0].resolve({ path: 'a', entries: ['wrong'] }); await a;
  assert.equal(h.treeBusy, true); assert.equal(h.entries.length, 0);
  directories[1].reject(new Error('B directory failed')); await b;
  assert.equal(h.treePath, 'b'); assert.equal(h.entries.length, 0); assert.equal(h.treeError, 'B directory failed');
  assert.equal(h.busy, undefined); assert.equal(h.error, undefined);
  const retry = h.loadTree('b'); directories[2].resolve({ path: 'b', entries: ['right'] }); await retry;
  assert.deepEqual(h.entries, ['right']); assert.equal(h.treeError, null);
});
