import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';
import vm from 'node:vm';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';

// Exercise the real disclosure components without a DOM or a CSS loader.
// Only their visual leaves are substituted; hooks and server rendering are React's.
// Browser QA separately covers toggling, persistent state, focus, and live scrolling.
const require = createRequire(import.meta.url);
const source = fs.readFileSync(new URL('../../web/src/features/conversation/ChatMessage.tsx', import.meta.url), 'utf8');
const ast = ts.createSourceFile('ChatMessage.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const names = ['textBlocks', 'imagesFromBlocks', 'toolSummary', 'ActivityTool', 'ActivityThinking', 'TurnTrace'];
const declarations = ast.statements
  .filter(node => ts.isFunctionDeclaration(node) && names.includes(node.name?.text))
  .map(node => node.getText(ast)).join('\n');
const compiled = ts.transpileModule(`${declarations}\nexport { ActivityTool, ActivityThinking, TurnTrace };`, {
  compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;

function fixture() {
  const metrics = { markdown: 0 };
  const context = {
    exports: {}, require, ...React,
    Markdown: ({ children }) => { metrics.markdown++; return React.createElement('p', null, children); },
    ToolResultImages: () => React.createElement('div', { className: 'tool-result-images' }),
  };
  for (const name of ['ToolIcon', 'ChevronDown', 'CircleAlert', 'CircleX', 'LoaderCircle', 'Sparkles']) context[name] = () => null;
  vm.runInNewContext(compiled, context);
  return { ...context.exports, metrics };
}
const render = (Component, props, child) => renderToStaticMarkup(React.createElement(Component, props, child));

test('closed tool details do not serialize parameters or concatenate the output; images stay independent', () => {
  const { ActivityTool } = fixture();
  let serializations = 0;
  let outputReads = 0;
  const call = { id: 'call', name: 'custom', arguments: { toJSON() { serializations++; return { payload: 'full arguments' }; } } };
  const result = { content: [
    { type: 'text', get text() { outputReads++; return 'full output'; } },
    { type: 'image', mimeType: 'image/png', data: 'test' },
  ] };
  const closed = render(ActivityTool, { call, result, busy: false });
  assert.equal(serializations, 0);
  assert.equal(outputReads, 0);
  assert.ok(!closed.includes('activity-tool-body'));
  assert.ok(closed.includes('tool-result-images'));
  assert.ok(closed.includes('aria-description="已完成"'));
  const expanded = render(ActivityTool, { call, result, busy: false, defaultOpen: true });
  assert.equal(serializations, 1);
  assert.equal(outputReads, 1);
  assert.ok(expanded.includes('full arguments') && expanded.includes('full output'));
});

test('failure, active work, and incomplete tools remain identifiable with details closed', () => {
  const { ActivityTool } = fixture();
  const call = { id: 'call', name: 'read', arguments: { path: 'src/file.ts' } };
  assert.match(render(ActivityTool, { call, result: { isError: true, content: [] }, busy: false }), /失败/);
  assert.match(render(ActivityTool, { call, busy: true }), /执行中/);
  assert.match(render(ActivityTool, { call, busy: false }), /未完成/);
});

test('completed thinking parses Markdown only when expanded; redacted content stays hidden', () => {
  const { ActivityThinking, metrics } = fixture();
  const block = { type: 'thinking', thinking: 'full thinking' };
  const closed = render(ActivityThinking, { block });
  assert.equal(metrics.markdown, 0);
  assert.match(closed, /activity-thinking-preview/);
  const expanded = render(ActivityThinking, { block, defaultOpen: true });
  assert.match(expanded, /activity-thinking-body/);
  assert.doesNotMatch(expanded, /activity-thinking-preview/, 'expanded content replaces the duplicate summary preview');
  assert.equal(metrics.markdown, 1);
  const redacted = render(ActivityThinking, { block: { ...block, redacted: true }, defaultOpen: true });
  assert.equal(metrics.markdown, 1);
  assert.ok(!redacted.includes('full thinking'));
});

test('historical traces defer child rendering while keeping errors discoverable; open policies render children', () => {
  const { TurnTrace } = fixture();
  let childRenders = 0;
  const Child = () => { childRenders++; return React.createElement('pre', null, 'large trace'); };
  const props = { live: false, active: false, policy: 'after-answer', phase: '', steps: 1, requests: 0, errors: 1 };
  const closed = render(TurnTrace, props, React.createElement(Child));
  assert.equal(childRenders, 0);
  assert.match(closed, /次异常/);
  assert.match(closed, /aria-expanded="false"/);
  for (const override of [{ policy: 'keep-open' }, { policy: 'manual' }, { live: true, active: true }]) {
    assert.match(render(TurnTrace, { ...props, ...override }, React.createElement(Child)), /large trace/);
  }
  assert.equal(childRenders, 3);
});
