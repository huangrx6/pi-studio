import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';
import vm from 'node:vm';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';

const require = createRequire(import.meta.url);
function compile(relative, imports = {}) {
  const context = { exports: {}, require: id => id.endsWith('.css') ? {} : imports[id] ?? require(id) };
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(new URL(relative, import.meta.url), 'utf8'), {
    compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, context);
  return context.exports;
}

const { NewConversationWelcome, resolveWelcomeGreeting } = compile('../../web/src/features/conversation/NewConversationWelcome.tsx', {
  '../../shared/LoadingState': compile('../../web/src/shared/LoadingState.tsx'),
});
const render = overrides => renderToStaticMarkup(React.createElement(NewConversationWelcome, {
  loading: false,
  ...overrides,
}));

test('idle welcome shows only the time-of-day greeting', () => {
  const html = render({ now: new Date(2026, 10, 25, 23, 15, 0) });
  assert.match(html, /<h1>夜深了，记得早点休息<\/h1>/);
  assert.equal(html.replace(/<[^>]+>/g, ''), '夜深了，记得早点休息');
  assert.match(html, /class="welcome-art" aria-hidden="true"/);
  assert.doesNotMatch(html, /new-conversation-lede|new-conversation-suggestion|任务示例/);
  assert.doesNotMatch(html, /选择工作区|配置模型|new-conversation-setup/);
});

test('welcome greeting adapts across morning, midday, afternoon, evening and late night', () => {
  assert.equal(resolveWelcomeGreeting(new Date(2026, 10, 25, 7, 0)), '早安，今天从哪件事开始？');
  assert.equal(resolveWelcomeGreeting(new Date(2026, 10, 25, 10, 30)), '上午好，准备推进哪件事？');
  assert.equal(resolveWelcomeGreeting(new Date(2026, 10, 25, 12, 45)), '午间小憩，也可以随手记下想法');
  assert.equal(resolveWelcomeGreeting(new Date(2026, 10, 25, 15, 20)), '下午好，手头的事随时交给我');
  assert.equal(resolveWelcomeGreeting(new Date(2026, 10, 25, 20, 0)), '晚上好，还有什么需要收尾？');
  assert.equal(resolveWelcomeGreeting(new Date(2026, 10, 25, 1, 30)), '夜深了，记得早点休息');
});

test('loading adds a quiet status line without bringing back the old blocks', () => {
  const html = render({ loading: true, now: new Date(2026, 10, 25, 10, 0) });
  assert.match(html, /正在载入…/);
  assert.match(html, /role="status"/);
  assert.doesNotMatch(html, /new-conversation-lede|new-conversation-suggestion/);
});
