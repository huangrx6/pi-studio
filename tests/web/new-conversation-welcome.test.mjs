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

const icon = name => props => React.createElement('svg', { ...props, 'data-icon': name });
const { NewConversationWelcome } = compile('../../web/src/features/conversation/NewConversationWelcome.tsx', {
  'lucide-react': { FolderOpen: icon('folder'), SlidersHorizontal: icon('settings') },
});
const render = overrides => renderToStaticMarkup(React.createElement(NewConversationWelcome, {
  hasWorkspace: false,
  loading: false,
  hasModel: false,
  hasDraft: false,
  onConfigureModel() {},
  onChooseWorkspace() {},
  onSelectPrompt() {},
  ...overrides,
}));

test('missing workspace and model render one primary setup path without task examples', () => {
  const html = render();
  assert.match(html, /<button type="button" class="new-conversation-setup-action is-primary">[\s\S]*选择工作区<\/button>/);
  assert.match(html, /new-conversation-model-warning[^>]*>[\s\S]*配置模型<\/button>/);
  assert.match(html, /data-icon="folder"/);
  assert.match(html, /data-icon="settings"/);
  assert.doesNotMatch(html, /任务示例|new-conversation-suggestion/);
});

test('setup actions and examples disappear once prerequisites and a draft exist', () => {
  const html = render({ hasWorkspace: true, hasModel: true, hasDraft: true });
  assert.doesNotMatch(html, /new-conversation-setup|选择工作区|配置模型/);
  assert.doesNotMatch(html, /任务示例/);
});

test('task examples wait for a workspace and remain useful until a model is configured', () => {
  assert.doesNotMatch(render({ hasWorkspace: false, hasModel: true }), /任务示例|new-conversation-suggestion/);
  assert.match(render({ hasWorkspace: true, hasModel: false }), /任务示例/);
  assert.match(render({ hasWorkspace: true, hasModel: true }), /任务示例/);
});
