import assert from 'node:assert/strict';
import test from 'node:test';
import { buildThinkingMap, collectActivityEntries } from '../../web/src/features/conversation/thinking-map-model.ts';

test('collectActivityEntries flattens activity segments only', () => {
  const entries = collectActivityEntries([
    { kind: 'text' },
    { kind: 'activity', entries: [{ key: '1', kind: 'thinking', live: false, block: { type: 'thinking', thinking: 'a' } }] },
    { kind: 'activity', entries: [{ key: '2', kind: 'tool', live: false, call: { type: 'toolCall', id: 't1', name: 'bash', arguments: { command: 'ls' } } }] },
    { kind: 'images' },
  ]);
  assert.equal(entries.length, 2);
  assert.equal(entries[0].key, '1');
  assert.equal(entries[1].key, '2');
});

test('buildThinkingMap summarizes thinking and tools with statuses', () => {
  const results = new Map([
    ['ok', { role: 'toolResult', toolCallId: 'ok', content: [{ type: 'text', text: 'done' }], isError: false }],
    ['bad', { role: 'toolResult', toolCallId: 'bad', content: [{ type: 'text', text: 'boom' }], isError: true }],
  ]);
  const model = buildThinkingMap([
    { key: 'th', kind: 'thinking', live: false, block: { type: 'thinking', thinking: '先核对接口，再改 UI。' } },
    { key: 'run', kind: 'tool', live: false, call: { type: 'toolCall', id: 'ok', name: 'bash', arguments: { command: 'pnpm test' } } },
    { key: 'fail', kind: 'tool', live: false, call: { type: 'toolCall', id: 'bad', name: 'read', arguments: { path: '/tmp/a.ts' } } },
    { key: 'live', kind: 'tool', live: true, call: { type: 'toolCall', id: 'pending', name: 'browser_snapshot', arguments: { tabId: '1' } } },
  ], results);

  assert.equal(model.stats.total, 4);
  assert.equal(model.stats.thinking, 1);
  assert.equal(model.stats.tools, 3);
  assert.equal(model.stats.errors, 1);
  assert.equal(model.stats.running, 1);
  assert.equal(model.nodes[0].kind, 'thinking');
  assert.match(model.nodes[0].preview, /先核对接口/);
  assert.equal(model.nodes[1].title, '运行命令');
  assert.equal(model.nodes[1].status, 'done');
  assert.equal(model.nodes[2].status, 'error');
  assert.equal(model.nodes[3].kind, 'browser');
  assert.equal(model.nodes[3].status, 'running');
});

test('empty thinking without live is skipped', () => {
  const model = buildThinkingMap([
    { key: 'empty', kind: 'thinking', live: false, block: { type: 'thinking', thinking: '   ' } },
  ], new Map());
  assert.equal(model.nodes.length, 0);
});
