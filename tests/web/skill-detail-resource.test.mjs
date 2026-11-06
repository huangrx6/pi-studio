import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import ts from 'typescript';
import { errorText } from '../../web/src/shared/error-text.ts';

const source = fs.readFileSync(new URL('../../web/src/features/skills/skill-detail-resource.ts', import.meta.url), 'utf8');
const module = { exports: {} };
vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, {
  module, exports: module.exports, require: () => ({ errorText }),
});
const { createSkillDetailResource } = module.exports;
const tick = async () => { await Promise.resolve(); await Promise.resolve(); };
const document = text => ({ path: 'SKILL.md', name: 'SKILL.md', kind: 'text', text, size: text.length, mimeType: 'text/markdown' });
const directory = (path = '') => ({ path, entries: [{ path: 'SKILL.md', name: 'SKILL.md', type: 'file', size: 10 }] });
function harness() {
  const calls = [];
  const api = Object.fromEntries(['files', 'filePreview', 'openWith'].map(method => [method, (...args) => new Promise((resolve, reject) => calls.push({ method, args, resolve, reject }))]));
  const create = baseDir => {
    const state = { changes: [] };
    const resource = createSkillDetailResource({ baseDir, api, onChange(value) { state.current = value; state.changes.push(value); } });
    return { resource, state };
  };
  return { calls, create };
}

test('closed A directory cannot collide with B first read or start an A preview', async () => {
  const { calls, create } = harness(); const a = create('/A');
  const old = a.resource.loadDirectory(''); a.resource.dispose(); const count = a.state.changes.length;
  const b = create('/B'); const current = b.resource.loadDirectory('');
  calls[1].resolve(directory()); await current;
  assert.deepEqual(calls[2].args, ['/B', 'SKILL.md']);
  calls[0].resolve(directory()); await old;
  assert.equal(calls.length, 3); assert.equal(a.state.changes.length, count);
  calls[2].resolve(document('B')); await tick(); assert.equal(b.state.current.file.text, 'B');
});

test('closed and reopened same skill ignores pending preview success and failure', async () => {
  for (const fail of [false, true]) {
    const { calls, create } = harness(); const old = create('/A');
    const reading = old.resource.openFile('SKILL.md'); old.resource.dispose(); const count = old.state.changes.length;
    const next = create('/A'); const current = next.resource.openFile('SKILL.md');
    calls[1].resolve(document('new')); await current;
    if (fail) calls[0].reject(new Error('obsolete')); else calls[0].resolve(document('old'));
    await reading;
    assert.equal(old.state.changes.length, count); assert.equal(next.state.current.file.text, 'new');
    await old.resource.openFile('ignored'); await old.resource.loadDirectory('ignored'); assert.equal(calls.length, 2);
  }
});

test('directory and file errors retry independently without removing the other result or error', async () => {
  const { calls, create } = harness(); const { resource, state } = create('/A');
  let tree = resource.loadDirectory('folder'); let file = resource.openFile('SKILL.md');
  calls[0].reject(new Error('directory failed')); calls[1].resolve(document('keep preview')); await Promise.all([tree, file]);
  assert.equal(state.current.treeError, 'directory failed'); assert.equal(state.current.file.text, 'keep preview');
  file = resource.openFile('error.txt'); calls[2].reject(new Error('file failed')); await file;
  tree = resource.retryDirectory(); assert.equal(state.current.fileError, 'file failed');
  assert.deepEqual(calls[3].args, ['/A', 'folder']); calls[3].resolve(directory('folder')); await tree;
  assert.equal(state.current.fileError, 'file failed'); file = resource.retryFile();
  assert.deepEqual(calls[4].args, ['/A', 'error.txt']); calls[4].resolve(document('retry')); await file;
  assert.equal(state.current.fileError, null); assert.equal(state.current.file.text, 'retry');
});

test('late root listing cannot override a newer directory or automatically replace a chosen file', async () => {
  const { calls, create } = harness(); const { resource, state } = create('/A');
  const root = resource.loadDirectory(''); const tree = resource.loadDirectory('sub');
  calls[1].resolve(directory('sub')); await tree; calls[0].resolve(directory()); await root;
  assert.equal(state.current.treePath, 'sub'); assert.equal(calls.length, 2);
  const refresh = resource.loadDirectory(''); const picked = resource.openFile('chosen.txt');
  calls[2].resolve(directory()); await refresh; assert.equal(calls.length, 4);
  calls[3].resolve(document('chosen')); await picked; assert.equal(state.current.filePath, 'chosen.txt');
});

test('later file selection wins over older file failure and controls loading ownership', async () => {
  const { calls, create } = harness(); const { resource, state } = create('/A');
  const first = resource.openFile('one'); const second = resource.openFile('two');
  calls[0].reject(new Error('old')); await first;
  assert.equal(state.current.fileBusy, true); assert.equal(state.current.fileError, null);
  calls[1].resolve(document('two')); await second; assert.equal(state.current.file.text, 'two'); assert.equal(state.current.fileBusy, false);
});

test('external open keeps original root and ignores errors after selection or dialog changes', async () => {
  const { calls, create } = harness(); const { resource, state } = create('/original');
  let read = resource.openFile('SKILL.md'); const first = document('first'); calls[0].resolve(first); await read;
  const external = resource.openExternal(first);
  assert.equal(calls[1].args[0].cwd, '/original'); assert.equal(calls[1].args[0].path, 'SKILL.md');
  read = resource.openFile('two'); calls[1].reject(new Error('obsolete external error')); await external;
  assert.equal(state.current.externalError, null); const second = document('second'); calls[2].resolve(second); await read;
  await resource.openExternal(first); assert.equal(calls.length, 3);
  const current = resource.openExternal(second); resource.dispose(); const count = state.changes.length;
  calls[3].reject(new Error('closed')); await current; assert.equal(state.changes.length, count);
});
