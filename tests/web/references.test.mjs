import assert from 'node:assert/strict';
import test from 'node:test';
import {
  extractComposerMentions,
  formatFileReference,
  insertComposerToken,
  splitComposerText,
  splitMessageText,
} from '../../web/src/lib/references.ts';

test('composer references keep paths with spaces inside one highlighted token', () => {
  const token = formatFileReference('02 Areas/饭撒的发生地/');
  assert.equal(token, '@"02 Areas/饭撒的发生地/"');

  assert.deepEqual(
    splitComposerText(`${token} /skill:pingcode`, new Set()),
    [
      { kind: 'token', text: token, tokenKind: 'file' },
      { kind: 'text', text: ' ' },
      { kind: 'token', text: '/skill:pingcode', tokenKind: 'skill' },
    ],
  );
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
  assert.deepEqual(insertComposerToken('Use @src tail', 4, 8, '@src/App.tsx'), {
    text: 'Use @src/App.tsx tail',
    caret: 16,
  });
  assert.deepEqual(insertComposerToken('use@g tail', 3, 5, '@goal.md'), {
    text: 'use @goal.md tail',
    caret: 12,
  });
});
