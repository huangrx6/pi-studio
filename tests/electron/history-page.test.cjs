'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { readHistoryPage } = require('../../electron/runtime/history-page.cjs');

function readEntries(entries) {
  return async (query, limit, cursor) => {
    const ids = entries
      .filter(entry => query.order === 'ascending'
        ? (query.minEntryId === undefined || entry.id >= query.minEntryId)
        : (query.maxEntryId === undefined || entry.id <= query.maxEntryId))
      .sort((a, b) => query.order === 'ascending' ? a.id - b.id : b.id - a.id);
    const start = cursor ? Number(cursor) : 0;
    const items = ids.slice(start, start + limit);
    return { items, next: start + limit < ids.length ? String(start + limit) : undefined };
  };
}

test('history pages keep a fixed message limit and return a position cursor', async () => {
  const entries = Array.from({ length: 10 }, (_, id) => ({ id: id + 1 }));
  const page = await readHistoryPage({
    readEntries: readEntries(entries),
    project: entry => [{ role: 'user', sourceIndex: entry.id }],
    order: 'descending',
    limit: 4,
  });
  assert.deepEqual(page.messages.map(message => message.sourceIndex), [7, 8, 9, 10]);
  assert.equal(page.hasMore, true);
  assert.deepEqual(page.first, { entryId: 7, offset: 0 });
});

test('ascending around a position skips only the requested offset', async () => {
  const entries = Array.from({ length: 4 }, (_, id) => ({ id: id + 1 }));
  const page = await readHistoryPage({
    readEntries: readEntries(entries),
    project: entry => entry.id === 2
      ? [{ role: 'user', sourceIndex: 2 }, { role: 'assistant', sourceIndex: 2 }]
      : [{ role: 'user', sourceIndex: entry.id }],
    order: 'ascending',
    boundary: { entryId: 2, offset: -1 },
    limit: 3,
  });
  assert.deepEqual(page.messages.map(message => message.sourceIndex), [2, 2, 3]);
  assert.equal(page.hasMore, true);
});
