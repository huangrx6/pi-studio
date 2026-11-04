import assert from 'node:assert/strict';
import test from 'node:test';

import { loadFullTranscript, TRANSCRIPT_PAGE_SIZE } from '../../web/src/features/conversation/transcript-load.mjs';

const message = (sourceIndex) => ({ role: 'user', sourceIndex, timestamp: sourceIndex + 1, content: [] });

test('the transcript loads every page and keeps the oldest first', async () => {
  const calls = [];
  const pages = {
    '': { messages: [message(4), message(5)], page: { hasOlder: true, nextCursor: 'page-2' }, messageStart: 4 },
    'page-2': { messages: [message(2), message(3)], page: { hasOlder: true, nextCursor: 'page-3' }, messageStart: 2 },
    'page-3': { messages: [message(0), message(1)], page: { hasOlder: false }, messageStart: 0 },
  };
  const loaded = await loadFullTranscript(async (payload) => {
    calls.push(payload);
    return pages[payload.cursor ?? ''];
  }, 'demo');

  assert.equal(calls.length, 3);
  assert.deepEqual(calls.map((call) => call.limit), [TRANSCRIPT_PAGE_SIZE, TRANSCRIPT_PAGE_SIZE, TRANSCRIPT_PAGE_SIZE]);
  assert.deepEqual(loaded.messages.map((item) => item.sourceIndex), [0, 1, 2, 3, 4, 5]);
  assert.equal(loaded.page.hasOlder, false);
  // 最早一页的起点决定没有大纲数据时提问的序号。
  assert.equal(loaded.messageStart, 0);
});

test('a session that fits one page is loaded exactly once', async () => {
  const calls = [];
  const loaded = await loadFullTranscript(async (payload) => {
    calls.push(payload);
    return { messages: [message(0)], page: { hasOlder: false }, messageStart: 0 };
  }, 'demo');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].cursor, undefined);
  assert.deepEqual(loaded.messages.map((item) => item.sourceIndex), [0]);
});

test('a missing session resolves to undefined instead of looping', async () => {
  let calls = 0;
  const loaded = await loadFullTranscript(async () => { calls += 1; return undefined; }, 'gone');
  assert.equal(loaded, undefined);
  assert.equal(calls, 1);
});

test('a cursor that never ends cannot spin forever', async () => {
  let calls = 0;
  const loaded = await loadFullTranscript(async () => {
    calls += 1;
    return { messages: [message(calls)], page: { hasOlder: true, nextCursor: `cursor-${calls}` }, messageStart: calls };
  }, 'runaway');
  assert.ok(calls <= 64, `guard stops the loop (${calls} calls)`);
  assert.equal(loaded.page.hasOlder, false);
});
