import assert from 'node:assert/strict';
import test from 'node:test';
import { buildTurnContent, groupTranscript } from '../../web/src/features/conversation/turn-content.ts';

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

test('old and streaming transcripts pair out-of-order results, keep visible images and deduplicate sources across prose boundaries', () => {
  const text = value => ({ type: 'text', text: value });
  const call = (id, name, args) => ({ type: 'toolCall', id, name, arguments: args });
  const toolResult = (id, value) => ({ role: 'toolResult', toolCallId: id, content: [text(value)] });
  const fetch = (id, url) => call(id, 'web_fetch', { url });
  const incoming = [
    { role: 'user', content: [text('question')] },
    { role: 'assistant', content: [text('intro'), { type: 'thinking', thinking: 'read' }, fetch('a', 'https://example.org/a'), fetch('b', 'https://example.org/b')] },
    toolResult('b', 'page b'),
    toolResult('a', 'page a'),
    { role: 'assistant', content: [text('progress'), call('img', 'generate_image', {}), call('pending', 'subagent', { name: 'worker' })] },
    { role: 'toolResult', toolCallId: 'img', content: [{ type: 'image', mimeType: 'image/png', data: 'AAA' }] },
    { role: 'assistant', content: [text('final answer')] },
  ];
  const { turns, results } = groupTranscript(incoming);
  assert.equal(turns.length, 2);
  const model = buildTurnContent(turns[1].messages, results, true);
  assert.deepEqual(model.segments.map(x => x.kind), ['text', 'activity', 'text', 'activity', 'tool-images', 'activity', 'text']);
  assert.equal(model.segments[1].entries.length, 3);
  assert.equal(model.segments[4].images[0].src, 'data:image/png;base64,AAA');
  assert.equal(model.segments[5].entries[0].live, true);
  assert.equal(model.answerText, 'final answer');
  assert.deepEqual(model.sources.map(s => s.href), ['https://example.org/a']);
});
