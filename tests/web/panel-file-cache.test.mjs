import assert from 'node:assert/strict';
import test from 'node:test';
import { createPanelFileCache, panelFileKey } from '../../web/src/shell/right-panel/panel-file-cache.ts';

test('same relative paths retain explicit workspace, source and session ownership', () => {
  const path = 'src/main.ts';
  const keys = [
    { source: 'workspace', cwd: '/A', path }, { source: 'workspace', cwd: '/B', path },
    { source: 'diff', sessionId: 'A', path }, { source: 'diff', sessionId: 'B', path },
    { source: 'attachment', sessionId: 'A', path },
  ].map(panelFileKey);
  assert.equal(new Set(keys).size, keys.length);
});

test('closing and reopening a preview invalidates old responses and releases cached payloads', () => {
  const cache = createPanelFileCache(); const old = cache.begin('A');
  cache.drop('A'); const next = cache.begin('A');
  assert.equal(cache.put('A', old, 'old'), false);
  assert.equal(cache.put('A', next, 'new'), true);
  assert.equal(cache.get('A'), 'new'); assert.equal(cache.pending, 0);
  cache.drop('A'); assert.equal(cache.size, 0); assert.equal(cache.get('A'), undefined);
});

test('read completion cannot end a newer request and least-recently-used previews are bounded', () => {
  const cache = createPanelFileCache(2);
  const old = cache.begin('A'), latest = cache.begin('A');
  cache.finish('A', old); assert.equal(cache.current('A', latest), true);
  cache.put('A', latest, 'a'); cache.put('B', cache.begin('B'), 'b');
  assert.equal(cache.get('A'), 'a'); cache.put('C', cache.begin('C'), 'c');
  assert.equal(cache.get('B'), undefined); assert.equal(cache.get('A'), 'a'); assert.equal(cache.size, 2);
  cache.begin('D'); cache.clear(); assert.equal(cache.size, 0); assert.equal(cache.pending, 0);
});

test('byte budget evicts least recently used previews before the eight-item limit', () => {
  const cache = createPanelFileCache(8, 600);
  // Each one-character key + 100-character string is estimated at 282 bytes.
  const put = key => cache.put(key, cache.begin(key), key.repeat(100));
  put('A'); put('B'); assert.equal(cache.estimatedBytes, 564);
  cache.get('A'); put('C');
  assert.equal(cache.get('B'), undefined); assert.equal(cache.size, 2);
  assert.equal(cache.get('A'), 'A'.repeat(100)); assert.equal(cache.estimatedBytes, 564);
});

test('oversized current result remains displayable in full without displacing unrelated cache entries', () => {
  const cache = createPanelFileCache(8, 600);
  const small = { text: 'keep me' }; cache.put('small', cache.begin('small'), small);
  const retainedBytes = cache.estimatedBytes;
  const large = { path: 'large.pdf', preview: { kind: 'pdf', dataUrl: `data:application/pdf;base64,${'A'.repeat(1000)}` } };
  const token = cache.begin('large');
  assert.equal(cache.put('large', token, large), true, 'App uses true to display the accepted result');
  assert.equal(large.preview.dataUrl.length, 1028, 'no truncation of original payload');
  assert.equal(cache.get('large'), undefined); assert.equal(cache.get('small'), small);
  assert.equal(cache.estimatedBytes, retainedBytes); assert.equal(cache.pending, 0);
  const reload = cache.begin('large'); assert.equal(cache.current('large', reload), true, 'uncached tab can read again normally');
});

test('replacement, close and clear release exact estimates; stale results cannot change accounting', () => {
  const cache = createPanelFileCache(8, 1000);
  cache.put('A', cache.begin('A'), 'short'); const first = cache.estimatedBytes;
  cache.put('A', cache.begin('A'), 'longer'); assert.equal(cache.estimatedBytes, first + 2);
  const old = cache.begin('A'); cache.drop('A'); assert.equal(cache.estimatedBytes, 0);
  const next = cache.begin('A'); assert.equal(cache.put('A', old, 'stale'), false); assert.equal(cache.estimatedBytes, 0);
  cache.put('A', next, 'new'); assert.ok(cache.estimatedBytes > 0);
  cache.put('A', cache.begin('A'), 'oversized'.repeat(1000));
  assert.equal(cache.get('A'), undefined, 'oversized replacement must not reveal older cached content');
  assert.equal(cache.estimatedBytes, 0);
  cache.put('B', cache.begin('B'), 'ok'); cache.begin('C'); cache.clear();
  assert.equal(cache.size, 0); assert.equal(cache.pending, 0); assert.equal(cache.estimatedBytes, 0);
});

test('payload estimate uses retained strings including media, not original file length', async () => {
  const { estimatePreviewBytes, PANEL_FILE_CACHE_MAX_BYTES } = await import('../../web/src/shell/right-panel/panel-file-cache.ts');
  const text = { path: 'a.txt', size: 10, text: '中文🙂' };
  assert.equal(estimatePreviewBytes({ ...text, size: 10_000_000_000 }), estimatePreviewBytes(text));
  assert.equal(estimatePreviewBytes({ text: '中文🙂' }) - estimatePreviewBytes({ text: '' }), 8);
  const nested = { text: 'hello', preview: { text: 'hello', dataUrl: 'data:image/png;base64,AAAA' } };
  assert.ok(estimatePreviewBytes(nested) > estimatePreviewBytes({ text: 'hello' }));
  assert.equal(PANEL_FILE_CACHE_MAX_BYTES, 32 * 1024 * 1024);
  const shared = { text: 'same' };
  assert.ok(estimatePreviewBytes({ a: shared, b: shared }) < estimatePreviewBytes({ a: shared, b: { ...shared } }));
});

test('zero budgets accept current results without caching and default count cap remains eight', () => {
  for (const cache of [createPanelFileCache(8, 0), createPanelFileCache(0)]) {
    assert.equal(cache.put('A', cache.begin('A'), 'content'), true);
    assert.equal(cache.size, 0); assert.equal(cache.estimatedBytes, 0);
  }
  const cache = createPanelFileCache();
  for (let i = 0; i < 9; i++) cache.put(String(i), cache.begin(String(i)), 'small');
  assert.equal(cache.size, 8); assert.equal(cache.get('0'), undefined);
});
