import assert from 'node:assert/strict';
import test from 'node:test';
import { createEmptyModelSelection } from '../../web/src/types/model-types.ts';
import {
  loadTemporaryRecord, peekTemporary, prepareTemporaryHistory,
  retainTemporaryCanvas, sendTemporary, temporaryState, updateTemporary,
} from '../../web/src/features/conversation/temporary-chat-store.ts';

const selection = {...createEmptyModelSelection(), modelRef: 'demo/model'};
const stored = {
  modelRef: 'demo/old', thinkingLevel: 'high',
  messages: [{role: 'user', timestamp: 12, content: [{type: 'text', text: '第一条消息'}]}],
};

test('restoring temporary history can retry and display messages when the saved model is unavailable', async () => {
  const id = 'retry-history';
  let failRead = true;
  globalThis.window = { piApi: {
    onTemporary: () => () => {},
    temporaryRead: async () => {
      if (failRead) throw Error('读取失败');
      return stored;
    },
    temporaryModel: async () => { throw Error('模型已移除'); },
    temporaryClose: async () => {},
  }};
  const leave = retainTemporaryCanvas(id);
  prepareTemporaryHistory(id);
  temporaryState(id, selection);
  updateTemporary(id, {draft: '恢复期间的发送请求'});
  await sendTemporary(id);
  assert.equal(peekTemporary(id).messages.length, 0);
  await loadTemporaryRecord(id);
  assert.equal(peekTemporary(id).historyStatus, 'failed');
  failRead = false;
  updateTemporary(id, {historyStatus:'loading'});
  await loadTemporaryRecord(id);
  const chat = peekTemporary(id);
  assert.equal(chat.historyStatus, 'ready');
  assert.deepEqual(chat.messages, stored.messages);
  assert.equal(chat.selection.modelRef, stored.modelRef);
  assert.equal(chat.selection.unavailable, true);
  updateTemporary(id, {draft: ''});
  leave();
});

test('leaving the conversation keeps a running reply alive until it finishes', async () => {
  const id = 'shared-view';
  const closed = [];
  const reply = Promise.withResolvers();
  globalThis.window = { piApi: {
    onTemporary: () => () => {},
    temporaryPrompt: () => reply.promise,
    temporaryClose: async id => { closed.push(id); },
  }};
  const leave = retainTemporaryCanvas(id);
  temporaryState(id, selection);
  updateTemporary(id, {draft: '请继续'});
  const sending = sendTemporary(id);
  assert.equal(peekTemporary(id).busy, true);
  leave();
  await Promise.resolve();
  assert.deepEqual(closed, []);
  reply.resolve({ok: true});
  await sending;
  assert.deepEqual(closed, [id]);
  assert.equal(peekTemporary(id), undefined);
});

test('a late read from a closed view cannot overwrite a reopened chat', async () => {
  const id = 'late-read';
  const pending = Promise.withResolvers();
  globalThis.window = { piApi: {
    onTemporary: () => () => {},
    temporaryRead: () => pending.promise,
    temporaryModel: async () => selection,
    temporaryClose: async () => {},
  }};
  const leave = retainTemporaryCanvas(id);
  prepareTemporaryHistory(id);
  temporaryState(id, selection);
  const reading = loadTemporaryRecord(id);
  leave();
  await Promise.resolve();
  const leaveAgain = retainTemporaryCanvas(id);
  temporaryState(id, selection);
  pending.resolve(stored);
  await reading;
  assert.deepEqual(peekTemporary(id).messages, []);
  leaveAgain();
});
