const { test } = require('node:test');
const assert = require('node:assert/strict');
const { chatAttachments } = require('../../electron/core/attachment-markers.cjs');

const stored = '/studio/attachments/s/session-a/87292872-5d46-4d6a-8ba1-baacf7933acf-long-message-2026-11-09T11-16-45-454Z.txt';
const marked = {
  name: 'long-message-20261109-1116.txt',
  path: stored,
  bytes: 1834,
  lines: 42,
  kind: 'text',
  mime: 'text/plain',
};

test('marker metadata fills name, size and lines for path-only Durable attachments', () => {
  assert.deepEqual(chatAttachments([stored], [marked]), [marked]);
  // 顺序跟随实际提交的路径，不跟随标记顺序。
  const other = { ...marked, path: '/studio/attachments/s/session-a/87292872-5d46-4d6a-8ba1-baacf7933acf-report.pdf', name: 'report.pdf' };
  assert.deepEqual(chatAttachments([other.path, stored], [marked, other]).map(({ name }) => name), ['report.pdf', 'long-message-20261109-1116.txt']);
});

test('stored fields win over marker metadata; storage uuid prefix never reaches the UI', () => {
  assert.deepEqual(chatAttachments([{ path: stored, name: 'kept.txt' }], [marked]), [{
    name: 'kept.txt',
    path: stored,
    bytes: 1834,
    lines: 42,
    kind: 'text',
    mime: 'text/plain',
  }]);
  const [fallback] = chatAttachments([stored]);
  assert.equal(fallback.name, 'long-message-2026-11-09T11-16-45-454Z.txt');
  assert.equal(fallback.bytes, 0);
  assert.equal(chatAttachments(['C:\\studio\\attachments\\report.pdf'])[0].name, 'report.pdf');
});
