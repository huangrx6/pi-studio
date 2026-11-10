import test from 'node:test';
import assert from 'node:assert/strict';
import { buildTraceSummary } from '../../web/src/features/conversation/trace-model.ts';

const requestPlacement = { byAssistantTurn: new Map(), unansweredByUserTurn: new Map(), pending: [] };
const turns = [
  { kind: 'user', message: { role: 'user', sourceIndex: 40, timestamp: 1000, content: [{ type: 'text', text: '检查模块' }] } },
  { kind: 'assistant', messages: [{ role: 'assistant', sourceIndex: 41, timestamp: 1100, content: [
    { type: 'thinking', thinking: '检查源文件' },
    { type: 'toolCall', id: 'tool-1', name: 'read', arguments: { path: 'src/app.tsx' } },
    { type: 'text', text: '正在检查' },
  ] }] },
];

test('trace includes user and assistant content and uses recorded tool duration and output', () => {
  const toolResults = new Map([['tool-1', { role: 'toolResult', toolCallId: 'tool-1', timestamp: 1400, durationMs: 125, content: [{ type: 'text', text: 'file contents' }] }]]);
  const summary = buildTraceSummary({ turns, toolResults, requestPlacement, turnActive: false });
  assert.deepEqual(new Set(summary.items.map(item => item.kind)), new Set(['input', 'decision', 'tool', 'assistant']));
  const tool = summary.items.find(item => item.kind === 'tool');
  assert.equal(tool.at, 1275);
  assert.equal(tool.endedAt, 1400);
  assert.equal(tool.durationMs, 125);
  assert.equal(tool.result, 'file contents');
  assert.equal(tool.status, 'done');
  assert.equal(summary.items[0].id, 'input:40');
});

test('missing result stays unknown after completion and trace IDs survive loading earlier history', () => {
  const options = { toolResults: new Map(), requestPlacement, turnActive: false };
  const summary = buildTraceSummary({ ...options, turns });
  const tool = summary.items.find(item => item.kind === 'tool');
  assert.equal(tool.status, 'unknown');
  assert.equal(tool.durationMs, undefined);
  assert.equal(tool.endedAt, undefined);
  const expanded = buildTraceSummary({ ...options, turns: [{ kind: 'user', message: { role: 'user', sourceIndex: 0, timestamp: 1, content: [] } }, ...turns] });
  for (const item of summary.items) assert(expanded.items.some(next => next.id === item.id));
});
