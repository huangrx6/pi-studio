import test from 'node:test';
import assert from 'node:assert/strict';
import { createToolWriteCoordinator } from '../../web/src/features/tools/agent-tool-writes.ts';
const draft = { enabled: ['read'], sources: {} };

test('a new editor observes the same global writer and cannot race an unfinished save', async () => {
  const writes = createToolWriteCoordinator();
  let finish;
  const pending = writes.run(draft, () => new Promise(resolve => { finish = resolve; }));
  assert.equal(writes.getSnapshot().pending, true);
  let notifications = 0;
  const unsubscribe = writes.subscribe(() => notifications++);
  await assert.rejects(writes.run(draft, async () => 'second'), /正在保存/);
  finish('saved');
  assert.equal(await pending, 'saved');
  assert.equal(writes.getSnapshot().pending, false);
  assert.equal(notifications, 1);
  unsubscribe();
  assert.equal(await writes.run(draft, async () => 'next'), 'next');
});

test('failed persistence releases the writer so explicit retry can succeed', async () => {
  const writes = createToolWriteCoordinator();
  await assert.rejects(writes.run(draft, async () => { throw new Error('offline'); }), /offline/);
  assert.equal(writes.getSnapshot().pending, false);
  assert.deepEqual(writes.getSnapshot().failure, { draft, message: 'offline' });
  assert.equal(await writes.run(draft, async () => 'recovered'), 'recovered');
  assert.equal(writes.getSnapshot().failure, null);
});
