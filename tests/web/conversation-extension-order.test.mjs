import assert from 'node:assert/strict';
import test from 'node:test';

import {
  applyConversationExtensionUiPatch,
  DEFAULT_CONVERSATION_EXTENSION_UI_PREFERENCES,
  hasSessionExtensionOrder,
  normalizeConversationExtensionUiPreferences,
  orderConversationExtensionItems,
} from '../../web/src/lib/conversation-extension-order.ts';

function item(extensionId, id, sourceOrder) {
  return {
    id: `${extensionId}/${id}`,
    extensionId,
    extensionName: extensionId,
    scope: 'user',
    contributionId: id,
    title: id,
    description: '',
    slot: id === 'summary' ? 'conversation.footer' : 'conversation.detail',
    size: id === 'summary' ? 'compact' : 'regular',
    priority: 0,
    sourceOrder,
    content: [{ kind: 'text', text: id }],
  };
}

test('declaration order stays grouped by extension and sourceOrder', () => {
  const items = [
    item('user:alpha', 'detail', 0),
    item('user:beta', 'detail', 1),
    item('user:alpha', 'summary', 2),
  ];
  assert.deepEqual(
    orderConversationExtensionItems(
      items,
      DEFAULT_CONVERSATION_EXTENSION_UI_PREFERENCES,
      'session-a',
    ).map((entry) => entry.contributionId),
    ['detail', 'summary', 'detail'],
  );
});

test('malformed persisted extension preferences fall back to safe defaults', () => {
  assert.deepEqual(
    normalizeConversationExtensionUiPreferences(undefined),
    DEFAULT_CONVERSATION_EXTENSION_UI_PREFERENCES,
  );
  assert.deepEqual(
    normalizeConversationExtensionUiPreferences({
      layout: 'unknown',
      globalOrder: ['kept', 42],
      sessionOrders: {
        session: ['alpha', null],
        invalid: 'not-an-array',
      },
    }),
    {
      version: 1,
      layout: 'grid',
      globalOrder: ['kept'],
      sessionOrders: { session: ['alpha'] },
    },
  );
});

test('global and session ordering are independent and session overrides can be removed', () => {
  const items = [
    item('user:alpha', 'detail', 0),
    item('user:beta', 'detail', 1),
  ];
  let preferences = applyConversationExtensionUiPatch(
    DEFAULT_CONVERSATION_EXTENSION_UI_PREFERENCES,
    { globalOrder: ['user:beta', 'user:alpha'] },
  );
  preferences = applyConversationExtensionUiPatch(preferences, {
    sessionId: 'session-a',
    sessionOrder: ['user:alpha', 'user:beta'],
  });

  assert.deepEqual(
    orderConversationExtensionItems(items, preferences, 'session-b')
      .map((entry) => entry.extensionId),
    ['user:beta', 'user:alpha'],
  );
  assert.deepEqual(
    orderConversationExtensionItems(items, preferences, 'session-a')
      .map((entry) => entry.extensionId),
    ['user:alpha', 'user:beta'],
  );
  assert.equal(hasSessionExtensionOrder(preferences, 'session-a'), true);

  preferences = applyConversationExtensionUiPatch(preferences, {
    sessionId: 'session-a',
    sessionOrder: null,
  });
  assert.equal(hasSessionExtensionOrder(preferences, 'session-a'), false);
  assert.deepEqual(preferences.globalOrder, ['user:beta', 'user:alpha']);
});
