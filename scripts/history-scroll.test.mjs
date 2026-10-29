import assert from 'node:assert/strict';
import test from 'node:test';
import {
  HISTORY_LOAD_DISTANCE,
  HISTORY_REARM_DISTANCE,
  resolveHistoryScroll,
} from '../web/src/history-scroll.mjs';

test('history loads once when entering the prefetch distance', () => {
  const first = resolveHistoryScroll({
    scrollTop: HISTORY_LOAD_DISTANCE - 1,
    armed: true,
    hasMore: true,
    loading: false,
    userInitiated: true,
  });
  assert.deepEqual(first, { armed: false, load: true });

  const repeatedAtTop = resolveHistoryScroll({
    scrollTop: 0,
    armed: first.armed,
    hasMore: true,
    loading: false,
    userInitiated: false,
  });
  assert.deepEqual(repeatedAtTop, { armed: false, load: false });
});

test('history only re-arms after moving back into the conversation', () => {
  assert.deepEqual(resolveHistoryScroll({
    scrollTop: HISTORY_REARM_DISTANCE - 1,
    armed: false,
    hasMore: true,
    loading: false,
    userInitiated: true,
  }), { armed: false, load: false });

  assert.deepEqual(resolveHistoryScroll({
    scrollTop: HISTORY_REARM_DISTANCE,
    armed: false,
    hasMore: true,
    loading: false,
    userInitiated: true,
  }), { armed: true, load: false });
});

test('finished or in-flight history never schedules another request', () => {
  assert.deepEqual(resolveHistoryScroll({
    scrollTop: 0,
    armed: true,
    hasMore: false,
    loading: false,
    userInitiated: true,
  }), { armed: false, load: false });

  assert.deepEqual(resolveHistoryScroll({
    scrollTop: 0,
    armed: true,
    hasMore: true,
    loading: true,
    userInitiated: true,
  }), { armed: true, load: false });
});

test('programmatic scroll restoration cannot re-arm pagination', () => {
  assert.deepEqual(resolveHistoryScroll({
    scrollTop: HISTORY_REARM_DISTANCE + 100,
    armed: false,
    hasMore: true,
    loading: false,
    userInitiated: false,
  }), { armed: false, load: false });
});
