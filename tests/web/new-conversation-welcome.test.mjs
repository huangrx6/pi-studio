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

const { NewConversationWelcome } = compile('../../web/src/features/conversation/NewConversationWelcome.tsx');
const render = overrides => renderToStaticMarkup(React.createElement(NewConversationWelcome, {
  loading: false,
  ...overrides,
}));

test('the welcome state is one line and one sentence', () => {
  const html = render();
  assert.match(html, /new-conversation-rule/);
  assert.match(html, /今天想做点什么？/);
  // 说明文字与任务示例都已移除：工作区与模型的入口在输入框里。
  assert.doesNotMatch(html, /new-conversation-lede|new-conversation-suggestion|任务示例/);
  assert.doesNotMatch(html, /选择工作区|配置模型|new-conversation-setup/);
});

test('loading adds a quiet status line without bringing back the old blocks', () => {
  const html = render({ loading: true });
  assert.match(html, /正在载入…/);
  assert.doesNotMatch(html, /new-conversation-lede|new-conversation-suggestion/);
});
