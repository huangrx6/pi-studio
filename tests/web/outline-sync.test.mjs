import assert from 'node:assert/strict';
import test from 'node:test';

import { outlineIndexAt, outlineIndexForMessages } from '../../web/src/features/conversation/outline-sync.mjs';

const items = [
  { sourceIndex: 1, text: '第一问' },
  { sourceIndex: 7, text: '第二问' },
  { sourceIndex: 14, text: '第三问' },
  { sourceIndex: 31, text: '第四问' },
];

test('an entry id resolves to the last question at or before it', () => {
  assert.equal(outlineIndexAt(items, 1), 0);
  assert.equal(outlineIndexAt(items, 5), 0);
  assert.equal(outlineIndexAt(items, 7), 1);
  assert.equal(outlineIndexAt(items, 30), 2);
  assert.equal(outlineIndexAt(items, 999), 3);
  // 早于大纲第一条（例如被摘要吃掉的旧消息）时没有可指向的条目。
  assert.equal(outlineIndexAt(items, 0), -1);
  assert.equal(outlineIndexAt([], 5), -1);
  assert.equal(outlineIndexAt(items, Number.NaN), -1);
});

test('the window resolves through loaded messages, not through the whole transcript', () => {
  const messages = [
    { role: 'user', sourceIndex: 1 },
    { role: 'assistant', sourceIndex: 2 },
    { role: 'user', sourceIndex: 7 },
    { role: 'assistant', sourceIndex: 8 },
  ];
  assert.equal(outlineIndexForMessages(items, messages), 1);
  // 只加载了最新一段窗口：仍然能定位到对应提问。
  assert.equal(outlineIndexForMessages(items, [{ role: 'user', sourceIndex: 14 }]), 2);
  assert.equal(outlineIndexForMessages(items, [{ role: 'assistant', sourceIndex: 20 }]), -1);
  assert.equal(outlineIndexForMessages(items, []), -1);
});
