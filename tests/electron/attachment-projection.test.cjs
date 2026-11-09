const { test } = require('node:test');
const assert = require('node:assert/strict');
const { chatAttachments } = require('../../electron/core/attachment-markers.cjs');

test('Durable submitted paths become renderable attachment summaries on reopen', () => {
  const paths = ['/studio/attachments/session/report.txt', 'C:\\studio\\attachments\\report.pdf'];
  const summaries = chatAttachments(paths);
  assert.deepEqual(summaries.map(({ name }) => name), ['report.txt', 'report.pdf']);
  assert.deepEqual(summaries.map(({ path }) => path), paths);
  for (const item of summaries) {
    assert.doesNotThrow(() => item.name.split('.'));
    assert.equal(item.bytes, 0);
    assert.equal(item.lines, 0);
  }
  // Editing and resubmitting must retain every attached path as well.
  assert.deepEqual(chatAttachments(summaries).map(({ path }) => path), paths);
});

test('attachment projection preserves metadata and rejects malformed records without mutating history', () => {
  const valid = { path: '/studio/report.txt', name: 'Original.txt', bytes: 42, lines: 3, kind: 'text', mime: 'text/plain' };
  const incomplete = { path: '/studio/notes.md', name: null, mime: 12, bytes: -1, lines: Infinity };
  assert.deepEqual(chatAttachments([null, 12, {}, '', { path: false }, valid, incomplete]), [valid, {
    path: '/studio/notes.md', name: 'notes.md', bytes: 0, lines: 0, kind: 'file',
  }]);
  assert.equal(incomplete.name, null);
  assert.deepEqual(chatAttachments(undefined), []);
});
