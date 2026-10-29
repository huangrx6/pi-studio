import assert from 'node:assert/strict';
import test from 'node:test';

import {
  eventSaysConversationRunning,
  isConversationTurnActive,
} from '../../web/src/lib/conversation-activity.ts';

test('a conversation stays active after its current model request ends', () => {
  assert.equal(isConversationTurnActive({
    requestRunning: false,
    compacting: false,
    conversationRunning: true,
  }), true);
});

test('a stale local idle flag does not hide an active Durable task', () => {
  assert.equal(eventSaysConversationRunning({ running: true }, false), true);
  assert.equal(eventSaysConversationRunning({ running: false }, true), false);
});

test('older event payloads preserve the caller fallback', () => {
  assert.equal(eventSaysConversationRunning({}, true), true);
  assert.equal(eventSaysConversationRunning(undefined, false), false);
});
