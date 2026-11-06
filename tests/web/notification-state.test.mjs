import assert from 'node:assert/strict';
import test from 'node:test';
import {
  mergeNotification,
  notificationMessagePresentation,
} from '../../web/src/shell/notification-state.ts';

const notice = (overrides = {}) => ({
  id: 'first', title: '操作完成', message: '已保存', tone: 'success',
  createdAt: 10_000, read: true, ...overrides,
});

test('a repeated event keeps identity and original time, updates activity and becomes unread', () => {
  const original = notice();
  const items = Object.freeze([Object.freeze(original)]);
  const incoming = Object.freeze(notice({ id: 'second', createdAt: 30_000 }));
  const result = mergeNotification(items, incoming);
  assert.deepEqual(result, [{ ...original, updatedAt: 30_000, read: false }]);
  assert.equal(original.read, true);
  assert.equal(incoming.id, 'second');
});

test('the merge window follows latest activity and does not combine old or backwards events', () => {
  const original = notice({ updatedAt: 40_000 });
  assert.equal(mergeNotification([original], notice({ id: 'new', createdAt: 70_000 })).length, 1);
  assert.equal(mergeNotification([original], notice({ id: 'new', createdAt: 70_001 })).length, 2);
  assert.equal(mergeNotification([original], notice({ id: 'new', createdAt: 39_999 })).length, 2);
});

test('title, message, tone and conversation must all match', () => {
  const original = notice({ sessionId: 'session-a' });
  for (const change of [{ title: '操作未完成' }, { message: '不同内容' }, { tone: 'error' }, { sessionId: 'session-b' }, { sessionId: undefined }]) {
    const incoming = notice({ id: 'new', sessionId: 'session-a', ...change });
    assert.equal(mergeNotification([original], incoming).length, 2);
  }
});

test('only the most recently updated matching item is moved to the top', () => {
  const older = notice({ id: 'older', createdAt: 1_000 });
  const newest = notice({ id: 'newest', createdAt: 5_000, updatedAt: 15_000 });
  const unrelated = notice({ id: 'unrelated', message: 'other' });
  const result = mergeNotification([older, unrelated, newest], notice({ id: 'incoming', createdAt: 20_000 }));
  assert.deepEqual(result.map((item) => item.id), ['newest', 'older', 'unrelated']);
  assert.equal(result[0].createdAt, 5_000);
});

test('new and repeated events both enforce a fifty-item limit without changing inputs', () => {
  const items = Array.from({ length: 55 }, (_, index) => notice({ id: String(index), message: String(index) }));
  const added = mergeNotification(items, notice({ id: 'new', message: 'new' }));
  assert.equal(added.length, 50);
  assert.equal(added[0].id, 'new');
  assert.equal(added[0].read, false);
  const merged = mergeNotification(items, notice({ id: 'new', message: '54', createdAt: 20_000 }));
  assert.equal(merged.length, 50);
  assert.equal(merged[0].id, '54');
  assert.equal(items.length, 55);
});

test('recoverable actions participate in deduplication and are never silently dropped', () => {
  const action = {
    kind: 'unarchive-session',
    label: '撤销归档',
    pendingLabel: '正在恢复…',
    sessionId: 'session-a',
    hideSessionLink: true,
  };
  const original = notice({ sessionId: 'session-a', action });
  const repeated = notice({
    id: 'repeat',
    createdAt: 20_000,
    sessionId: 'session-a',
    action,
  });
  const merged = mergeNotification([original], repeated);
  assert.equal(merged.length, 1);
  assert.deepEqual(merged[0].action, action);

  assert.equal(
    mergeNotification([original], notice({ id: 'plain', createdAt: 20_000, sessionId: 'session-a' })).length,
    2,
    'a plain notice cannot erase a recoverable action',
  );
  assert.equal(
    mergeNotification([original], notice({
      id: 'other-action',
      createdAt: 20_000,
      sessionId: 'session-a',
      action: { ...action, sessionId: 'session-b' },
    })).length,
    2,
    'actions for different targets stay separate',
  );
});

test('long notification messages keep a compact summary and expose complete details', () => {
  assert.deepEqual(notificationMessagePresentation('  文件已保存  '), {
    summary: '文件已保存',
    details: null,
  });
  assert.deepEqual(notificationMessagePresentation('执行失败\n' + '详细上下文'.repeat(40)), {
    summary: '执行失败',
    details: '执行失败\n' + '详细上下文'.repeat(40),
  });

  const singleLine = '错误'.repeat(120);
  const compact = notificationMessagePresentation(singleLine);
  assert.equal(compact.summary.length, 181);
  assert.match(compact.summary, /…$/);
  assert.equal(compact.details, singleLine);
  assert.deepEqual(notificationMessagePresentation('\n  \r\n'), {
    summary: '操作已完成',
    details: null,
  });
});
