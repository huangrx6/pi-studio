import assert from 'node:assert/strict';
import test from 'node:test';

const {
  clearBrowserHistory,
  loadBrowserHistory,
  recordBrowserHistoryVisit,
  saveBrowserHistory,
} = await import('../../web/src/features/browser/browser-history.ts');

function memoryStore(seed = {}) {
  const data = { ...seed };
  return {
    getItem(key) { return Object.prototype.hasOwnProperty.call(data, key) ? data[key] : null; },
    setItem(key, value) { data[key] = String(value); },
    removeItem(key) { delete data[key]; },
  };
}

test('records visits newest-first and dedupes by url', () => {
  let entries = [];
  entries = recordBrowserHistoryVisit(entries, { url: 'https://a.test/', title: 'A', visitedAt: 1 });
  entries = recordBrowserHistoryVisit(entries, { url: 'https://b.test/', title: 'B', visitedAt: 2 });
  entries = recordBrowserHistoryVisit(entries, { url: 'https://a.test/', title: 'A2', visitedAt: 3 });
  assert.deepEqual(entries.map((entry) => entry.url), ['https://a.test/', 'https://b.test/']);
  assert.equal(entries[0].title, 'A2');
});

test('ignores blank targets and persists through storage', () => {
  const store = memoryStore();
  let entries = recordBrowserHistoryVisit([], { url: 'about:blank' });
  assert.equal(entries.length, 0);
  entries = recordBrowserHistoryVisit(entries, { url: 'https://docs.test/x', title: 'Docs' });
  saveBrowserHistory(entries, store);
  assert.equal(loadBrowserHistory(store)[0].title, 'Docs');
  assert.deepEqual(clearBrowserHistory(store), []);
  assert.equal(loadBrowserHistory(store).length, 0);
});
