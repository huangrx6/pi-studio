import assert from 'node:assert/strict';
import test from 'node:test';
import {
  REFERENCE_GAP,
  extractComposerMentions,
  formatFileReference,
  insertComposerToken,
  normalizeComposerText,
  splitComposerText,
  splitMessageText,
} from '../../web/src/features/conversation/references.ts';

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
    caret: 16,
  });
  assert.deepEqual(insertComposerToken('use@g tail', 3, 5, '@goal.md'), {
    text: `use @goal.md tail`,
    caret: 12,
  });
  assert.deepEqual(insertComposerToken('@src', 0, 4, '@src/App.tsx'), {
    text: '@src/App.tsx ',
    caret: 13,
  });
});
