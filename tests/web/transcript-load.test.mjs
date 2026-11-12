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

test('窗口只取最近一页，并保留补页游标', async () => {
  const { loadTranscriptWindow, TRANSCRIPT_WINDOW_SIZE } = await import('../../web/src/features/conversation/transcript-load.mjs');
  const calls = [];
  const loaded = await loadTranscriptWindow(async (payload) => {
    calls.push(payload);
    return { messages: [message(600), message(601)], page: { hasOlder: true, nextCursor: 'older' }, messageStart: 600 };
  }, 'demo');
  assert.equal(calls.length, 1, '只发一次请求');
  assert.equal(calls[0].limit, TRANSCRIPT_WINDOW_SIZE);
  assert.equal(calls[0].cursor, undefined);
  assert.deepEqual(loaded.messages.map((item) => item.sourceIndex), [600, 601]);
  assert.equal(loaded.page.hasOlder, true);
  assert.equal(loaded.page.nextCursor, 'older');
  assert.equal(loaded.messageStart, 600);
});

test('补页把更早的消息插到前面，并更新游标', async () => {
  const { loadTranscriptWindow, loadOlderTranscript } = await import('../../web/src/features/conversation/transcript-load.mjs');
  const current = await loadTranscriptWindow(async () => ({
    messages: [message(600), message(601)],
    page: { hasOlder: true, nextCursor: 'older' },
    messageStart: 600,
  }), 'demo');
  const calls = [];
  const merged = await loadOlderTranscript(async (payload) => {
    calls.push(payload);
    return { messages: [message(598), message(599)], page: { hasOlder: false }, messageStart: 598 };
  }, 'demo', current);
  assert.equal(calls[0].cursor, 'older');
  assert.deepEqual(merged.messages.map((item) => item.sourceIndex), [598, 599, 600, 601]);
  assert.equal(merged.page.hasOlder, false);
  assert.equal(merged.messageStart, 598, '起点跟着更早的一页走');
});

test('没有更早内容时补页不发请求', async () => {
  const { loadOlderTranscript } = await import('../../web/src/features/conversation/transcript-load.mjs');
  let called = false;
  const quiet = await loadOlderTranscript(async () => { called = true; return undefined; }, 'demo', { messages: [], page: { hasOlder: false } });
  assert.equal(quiet, null);
  assert.equal(called, false);
});

test('固定窗口按轮合并：保留最近的若干轮，并跟随向上加载的旧端', async () => {
  const { mergeTranscriptPage, trimTranscript, TRANSCRIPT_MAX_TURNS } = await import('../../web/src/features/conversation/transcript-load.mjs');
  // 每条消息都是一轮：裁剪单位是「轮」而不是「条」，一轮里的工具输出不会被切断。
  const current = Array.from({ length: 50 }, (_, index) => ({ role: 'user', sourceIndex: index + 51 }));
  const older = Array.from({ length: 50 }, (_, index) => ({ role: 'user', sourceIndex: index + 1 }));
  const merged = mergeTranscriptPage(current, older, 'older');
  assert.equal(merged.length, TRANSCRIPT_MAX_TURNS);
  assert.deepEqual(
    merged.map(item => item.sourceIndex),
    older.slice(0, TRANSCRIPT_MAX_TURNS).map(item => item.sourceIndex),
    '向上加载后窗口滑向更旧的一端',
  );
  assert.equal(trimTranscript([...current, ...older], 'latest').length, TRANSCRIPT_MAX_TURNS);
});
