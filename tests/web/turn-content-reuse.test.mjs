import assert from 'node:assert/strict';
import test from 'node:test';
import { buildTurnContent } from '../../web/src/features/conversation/turn-content.ts';

function assistant(content) {
  return { role: 'assistant', content, timestamp: 1 };
}

test('streaming text growth reuses finished activity segment identity', () => {
  const tool = { type: 'toolCall', id: 'c1', name: 'bash', arguments: { command: 'ls' } };
  const first = buildTurnContent([
    assistant([tool, { type: 'text', text: 'Hello' }]),
  ], new Map([['c1', { role: 'toolResult', toolCallId: 'c1', content: [{ type: 'text', text: 'ok' }] }]]), true);

  const second = buildTurnContent([
    assistant([tool, { type: 'text', text: 'Hello world' }]),
  ], new Map([['c1', { role: 'toolResult', toolCallId: 'c1', content: [{ type: 'text', text: 'ok' }] }]]), true, first);

  assert.equal(second.segments.length, first.segments.length);
  assert.equal(second.segments[0], first.segments[0]);
  assert.notEqual(second.segments.at(-1), first.segments.at(-1));
  assert.equal(second.segments.at(-1).text, 'Hello world');
});

test('unchanged live turn returns the same built object', () => {
  const messages = [assistant([{ type: 'text', text: 'stable' }])];
  const results = new Map();
  const first = buildTurnContent(messages, results, true);
  const second = buildTurnContent(messages, results, true, first);
  assert.equal(second, first);
});
