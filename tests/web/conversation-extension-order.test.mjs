import assert from 'node:assert/strict';
import test from 'node:test';

import {
  moveConversationExtension,
  orderConversationExtensionItems,
} from '../../web/src/features/conversation/conversation-extension-order.ts';

function item(extensionId, id, sourceOrder) {
  return {
    id: `${extensionId}/${id}`,
    extensionId,
    extensionName: extensionId,
    scope: 'user',
    contributionId: id,
    title: id,
    description: '',
    slot: id === 'summary' ? 'composer.below' : 'tool.view',
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
    orderConversationExtensionItems(items, []).map((entry) => entry.contributionId),
    ['detail', 'summary', 'detail'],
  );
});

test('the configured order takes precedence and newly installed extensions follow it', () => {
  const items = [
    item('user:alpha', 'detail', 0),
    item('user:beta', 'detail', 1),
    item('project:new', 'detail', 2),
    item('user:beta', 'summary', 3),
  ];
  const ordered = orderConversationExtensionItems(items, ['user:beta', 'user:alpha']);
  assert.deepEqual(
    ordered.map(entry => entry.id),
    ['user:beta/detail', 'user:beta/summary', 'user:alpha/detail', 'project:new/detail'],
  );
});

test('a move preserves ranks for extensions from other workspaces', () => {
  const stored = ['user:alpha', 'project:other', 'user:beta'];
  const visible = ['user:alpha', 'user:beta', 'project:new'];
  assert.deepEqual(
    moveConversationExtension(stored, visible, 'user:beta', -1),
    ['user:beta', 'project:other', 'user:alpha', 'project:new'],
  );
  assert.deepEqual(moveConversationExtension(stored, visible, 'user:alpha', -1), stored);
});
