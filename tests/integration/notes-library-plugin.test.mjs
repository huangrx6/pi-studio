import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { activate } from '../../assets/official-plugins/packages/notes-library/extension/extension.mjs';

const primary = '03_Resources/AI/推理笔记.md';
const source = '01 Projects/进展.md';

async function fixture(t) {
  const scratch = await realpath(await mkdtemp(path.join(os.tmpdir(), 'studio-notes-integration-')));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const vault = path.join(scratch, 'notes');
  const profile = path.join(scratch, 'plugin-data');
  const trash = path.join(scratch, 'trash');
  await Promise.all(['03_Resources/AI', '01 Projects'].map(folder => mkdir(path.join(vault, folder), { recursive: true })));
  await Promise.all([profile, trash].map(folder => mkdir(folder)));
  await writeFile(path.join(vault, primary), '# 推理笔记\n\n内容可以跨项目复用。\n');
  await writeFile(path.join(vault, source), '# 进展\n\n[[推理笔记|学习参考]]\n');
  await writeFile(path.join(scratch, 'outside.md'), 'outside vault');
  const native = () => ({
    chooseDirectory: async () => vault,
    trashItem: target => rename(target, path.join(trash, path.basename(target))),
  });
  return { scratch, vault, profile, trash, native };
}

test('the notes plugin binds an existing directory, preserves source files and enforces optimistic writes', async t => {
  const { vault, profile, trash, native } = await fixture(t);
  const active = await activate({ dataDirectory: profile }, native);
  t.after(() => active.cleanup());
  const provider = active.dataSources['library-data'];
  const call = (method, args) => provider.invoke({}, method, args);
  assert.equal(provider.read().viewData.library, null);
  assert.equal(provider.read().viewData.appearance.theme, 'studio');
  const selected = await call('chooseDirectory');
  assert.equal(selected.library.name, 'notes');
  assert.ok(!JSON.stringify(selected).includes(vault));
  const { id: library } = selected.library;
  const original = await call('read', { path: primary, library });
  assert.equal((await call('tree', { library })).sections.resources, '03_Resources');
  assert.equal((await call('backlinks', { path: primary, library }))[0].path, source);
  const initialized = await call('initialize', { library });
  assert.equal(initialized.added, 5);
  const spec = await call('read', { path: initialized.path, library });
  assert.match(spec.text, /知识库规范/);
  await writeFile(path.join(vault, initialized.path), '我的规范');
  await call('initialize', { library });
  assert.equal(await readFile(path.join(vault, initialized.path), 'utf8'), '我的规范');
  assert.equal((await call('search', { query: '跨项目复用', section: 'resources', library })).matches[0].path, primary);
  assert.equal((await call('search', { query: '跨项目复用', section: 'projects', library })).matches.length, 0);

  const draft = { text: '# 我的编辑', revision: original.revision };
  await call('writeDraft', { path: primary, library, ...draft });
  await writeFile(path.join(vault, primary), '# 外部修改');
  const conflict = await call('save', { path: primary, library, ...draft });
  assert.equal(conflict.status, 'conflict');
  assert.equal(conflict.current.text, '# 外部修改');
  assert.deepEqual(await call('readDraft', { path: primary, library }), draft);
  const saved = await call('save', { path: primary, library, text: '# 合并版', revision: conflict.current.revision });
  assert.equal(saved.note.text, '# 合并版');
  assert.equal(await readFile(path.join(vault, primary), 'utf8'), '# 合并版');

  const created = await call('create', { name: '新笔记.md', kind: 'markdown', parent: '00 Inbox', library });
  assert.match(created.note.text, /^---\ntitle: "新笔记"/);
  const moved = await call('move', { path: created.note.path, parent: '03_Resources/AI', name: '考察.md', library });
  await call('trash', { path: moved.path, library });
  assert.match(await readFile(path.join(trash, '考察.md'), 'utf8'), /# 新笔记/);
  await assert.rejects(call('trash', { path: '03_Resources', library }), /PARA/);

  const reopened = await activate({ dataDirectory: profile }, native);
  t.after(() => reopened.cleanup());
  assert.equal(reopened.dataSources['library-data'].read().viewData.library.id, library);
  const tools = reopened.durableExtension.tools;
  const read = tools.find(tool => tool.name === 'notes_library_read');
  const writer = tools.find(tool => tool.name === 'notes_library_write');
  const data = JSON.parse((await read.execute({ path: primary, limit: 3 })).output[0].text);
  assert.equal(data.nextOffset, 3);
  await assert.rejects(writer.execute({ path: primary, text: 'stale', revision: original.revision }), /重新读取/);
  await writer.execute({ path: primary, text: '# AI 更新', revision: data.revision });
  assert.equal(await readFile(path.join(vault, primary), 'utf8'), '# AI 更新');
});

test('knowledge library appearance persists alongside a previously bound directory', async t => {
  const { vault, profile, native } = await fixture(t);
  const config = path.join(profile, 'library.json');
  await writeFile(config, JSON.stringify({ version: 1, root: vault, appearance: { theme: 'github-light', outlineWidth: 232 } }));
  const active = await activate({ dataDirectory: profile }, native);
  t.after(() => active.cleanup());
  const provider = active.dataSources['library-data'];
  const initial = provider.read().viewData;
  assert.equal(initial.library.name, 'notes');
  assert.deepEqual(initial.appearance, { theme: 'sage', outlineWidth: 232 });

  const appearance = patch => provider.invoke({}, 'setAppearance', patch);
  assert.deepEqual(await appearance({ outlineWidth: 0 }), { theme: 'sage', outlineWidth: 180 });
  await assert.rejects(appearance({ theme: 'unknown' }), /主题无效/);
  await assert.rejects(appearance({ outlineWidth: '260' }), /宽度无效/);
  await Promise.all([appearance({ theme: 'graphite' }), appearance({ outlineWidth: 999 })]);
  assert.deepEqual(provider.read().viewData.appearance, { theme: 'graphite', outlineWidth: 400 });
  assert.equal(provider.read().viewData.revision, initial.revision);
  await provider.invoke({}, 'chooseDirectory');

  const reopened = await activate({ dataDirectory: profile }, native);
  t.after(() => reopened.cleanup());
  const restored = reopened.dataSources['library-data'].read().viewData;
  assert.deepEqual(restored.library, initial.library);
  assert.deepEqual(restored.appearance, { theme: 'graphite', outlineWidth: 400 });
});

test('the library refuses traversal and symlinks and resolves nearby HTML assets inside the vault', async t => {
  const { scratch, vault, profile, native } = await fixture(t);
  const active = await activate({ dataDirectory: profile }, native);
  t.after(() => active.cleanup());
  const provider = active.dataSources['library-data'];
  const call = (method, args) => provider.invoke({}, method, args);
  const { library: { id: library } } = await call('chooseDirectory');
  await assert.rejects(call('read', { path: '../outside.md', library }), /隐藏或无效/);
  if (process.platform !== 'win32') {
    await symlink(path.join(scratch, 'outside.md'), path.join(vault, 'link.md'));
    await assert.rejects(call('read', { path: 'link.md', library }), /链接/);
  }
  await writeFile(path.join(vault, '03_Resources', 'style.css'), 'h1 { color: teal }');
  await writeFile(path.join(vault, '03_Resources', 'mark.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
  const from = '03_Resources/AI/article.html';
  assert.match((await call('asset', { from, href: '../style.css', library })).css, /teal/);
  assert.match((await call('asset', { from, href: '../mark.svg', library })).dataUrl, /^data:image\/svg\+xml;base64,/);
  await assert.rejects(call('asset', { from, href: '../../../outside.md', library }), /隐藏或无效/);
  await assert.rejects(call('asset', { from, href: 'https://fixture.invalid/image.png', library }), /资源链接无效/);
  await assert.rejects(call('save', { path: primary, library: 'stale-directory', text: '', revision: null }), /目录已切换/);
});
