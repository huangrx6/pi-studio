import assert from 'node:assert/strict';
import test from 'node:test';
import {
  REFERENCE_GAP,
  extractComposerMentions,
  formatAgentReference,
  formatCapabilityReference,
  formatFileReference,
  insertComposerToken,
  isFileReferencePath,
  normalizeComposerText,
  readableComposerReferences,
  splitComposerText,
  splitMessageText,
} from '../../web/src/features/conversation/references.ts';

test('role references round-trip as atomic chips alongside files, including escaped names', () => {
  const id = '81a1c938-91b8-4a09-9622-ae1b2ec32ef5';
  const name = '检视 | 100% [A]';
  const role = formatAgentReference({ id, avatarId: 'indigo-bob', name });
  const ref = { kind: 'agent', label: name, profileId: id, avatarId: 'indigo-bob', token: role };
  const file = formatFileReference('docs/' + role + ' (draft).md');
  const text = '请' + role + ' 查看 ' + file + '、@README.md';
  assert.deepEqual(splitComposerText(text, new Set())[1].reference, ref);
  assert.deepEqual(splitMessageText(text)[1].reference, ref);
  assert.deepEqual(extractComposerMentions(text), ['docs/' + role + ' (draft).md', 'README.md']);
  assert.equal(readableComposerReferences(text), '请#' + name + ' 查看 ' + file + '、@README.md');
  const legacy = '@' + role.slice(1);
  assert.equal(splitMessageText(legacy)[0].reference.profileId, id);
  assert.equal(readableComposerReferences(legacy), '@' + name);
});

test('typed capabilities preserve exact identity across drafts, transcript, plain previews and file extraction', () => {
  const skill = formatCapabilityReference({ type: 'skill', id: 'echo#123', name: '同名 | [技能]', source: '插件 · 示例', description: '' });
  const mcp = formatCapabilityReference({ type: 'mcp', id: '["id","server","echo"]', server: '示例', name: 'echo', source: '插件 · 示例', description: '' });
  const plugin = formatCapabilityReference({ type: 'plugin', id: 'studio.excalidraw', name: 'Excalidraw', source: 'Pi Studio', description: '' });
  const path = 'docs/' + skill + '.md';
  const file = formatFileReference(path);
  const text = skill + ' ' + mcp + ' ' + plugin + ' ' + file;
  const references = splitMessageText(text).filter(item => item.kind === 'reference').map(item => item.reference);
  assert.deepEqual(references.map(ref => ref.capabilityId), ['echo#123', '["id","server","echo"]', 'studio.excalidraw', undefined]);
  assert.deepEqual(splitComposerText(text, new Set()).filter(s => s.kind === 'token').map(s => s.reference), references);
  assert.deepEqual(extractComposerMentions(text), [path]);
  assert.equal(readableComposerReferences(text), '$同名 | [技能] $示例/echo $Excalidraw ' + file);
});
test('composer references keep paths with spaces inside one highlighted token', () => {
  const token = formatFileReference('02 Areas/饭撒的发生地/');
  assert.equal(token, '@"02 Areas/饭撒的发生地/"');

  assert.deepEqual(
    splitComposerText(`${token} /skill:pingcode`, new Set()),
    [
      { kind: 'token', text: token, tokenKind: 'file', reference: { kind: 'file', token, label: '饭撒的发生地', location: '02 Areas/饭撒的发生地/' } },
      { kind: 'text', text: ' ' },
      { kind: 'token', text: '/skill:pingcode', tokenKind: 'skill', reference: { kind: 'skill', token: '/skill:pingcode', label: 'pingcode' } },
    ],
  );
});

test('punctuation beside a reference stays in the surrounding text', () => {
  assert.deepEqual(
    extractComposerMentions('看 @README.md、@package.json，还有 @docs/'),
    ['README.md', 'package.json', 'docs/'],
  );
  const parts = splitMessageText('看 @README.md、@package.json，还有 @docs/')
    .map((segment) => segment.kind === 'reference' ? `ref:${segment.reference.location}` : `text:${segment.text}`);
  assert.deepEqual(parts, ['text:看 ', 'ref:README.md', 'text:、', 'ref:package.json', 'text:，还有 ', 'ref:docs/']);
});

test('saved placeholder gaps still parse and normalize on send', () => {
  assert.deepEqual(splitComposerText(`${REFERENCE_GAP}@src/App.tsx next`, new Set()), [
    // 已保存草稿中的占位符仍按普通文本解析，发送时归一为空格。
    { kind: 'text', text: REFERENCE_GAP },
    { kind: 'token', text: '@src/App.tsx', tokenKind: 'file', reference: { kind: 'file', token: '@src/App.tsx', label: 'App.tsx', location: 'src/App.tsx' } },
    { kind: 'text', text: ' next' },
  ]);
  assert.equal(normalizeComposerText(`see${REFERENCE_GAP}@src/App.tsx`), 'see @src/App.tsx');
  assert.equal(normalizeComposerText('no gap here'), 'no gap here');
});

test('quoted file references decode to the actual path for context injection', () => {
  const token = formatFileReference('docs/API "v2" @draft/');

  assert.deepEqual(extractComposerMentions(`Read ${token} before editing.`), [
    'docs/API "v2" @draft/',
  ]);
  assert.deepEqual(splitMessageText(token), [
    {
      kind: 'reference',
      reference: {
        kind: 'file',
        token,
        label: 'API "v2" @draft',
        location: 'docs/API "v2" @draft/',
      },
    },
  ]);
});

test('simple paths remain readable and ordinary email text is not treated as a mention', () => {
  assert.equal(formatFileReference('src/App.tsx'), '@src/App.tsx');
  assert.deepEqual(extractComposerMentions('mail me at name@example.com'), []);
  assert.deepEqual(extractComposerMentions('Inspect @src/App.tsx'), ['src/App.tsx']);
});

test('selected composer tokens gain safe surrounding spacing', () => {
  assert.deepEqual(insertComposerToken('/g', 0, 2, '/goal'), {
    text: '/goal ',
    caret: 6,
  });
  assert.deepEqual(insertComposerToken('/g next', 0, 2, '/goal'), {
    text: '/goal next',
    caret: 5,
  });
  // 插入引用只需要普通分隔空格，图标不再占用原文字符。
  assert.deepEqual(insertComposerToken('Use @src tail', 4, 8, '@src/App.tsx'), {
    text: `Use @src/App.tsx tail`,
    caret: 17,
  });
  assert.deepEqual(insertComposerToken('use@g tail', 3, 5, '@goal.md'), {
    text: `use @goal.md tail`,
    caret: 13,
  });
  assert.deepEqual(insertComposerToken('@src', 0, 4, '@src/App.tsx'), {
    text: '@src/App.tsx ',
    caret: 13,
  });
  const plugin = '$[plugin:studio.excalidraw|Excalidraw]';
  for (const suffix of ['', ' 继续', '继续', '\n下一行']) {
    const { text, caret } = insertComposerToken('$' + suffix, 0, 1, plugin);
    assert.equal(text.slice(0, caret), plugin + ' ');
    assert.equal(text.slice(caret), suffix.replace(/^ /u, ''));
  }
});

test('npm package names stay plain text instead of file chips', () => {
  const sample = "Install @file-viewer @renderer-pdf and @babel/core; see @react's plugin and web/node_modules/@file-viewer.";
  const segments = splitMessageText(sample);
  assert.equal(segments.some((segment) => segment.kind === 'reference'), false);
  assert.equal(segments.map((segment) => segment.kind === 'text' ? segment.text : '').join(''), sample);
  assert.deepEqual(extractComposerMentions(sample), []);

  const mixed = splitComposerText('use @file-viewer with @src/App.tsx', new Set());
  assert.deepEqual(
    mixed.map((segment) => segment.kind === 'token' ? `token:${segment.text}` : `text:${segment.text}`),
    ['text:use @file-viewer with ', 'token:@src/App.tsx'],
  );
  assert.deepEqual(extractComposerMentions('use @file-viewer with @src/App.tsx'), ['src/App.tsx']);
});

test('real file paths still become reference chips', () => {
  assert.equal(isFileReferencePath('src/App.tsx'), true);
  assert.equal(isFileReferencePath('file-viewer'), false);
  assert.equal(isFileReferencePath('babel/core'), false);
  assert.equal(isFileReferencePath('docs/'), true);
  assert.equal(isFileReferencePath('Dockerfile'), true);
  assert.equal(isFileReferencePath('package.json'), true);
  const parts = splitMessageText('Open @src/App.tsx and @docs/ then @Dockerfile')
    .map((segment) => segment.kind === 'reference' ? `ref:${segment.reference.location}` : `text:${segment.text}`);
  assert.deepEqual(parts, [
    'text:Open ',
    'ref:src/App.tsx',
    'text: and ',
    'ref:docs/',
    'text: then ',
    'ref:Dockerfile',
  ]);
});

