import assert from 'node:assert/strict';
import test from 'node:test';
import {
  parseReleaseNotes,
  parseReleaseNoteInline,
  countReleaseNoteLines,
  shouldFoldReleaseNotes,
} from '../../web/src/features/update/update-notes.ts';

test('release notes keep headings, lists and paragraphs without the version banner', () => {
  const blocks = parseReleaseNotes([
    '# Pi Studio v0.0.15',
    '',
    '一段总述。',
    '',
    '## 会话排版',
    '',
    '- 第一条',
    '- 第二条',
    '',
    '---',
    '',
    '## 验证',
    '',
    '测试通过。',
  ].join('\n'));
  assert.deepEqual(blocks, [
    { kind: 'paragraph', text: '一段总述。' },
    { kind: 'heading', text: '会话排版', level: 2 },
    { kind: 'list', items: ['第一条', '第二条'] },
    { kind: 'heading', text: '验证', level: 2 },
    { kind: 'paragraph', text: '测试通过。' },
  ]);
});

test('html-degraded bullets and numbered steps both read as lists', () => {
  const blocks = parseReleaseNotes('• 来自 li 的条目\n1. 第一步\n2) 第二步');
  assert.deepEqual(blocks, [{ kind: 'list', items: ['来自 li 的条目', '第一步', '第二步'] }]);
});

test('blank input, non-string input and separator-only input produce nothing', () => {
  assert.deepEqual(parseReleaseNotes(undefined), []);
  assert.deepEqual(parseReleaseNotes('   '), []);
  assert.deepEqual(parseReleaseNotes('---\n***'), []);
  assert.deepEqual(parseReleaseNotes(null), []);
});

test('inline marks split bold and code out of plain text', () => {
  assert.deepEqual(parseReleaseNoteInline('修掉 `align-items` 的 **收缩** 问题'), [
    { kind: 'text', text: '修掉 ' },
    { kind: 'code', text: 'align-items' },
    { kind: 'text', text: ' 的 ' },
    { kind: 'strong', text: '收缩' },
    { kind: 'text', text: ' 问题' },
  ]);
  assert.deepEqual(parseReleaseNoteInline('没有任何标记'), [{ kind: 'text', text: '没有任何标记' }]);
  assert.deepEqual(parseReleaseNoteInline(''), []);
});

test('long notes fold by estimated line count', () => {
  const short = parseReleaseNotes('## 一\n\n- a\n- b\n- c\n\n## 二\n\n- d');
  assert.equal(countReleaseNoteLines(short), 6);
  assert.equal(shouldFoldReleaseNotes(short), false);

  const long = parseReleaseNotes('## 一\n\n- a\n- b\n- c\n- d\n\n## 二\n\n- e\n- f\n- g\n- h');
  assert.equal(countReleaseNoteLines(long), 10);
  assert.equal(shouldFoldReleaseNotes(long), true);
});
