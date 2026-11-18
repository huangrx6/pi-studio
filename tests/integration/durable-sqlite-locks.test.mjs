import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context';
import { StorageRequestError } from '@earendil-works/pi-durable';
import { createStorageConformance } from '@earendil-works/pi-durable/testing';
import { openDurableStorage } from '../../electron/main/runtime/durable-storage.cjs';

// Exercise the same upstream contract as the SQLite driver across the new message boundary.
for (const scenario of createStorageConformance({
  assertions: {
    ok: assert.ok, strictEqual: assert.strictEqual, deepEqual: assert.deepStrictEqual,
    partialDeepEqual: assert.partialDeepStrictEqual,
    greaterThan: (actual, expected) => assert.ok(actual > expected),
    rejects: (promise, text) => assert.rejects(promise, error => error.message.includes(text)),
  },
  async withStorage(run) {
    const storage = await openDurableStorage(':memory:', { prefix: 'durable_' });
    try { await run(storage); } finally { await storage.close(context); }
  },
})) {
  test('Durable SQLite worker: ' + scenario.name, scenario.run);
}

test('Durable commits while the Studio main thread contends for the same WAL, retaining receipts and IDs across reopen', async t => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'studio-storage-lock-'));
  const filename = path.join(directory, 'studio.sqlite');
  const studio = new DatabaseSync(filename);
  studio.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=2000; CREATE TABLE projection(id INTEGER)');
  const open = () => openDurableStorage(filename, { prefix: 'durable_', busyTimeoutMs: 1000 });
  let storage = await open();
  t.after(async () => { await storage.close(context); studio.close(); rmSync(directory, { recursive: true, force: true }); });
  const batch = id => [{ type: 'conversation', value: { id } }];
  const ids = await Promise.all([storage.mintId(), storage.mintId()]);
  const receipts = [];
  studio.exec('BEGIN IMMEDIATE; INSERT INTO projection VALUES(1)');
  // A synchronous busy handler on the original shared thread prevents this timer from releasing the lock.
  const release = setTimeout(() => studio.exec('COMMIT'), 50);
  try {
    const result = await Promise.all(ids.map(id => storage.commit([batch(id)], (index, seq) => receipts.push([index, seq]), context)));
    assert.deepEqual(result, [{ stored: 1 }, { stored: 1 }]);
  } finally { clearTimeout(release); if (studio.isTransaction) studio.exec('ROLLBACK'); }
  assert.deepEqual(receipts.map(([index]) => index), [0, 0]);
  assert.ok(receipts[1][1] > receipts[0][1]);

  const next = await storage.mintId();
  const partial = await storage.commit([batch(next), batch(ids[0])], (index, seq) => receipts.push([index, seq]), context);
  assert.equal(partial.stored, 1);
  assert.ok(partial.refused);
  assert.equal(receipts.length, 3);
  await assert.rejects(storage.scanEntries({ conversationId: 99999, order: 'ascending' }, 1, undefined, context), StorageRequestError);

  await storage.close(context);
  await assert.rejects(storage.mintId(), /closed/);
  storage = await open();
  assert.deepEqual(await storage.conversation(ids[1], context), { id: ids[1] });
  assert.ok(await storage.mintId() > next);
  assert.equal(studio.prepare('SELECT count(*) AS n FROM projection').get().n, 1);
});
