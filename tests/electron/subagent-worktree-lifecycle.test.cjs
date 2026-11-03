const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

test('background worktrees remain active across supervisor waits and queued reporters', async () => {
  const completed = [];
  const original = Module._load;
  Module._load = function load(request, ...args) {
    if (request === './managed-worktrees.cjs') return {
      reactivateManagedWorktree() {},
      completeManagedWorktree: async (id) => { completed.push(id); },
    };
    return original.call(this, request, ...args);
  };
  let createProtocol;
  try { ({ createProtocol } = require('../../electron/services/durable-subagent-protocol.cjs')); }
  finally { Module._load = original; }
  const protocol = createProtocol({ defineDoc: (value) => value, defineTask: (value) => value });
  const state = {
    agents: { child: { reported: [] } },
    supervisorRequests: { question: { childConversationId: 2, status: 'pending' } },
    reporters: {},
  };
  const runtime = {
    conversationId: 1, now: () => 100,
    conversation: async () => ({ submit: async () => ({ wait: async () => ({ status: 'done' }) }) }),
    snapshot: async () => state,
    commit: async (callback) => callback({ doc: async () => state }),
  };
  const reporter = { id: 7, input: { name: 'child', conversationId: 2, worktreeId: 'tree' } };
  await protocol.Reporter.phases.deliver(reporter, runtime, {});
  assert.deepEqual(completed, []);
  state.supervisorRequests.question.status = 'replied';
  state.reporters.next = { name: 'child', active: true, taskId: 8 };
  await protocol.Reporter.phases.deliver(reporter, runtime, {});
  assert.deepEqual(completed, []);
  state.reporters.next.active = false;
  await protocol.Reporter.phases.deliver(reporter, runtime, {});
  assert.deepEqual(completed, ['tree']);
});
