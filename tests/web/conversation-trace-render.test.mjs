import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';
import vm from 'node:vm';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';
import * as content from '../../web/src/features/conversation/turn-content.ts';
import * as messageContent from '../../web/src/features/conversation/message-content.ts';
import * as fileChanges from '../../web/src/features/conversation/file-changes.ts';
import * as follow from '../../web/src/features/conversation/chat-scroll.ts';

const require = createRequire(import.meta.url);
function component(name, imports) {
  const source = fs.readFileSync(new URL('../../web/src/features/conversation/' + name + '.tsx', import.meta.url), 'utf8');
  const compiled = ts.transpileModule(source, {
    compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const context = { exports: {}, require: id => imports[id] ?? require(id) };
  vm.runInNewContext(compiled, context, { filename: name + '.tsx' });
  return context.exports;
}
// Render the production components with React. Only visual leaves which need the
// browser or a stylesheet loader are substituted; desktop QA exercises those leaves.
let markdownRenders = 0;
const summary = component('ActivitySummary', {
  '../../shared/FileKindIcon': { FileKindIcon: () => null },
  './turn-content': content, './file-changes': fileChanges,
});
const details = component('ActivityDetails', {
  '../../shared/Markdown': { Markdown: ({ children }) => { markdownRenders++; return React.createElement('p', null, children); } },
  './message-content': messageContent, './chat-scroll': follow,
});
const { TurnActivity } = component('TurnActivity', {
  './ActivityDetails': details, './ActivitySummary': summary,
  '../../shared/LoadingState': { LoadingIndicator: () => null },
  './ConversationImageGallery': { ConversationImageGallery: () => null },
});
const tool = (id, name, args = {}) => ({ kind: 'tool', key: id, live: false, call: { type: 'toolCall', id, name, arguments: args } });
const thinking = (key, value, redacted = false) => ({ kind: 'thinking', key, live: false, block: { type: 'thinking', thinking: value, redacted } });
const text = value => ({ type: 'text', text: value });
const result = (value, isError = false) => ({ role: 'toolResult', content: [text(value)], isError });
const render = (entries, results = new Map(), overrides = {}) => renderToStaticMarkup(React.createElement(TurnActivity, {
  entries, results, live: false, active: true, policy: 'after-answer', density: 'standard', ...overrides,
}));
const detailed = { policy: 'keep-open', density: 'detailed' };

test('a single closed tool occupies one row and does not read or serialize detailed output', () => {
  let serializations = 0, outputReads = 0;
  const entry = tool('call', 'custom', { toJSON() { serializations++; return { payload: 'full arguments' }; } });
  const results = new Map([['call', { content: [
    { type: 'text', get text() { outputReads++; return 'full output'; } },
    { type: 'image', mimeType: 'image/png', data: 'test' },
  ] }]]);
  const closed = render([entry], results);
  assert.equal(serializations, 0);
  assert.equal(outputReads, 0);
  assert.doesNotMatch(closed, /turn-trace-toggle|activity-tool-body|tool-result-images/);
  assert.match(closed, /aria-description="已完成"/);
  const open = render([entry], results, detailed);
  assert.equal(serializations, 1);
  assert.equal(outputReads, 1);
  assert.match(open, /full arguments/);
  assert.match(open, /full output/);
});

test('a failed command shows status once and exposes the error before the complete command', () => {
  const entry = tool('call', 'bash', { command: 'git status --short', timeout: 30 });
  const results = new Map([['call', result('checkout missing', true)]]);
  const closed = render([entry], results);
  assert.equal(closed.split('git status --short').length, 2);
  assert.equal(closed.split('失败').length, 2);
  assert.doesNotMatch(closed, /checkout missing/);
  const open = render([entry], results, detailed);
  assert.ok(open.indexOf('checkout missing') < open.indexOf('git status --short'));
  assert.equal(open.split('git status --short').length, 2);
  assert.match(open, /timeout/);
  assert.match(render([{ ...entry, live: true }], new Map(), { live: true }), /执行中/);
  assert.match(render([entry]), /未完成/);
});

test('thinking renders Markdown only when opened and never exposes redacted text', () => {
  const entry = thinking('think', 'full thinking');
  const before = markdownRenders;
  assert.match(render([entry]), /full thinking/);
  assert.equal(markdownRenders, before);
  const expanded = render([entry], new Map(), detailed);
  assert.equal(expanded.split('full thinking').length, 2);
  assert.equal(markdownRenders, before + 1);
  for (const preferences of [{}, detailed]) {
    assert.doesNotMatch(render([thinking('hidden', 'redacted data', true)], new Map(), preferences), /redacted data/);
  }
  assert.equal(markdownRenders, before + 1);
});

test('long mixed operations collapse into one disclosure, with failures visible before expanding', () => {
  const entries = [thinking('t', 'first thought'), tool('a', 'read', { path: 'README.md' }), tool('b', 'bg_wait', { name: 'child-a' })];
  const results = new Map([['a', result('missing file', true)], ['b', result('child answer')]]);
  const closed = render(entries, results);
  assert.match(closed, /执行过程/);
  assert.match(closed, /2 次工具调用 · 1 次思考/);
  assert.match(closed, /失败/);
  assert.doesNotMatch(closed, /<details|first thought|missing file/);
  for (const prefs of [{ policy: 'keep-open' }, { policy: 'manual' }, { live: true }]) {
    const open = render(entries, results, prefs);
    assert.equal(open.split('<details').length - 1, 3);
    assert.match(open, /等待子智能体/);
    assert.match(open, /child-a/);
  }
});

test('live groups keep the newest steps, failed steps and unfinished parallel calls visible', () => {
  const entries = Array.from({ length: 8 }, (_, i) => tool('id' + i, 'custom', { name: 'entry' + i }));
  entries[0].live = true;
  const results = new Map(entries.slice(1).map((entry, i) => [entry.key, result('done', i === 1)]));
  const open = render(entries, results, { live: true });
  for (const i of [0, 2, 5, 6, 7]) assert.ok(open.includes('entry' + i));
  assert.doesNotMatch(open, /entry[134]/);
  assert.match(open, /查看此前 3 个步骤/);
});

test('old and streaming transcripts pair out-of-order results, keep visible images and deduplicate sources across prose boundaries', () => {
  const fetch = (id, url) => tool(id, 'web_fetch', { url }).call;
  const incoming = [
    { role: 'user', content: [text('question')] },
    { role: 'assistant', content: [text('intro'), thinking('t', 'read').block, fetch('a', 'https://example.org/a'), fetch('b', 'https://example.org/b')] },
    { ...result('page b'), toolCallId: 'b' },
    { ...result('page a'), toolCallId: 'a' },
    { role: 'assistant', content: [text('progress'), tool('img', 'generate_image').call, tool('pending', 'subagent', { name: 'worker' }).call] },
    { role: 'toolResult', toolCallId: 'img', content: [{ type: 'image', mimeType: 'image/png', data: 'AAA' }] },
    { role: 'assistant', content: [text('final answer')] },
  ];
  const { turns, results } = content.groupTranscript(incoming);
  assert.equal(turns.length, 2);
  const model = content.buildTurnContent(turns[1].messages, results, true);
  assert.deepEqual(model.segments.map(x => x.kind), ['text', 'activity', 'text', 'activity', 'tool-images', 'activity', 'text']);
  assert.equal(model.segments[1].entries.length, 3);
  assert.equal(model.segments[4].images[0].src, 'data:image/png;base64,AAA');
  assert.equal(model.segments[5].entries[0].live, true);
  assert.equal(model.answerText, 'final answer');
  assert.deepEqual(model.sources.map(s => s.href), ['https://example.org/a']);
});
