const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-studio-subagent-state-'));
process.env.PI_STUDIO_USER_DATA = temporary;
process.env.PI_STUDIO_DB = path.join(temporary, 'studio.sqlite');

const {
  resolveSubagentStatus,
} = require('../../electron/capabilities/subagents/index.cjs');

test.after(() => {
  fs.rmSync(temporary, { recursive: true, force: true });
});

test('an owned terminal task overrides a stale live run', () => {
  assert.equal(resolveSubagentStatus({
    taskStatusValue: 'failed',
    liveRunning: true,
    cachedStatus: 'running',
  }), 'failed');
  assert.equal(resolveSubagentStatus({
    taskStatusValue: 'completed',
    liveRunning: true,
    cachedStatus: 'running',
  }), 'completed');
});

test('live work only wins while every task projection is non-terminal', () => {
  assert.equal(resolveSubagentStatus({
    taskStatusValue: 'pending',
    liveRunning: true,
    cachedStatus: 'completed',
  }), 'running');
  assert.equal(resolveSubagentStatus({
    taskStatusValue: 'running',
    liveRunning: false,
    cachedStatus: 'completed',
  }), 'running');
  assert.equal(resolveSubagentStatus({
    taskStatusValue: 'pending',
    liveRunning: false,
    cachedStatus: 'completed',
  }), 'completed');
});

test('a stale pending supervisor request cannot reopen a terminal child', () => {
  assert.equal(resolveSubagentStatus({
    taskStatusValue: 'failed',
    liveRunning: false,
    cachedStatus: 'waiting',
    supervisorPending: 1,
  }), 'failed');
  assert.equal(resolveSubagentStatus({
    taskStatusValue: 'pending',
    liveRunning: false,
    cachedStatus: 'running',
    supervisorPending: 1,
  }), 'waiting');
});

test('the child list exposes only its own still-pending supervisor questions with their reply IDs', async t => {
  const { listSubagentChildren } = require('../../electron/capabilities/subagents/index.cjs');
  const durable = { defineDoc: doc => doc, defineTask: task => task, LiveDoc: {}, UsageDoc: {} };
  const registry = {
    agents: { first: { conversationId: 2 }, second: { conversationId: 3 } },
    supervisorRequests: {
      format: { childConversationId: 2, status: 'pending', question: 'Which format?', createdAt: 1 },
      done: { childConversationId: 2, status: 'replied', question: 'Already answered' },
      locale: { childConversationId: 2, status: 'pending', question: 'Which locale?', createdAt: 2 },
      path: { childConversationId: 3, status: 'pending', question: 'Which path?', createdAt: 3 },
    },
  };
  const conversations = require('../../electron/runtime/conversations.cjs');
  t.mock.method(conversations, 'getConversationHandle', async () => ({ id: 1 }));
  t.mock.method(conversations, 'fullDisplayMessages', async () => []);
  t.mock.method(require('../../electron/runtime/durable-runtime.cjs'), 'getDurableRuntime', async () => ({
    durable,
    harness: {
      snapshot: async doc => doc.kind === 'studio.subagents' ? registry : {},
      conversation: async id => ({ id, agent: async () => ({}) }),
    },
    storage: { scanConversations: async () => ({ items: [] }) },
  }));
  const [first, second] = await listSubagentChildren('parent');
  assert.equal(first.status, 'waiting');
  assert.equal(first.supervisorPending, 2);
  assert.deepEqual(first.supervisorRequests, [
    { id: 'format', question: 'Which format?', createdAt: 1 },
    { id: 'locale', question: 'Which locale?', createdAt: 2 },
  ]);
  assert.deepEqual(second.supervisorRequests, [{ id: 'path', question: 'Which path?', createdAt: 3 }]);
});
