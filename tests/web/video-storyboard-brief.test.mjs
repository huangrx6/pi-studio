import { test } from 'node:test';
import assert from 'node:assert/strict';
import { briefWriter, settleStoryboardDrafts } from '../../web/src/features/video-storyboard/storyboard-drafts.ts';

test('closing a draft drains changes made during a save and recovers failed fields on reopen', async t => {
  const writes = [];
  const original = globalThis.window;
  t.after(() => { if (original) globalThis.window = original; else delete globalThis.window; });
  globalThis.window = { piApi: { storyboardEditBrief: (workspace, id, patch) =>
    new Promise((resolve, reject) => { writes.push({ workspace, id, patch, resolve, reject }); }) } };
  const writer = briefWriter('w', 'film');
  const detach = writer.subscribe(() => {});
  writer.edit({ title: '第一版', idea: '雨后的婚礼' });
  const flush = writer.flush();
  writer.edit({ title: '开场' });
  detach();
  assert.equal(writes.length, 1);
  writes[0].resolve();
  await Promise.resolve();
  assert.deepEqual(writes[1].patch, { title: '开场' });
  writes[1].reject(new Error('磁盘空间不足'));
  await flush;
  const restored = briefWriter('w', 'film');
  assert.equal(restored.status(), '磁盘空间不足');
  assert.deepEqual(restored.pending(), { title: '开场' });
  const retry = settleStoryboardDrafts('w');
  writes[2].resolve();
  await retry;
  assert.equal(restored.status(), '已保存');
  assert.deepEqual(briefWriter('w', 'film').pending(), {});
});
