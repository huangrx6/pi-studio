import test from 'node:test';
import assert from 'node:assert/strict';
import { cloneRuntimePolicy, createHarnessRequestOwner, guidanceDraft } from '../../web/src/features/harness/harness-state.ts';

test('Harness results cannot cross workspace, newer read/write, or unmount boundaries', () => {
  const owner = createHarnessRequestOwner('/fixture/a');
  const first = owner.begin();
  const write = owner.begin();
  assert.equal(owner.current(first), false);
  assert.equal(owner.current(write), true);
  owner.setScope('/fixture/b');
  assert.equal(owner.current(write), false);
  const next = owner.begin();
  owner.dispose();
  assert.equal(owner.current(next), false);
  owner.activate();
  assert.equal(owner.current(next), false);
  assert.equal(owner.current(owner.begin()), true);
});

test('tool guidance retains an empty editable row and detects collisions without overwriting', () => {
  assert.deepEqual(guidanceDraft([{ key: 1, name: 'renamed-tool', guidance: '' }]), { value: { 'renamed-tool': '' }, error: null });
  assert.match(guidanceDraft([{ key: 1, name: 'read', guidance: 'one' }, { key: 2, name: ' read ', guidance: 'two' }]).error, /已有说明/);
  assert.match(guidanceDraft([{ key: 1, name: ' ', guidance: 'keep me' }]).error, /工具名称/);
});

test('policy draft clones every mutable nested group including long-task limits', () => {
  const policy = { retry: { enabled: true }, compaction: { enabled: true }, longTask: { maxContinuations: 5 } };
  const draft = cloneRuntimePolicy(policy);
  draft.longTask.maxContinuations = 9;
  draft.retry.enabled = false;
  assert.equal(policy.longTask.maxContinuations, 5);
  assert.equal(policy.retry.enabled, true);
});

test('remounted readers wait for a pending global write and later writes remain ordered', async () => {
  const { createHarnessWriteQueue } = await import('../../web/src/features/harness/harness-state.ts');
  const queue = createHarnessWriteQueue();
  const events = [];
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  const first = queue.run(async () => { events.push('first-start'); await held; events.push('first-saved'); });
  const second = queue.run(async () => { events.push('second-saved'); });
  const read = queue.wait().then(() => events.push('read'));
  await Promise.resolve();
  assert.deepEqual(events, ['first-start']);
  release();
  await Promise.all([first, second, read]);
  assert.deepEqual(events, ['first-start', 'first-saved', 'second-saved', 'read']);
});

test('a failed Harness write does not poison later reload or save', async () => {
  const { createHarnessWriteQueue } = await import('../../web/src/features/harness/harness-state.ts');
  const queue = createHarnessWriteQueue();
  await assert.rejects(queue.run(async () => { throw new Error('expected'); }));
  await queue.wait();
  assert.equal(await queue.run(async () => 'saved'), 'saved');
});
