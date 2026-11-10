import assert from 'node:assert/strict';
import test from 'node:test';
import { conversationActions, filterConversationActions } from '../../web/src/features/conversation/conversation-actions.ts';

const context = { sessionId: 'chat-a', workspace: '/project', running: false, loading: false, hasMessages: true, hasChildren: true, hasExtensions: true };

test('actions explain unavailable contexts and guard a running fork', () => {
  const actions = conversationActions({ ...context, running: true });
  assert.ok(actions.find(action => action.id === 'fork').disabledReason);
  assert.equal(actions.find(action => action.id === 'compare').disabledReason, undefined);
  assert.equal(actions.find(action => action.id === 'goal').disabledReason, undefined);
  const empty = conversationActions({ ...context, sessionId: undefined, workspace: '', hasChildren: false });
  assert.ok(empty.find(action => action.id === 'files').disabledReason);
  assert.ok(empty.find(action => action.id === 'subagents').disabledReason);
  assert.equal(empty.find(action => action.id === 'models').disabledReason, undefined);
});

test('model comparison remains available through the shared action registry', () => {
  const actions = conversationActions(context);
  const compare = actions.find(action => action.id === 'compare');
  assert.equal(compare?.group, 'workspace');
  assert.equal(compare?.disabledReason, undefined);
});

test('extension actions retain only JSON-safe command identities and deduplicate', () => {
  const commands = [
    { source: 'extension', name: 'inspect', commandId: 'ext/inspect', description: 'Inspect project', argumentHint: 'path' },
    { source: 'extension', name: 'duplicate', commandId: 'ext/inspect', description: 'Duplicate' },
    { source: 'skill', name: 'skill', commandId: 'skill/id', description: 'Not a command' },
  ];
  const actions = conversationActions(context, commands).filter(action => action.group === 'extension');
  assert.equal(actions.length, 1);
  assert.deepEqual(actions[0].command, { id: 'ext/inspect', name: 'inspect', argumentHint: 'path' });
  assert.deepEqual(JSON.parse(JSON.stringify(actions)), actions.map(({ disabledReason, ...action }) => (
    disabledReason === undefined ? action : { ...action, disabledReason }
  )));
  assert.equal(filterConversationActions(actions, 'INSPECT project').length, 1);
  assert.equal(filterConversationActions(actions, 'inspect nonexistent').length, 0);
});
