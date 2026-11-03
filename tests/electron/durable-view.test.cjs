'use strict';

/**
 * 投影层契约测试：`ConversationView` → Studio IPC 事件。
 *
 * 用手写 fixture 而不是真实 Harness，这样测试与 Durable 版本无关，升级时
 * 不需要跟着改；真实端到端另见 tests/integration/durable-live-projection-loop.test.mjs。
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const view = require('../../electron/runtime/view.cjs');

/** 造一个最小可用的 ConversationView。 */
function makeView({ entries = [], docs = {} } = {}) {
  return { conversation: { id: 1 }, entries, docs };
}

function liveDoc(live) {
  return { docs: { 'pi.live': live } };
}

test('liveFromView 把缺失的文档补成稳定默认值', () => {
  const live = view.liveFromView(makeView());
  assert.deepEqual(live.run, undefined);
  assert.deepEqual(live.generation, undefined);
  assert.deepEqual(live.tools, []);
  assert.deepEqual(live.nestedTools, []);
  assert.deepEqual(live.compactions, []);
  assert.deepEqual(live.inbox, []);
  assert.deepEqual(live.agent, {});
  assert.equal(live.usage, undefined);
  assert.equal(live.runFailure, undefined);
});

test('liveFromView 读取四个会话文档', () => {
  const live = view.liveFromView(makeView({
    docs: {
      'pi.live': { run: { taskId: 7, inputs: [3], turns: 1 }, tools: [{ callId: 'a' }] },
      'pi.inbox': { items: [{ id: 'i1' }] },
      'pi.agent': { model: { provider: 'x', modelId: 'y' } },
      'pi.usage': { models: {}, tools: {} },
    },
  }));
  assert.equal(live.run.taskId, 7);
  assert.deepEqual(live.tools, [{ callId: 'a' }]);
  assert.deepEqual(live.inbox, [{ id: 'i1' }]);
  assert.equal(live.agent.model.modelId, 'y');
  assert.deepEqual(live.usage, { models: {}, tools: {} });
});

test('运行开始与结束各产生一次事件', () => {
  const idle = view.liveFromView(makeView(liveDoc({})));
  const running = view.liveFromView(makeView(liveDoc({ run: { taskId: 1, inputs: ['s1'], turns: 0 } })));

  assert.deepEqual(view.diffLive(idle, running), [{
    type: 'run.started',
    payload: { inputs: ['s1'] },
  }]);

  assert.deepEqual(view.diffLive(running, idle), [{
    type: 'run.completed',
    payload: { inputs: ['s1'] },
  }]);
});

test('流式回答只在消息引用变化时发一次', () => {
  const first = { role: 'assistant', content: [{ type: 'text', text: 'a' }] };
  const second = { role: 'assistant', content: [{ type: 'text', text: 'ab' }] };

  const before = view.liveFromView(makeView(liveDoc({ generation: { attempt: 1, message: first } })));
  const same = view.liveFromView(makeView(liveDoc({ generation: { attempt: 1, message: first } })));
  const grown = view.liveFromView(makeView(liveDoc({ generation: { attempt: 1, message: second } })));

  assert.deepEqual(view.diffLive(before, same), []);
  assert.deepEqual(view.diffLive(same, grown), [{
    type: 'assistant.updated',
    payload: { message: second },
  }]);
});

test('重试状态出现与消失映射为重试事件', () => {
  const plain = view.liveFromView(makeView(liveDoc({ generation: { attempt: 2 } })));
  const retrying = view.liveFromView(makeView(liveDoc({
    generation: { attempt: 2, retry: { at: 100, error: 'boom' } },
  })));

  assert.deepEqual(view.diffLive(plain, retrying), [{
    type: 'retry.updated',
    payload: { active: true, attempt: 2, at: 100, errorMessage: 'boom' },
  }]);
  assert.deepEqual(view.diffLive(retrying, plain), [{
    type: 'retry.updated',
    payload: { active: false, attempt: 2 },
  }]);
});

test('工具 slot 的 started / updated / completed 依次产出', () => {
  const slot = (overrides) => ({
    callId: 'call-1',
    name: 'bash',
    status: 'pending',
    ...overrides,
  });
  const base = view.liveFromView(makeView(liveDoc({ tools: [] })));
  const pending = view.liveFromView(makeView(liveDoc({ tools: [slot({})] })));
  const running = view.liveFromView(makeView(liveDoc({
    tools: [slot({ status: 'running', taskId: 9, output: 'half' })],
  })));
  const done = view.liveFromView(makeView(liveDoc({
    tools: [slot({ status: 'done', taskId: 9, entry: 42 })],
  })));
  const unchanged = view.liveFromView(makeView(liveDoc({
    tools: [slot({ status: 'done', taskId: 9, entry: 42 })],
  })));

  assert.deepEqual(view.diffLive(base, pending).map((change) => change.type), ['tool.execution.started']);
  assert.deepEqual(view.diffLive(pending, running).map((change) => change.type), ['tool.execution.updated']);
  assert.deepEqual(view.diffLive(running, done).map((change) => change.type), ['tool.execution.completed']);
  assert.deepEqual(view.diffLive(done, unchanged), []);
});

test('压缩把 trigger 映射回 IPC 的 reason，失败时带上错误', () => {
  const status = { taskId: 5, trigger: 'threshold', blocking: true, attempt: 1 };
  const idle = view.liveFromView(makeView(liveDoc({})));
  const compacting = view.liveFromView(makeView(liveDoc({ compactions: [status] })));
  const failed = view.liveFromView(makeView(liveDoc({
    compactionFailure: { taskId: 5, trigger: 'threshold', error: 'context overflow' },
  })));

  assert.deepEqual(view.diffLive(idle, compacting), [{
    type: 'compaction.started',
    payload: { taskId: 5, reason: 'threshold', blocking: true, attempt: 1, retry: undefined },
  }]);
  assert.deepEqual(view.diffLive(compacting, failed), [{
    type: 'compaction.completed',
    payload: { taskId: 5, reason: 'threshold', error: 'context overflow' },
  }]);
});

test('inbox / agent / usage 变化各发一次，未变化不发', () => {
  const base = view.liveFromView(makeView({
    docs: {
      'pi.live': {},
      'pi.inbox': { items: [] },
      'pi.agent': { model: { provider: 'p', modelId: 'm' } },
      'pi.usage': { models: { p: 1 }, tools: {} },
    },
  }));
  const next = view.liveFromView(makeView({
    docs: {
      'pi.live': {},
      'pi.inbox': { items: [{ id: 'q' }] },
      'pi.agent': { model: { provider: 'p', modelId: 'm2' } },
      'pi.usage': { models: { p: 2 }, tools: {} },
    },
  }));

  assert.deepEqual(view.diffLive(base, next).map((change) => change.type), [
    'inbox.updated',
    'agent.updated',
    'usage.updated',
  ]);
  assert.deepEqual(view.diffLive(next, next), []);
});

test('runFailure 映射为 run.failed 并保留 reason', () => {
  const failed = view.liveFromView(makeView(liveDoc({
    runFailure: {
      taskId: 12,
      inputs: ['s1'],
      reason: 'turn_limit',
      detail: '3 turns',
    },
  })));
  const idle = view.liveFromView(makeView(liveDoc({})));

  assert.deepEqual(view.diffLive(idle, failed), [{
    type: 'run.failed',
    payload: {
      taskId: '12',
      kind: 'generation',
      message: '3 turns',
      reason: 'turn_limit',
      detail: '3 turns',
    },
  }]);

  // 同一次失败不会被重复通知
  assert.deepEqual(view.diffLive(failed, failed), []);
});

test('没有上一份快照时不产出增量事件', () => {
  const next = view.liveFromView(makeView(liveDoc({ run: { taskId: 1, inputs: [] } })));
  assert.deepEqual(view.diffLive(undefined, next), []);
});

test('窗口裁剪不会重复发 entry', () => {
  const known = view.seedEntryIds([{ id: 3 }, { id: 4 }]);
  assert.deepEqual(view.appendedEntries(known, [{ id: 3 }, { id: 4 }]), []);
  assert.deepEqual(
    view.appendedEntries(known, [{ id: 4 }, { id: 5 }, { id: 6 }]).map((entry) => entry.id),
    [5, 6],
  );
});

test('根替换不会重发整段历史', () => {
  const known = view.seedEntryIds([{ id: 10 }, { id: 11 }]);
  // 折叠溢出后视图整体替换，窗口重新从最新 50 条开始
  const replaced = [{ id: 1 }, { id: 2 }, { id: 10 }, { id: 11 }, { id: 12 }];
  assert.deepEqual(
    view.appendedEntries(known, replaced).map((entry) => entry.id),
    [1, 2, 12],
  );
});

test('首帧 seed 之后不会把已有历史当成新增', () => {
  const entries = [{ id: 1 }, { id: 2 }, { id: 3 }];
  const known = view.seedEntryIds(entries);
  assert.deepEqual(view.appendedEntries(known, entries), []);
});
